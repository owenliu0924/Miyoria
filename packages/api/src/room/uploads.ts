// What people attach in her room (docs/design/her-room.md §3.3): the bytes stay in memory, never on
// disk, and are never served back to anyone (the page shows its own blob). A file has an
// `https://uploads.room.invalid/<id>` URL on the line it is sent with; the downloaders (the image
// loader, the file reader, `workspace_attach`) hand that URL to this service (`IncomingFilesKey`)
// instead of the network, and `.invalid` never resolves, so a downloader that forgot still reaches
// nothing outside.
//
// An upload not sent is dropped after `UNSENT_MS`; a sent one is kept `SENT_MS` more (what the
// message files book keeps for `workspace_attach` to look back), then dropped.

import { randomBytes } from "node:crypto";
import type { RoomUpload } from "@miyoria/contracts/api";
import {
  type AccountRef,
  accountRefString,
  INCOMING_FILE_HOST,
  type IncomingFiles,
  isIncomingFileUrl,
  sniffImage,
  toTimestamp,
} from "@miyoria/types";
import { inboxName } from "@miyoria/workspace/sandbox";

/** An upload not sent within this is dropped. */
export const UNSENT_MS = 30 * 60_000;
/** A sent upload is kept this long after (`MessageFilesBook`'s `KEEP_MS`). */
export const SENT_MS = 30 * 60_000;

interface Held {
  id: string;
  owner: string;
  name: string;
  /** The sniffed image type, else the type the browser said (only a hint), else none. */
  type: string;
  kind: "image" | "file";
  bytes: Uint8Array;
  expiresAt: number;
  sent: boolean;
}

/** Why an upload was not kept. */
export type UploadRefusal = "full";

/** An upload taken by a line: what the line's attachment says of it. */
export interface TakenUpload {
  id: string;
  url: string;
  name: string;
  type: string;
  kind: "image" | "file";
  size: number;
}

/** The URL a line carries for upload `id`. */
export function uploadUrl(id: string): string {
  return `https://${INCOMING_FILE_HOST}/${id}`;
}

/** The upload id of a room URL, `null` for anything else. */
export function uploadIdOf(url: string): string | null {
  if (!isIncomingFileUrl(url)) return null;
  const parsed = new URL(url);
  if (parsed.search !== "" || parsed.hash !== "") return null;
  const id = parsed.pathname.slice(1);
  return /^up_[A-Za-z0-9_-]{22}$/.test(id) ? id : null;
}

/** What a member called the file, as one safe segment (`workspace_attach`'s rule). */
export function uploadName(raw: string | undefined): string {
  let name = "";
  try {
    name = decodeURIComponent(raw ?? "");
  } catch {
    name = "";
  }
  return inboxName(name.slice(0, 400));
}

export class RoomUploads implements IncomingFiles {
  readonly #held = new Map<string, Held>();
  #total = 0;

  constructor(
    private readonly now: () => number,
    /** Everything held together may not pass this (bytes). */
    private readonly poolBytes: number,
    private readonly random: (n: number) => Uint8Array = (n) => randomBytes(n),
  ) {}

  /** Bytes held now. */
  get total(): number {
    this.sweep();
    return this.#total;
  }

  /** Keeps `bytes` for `account`, or says why not. */
  put(
    account: AccountRef,
    rawName: string | undefined,
    hint: string | undefined,
    bytes: Uint8Array,
  ): RoomUpload | UploadRefusal {
    this.sweep();
    if (this.#total + bytes.byteLength > this.poolBytes) return "full";
    const sniffed = sniffImage(bytes);
    const declared = (hint ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const id = `up_${Buffer.from(this.random(16)).toString("base64url")}`;
    const held: Held = {
      id,
      owner: accountRefString(account),
      name: uploadName(rawName),
      // A file is never served as an image unless its bytes are one.
      type: sniffed ?? (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(declared) ? declared : ""),
      kind: sniffed === null ? "file" : "image",
      bytes,
      expiresAt: this.now() + UNSENT_MS,
      sent: false,
    };
    this.#held.set(id, held);
    this.#total += bytes.byteLength;
    return {
      id,
      name: held.name,
      size: bytes.byteLength,
      kind: held.kind,
      expires_at: toTimestamp(held.expiresAt),
    };
  }

  /**
   * The uploads `ids` of `account`, marked sent; `null` when one is not theirs, is gone, or was
   * sent already (each upload goes with one line).
   */
  take(account: AccountRef, ids: readonly string[]): TakenUpload[] | null {
    this.sweep();
    const owner = accountRefString(account);
    const found: Held[] = [];
    for (const id of new Set(ids)) {
      const held = this.#held.get(id);
      if (held === undefined || held.owner !== owner || held.sent) return null;
      found.push(held);
    }
    const now = this.now();
    return found.map((held) => {
      held.sent = true;
      held.expiresAt = now + SENT_MS;
      return {
        id: held.id,
        url: uploadUrl(held.id),
        name: held.name,
        type: held.type,
        kind: held.kind,
        size: held.bytes.byteLength,
      };
    });
  }

  /** Drops what has expired. */
  sweep(): void {
    const now = this.now();
    for (const [id, held] of this.#held) {
      if (held.expiresAt > now) continue;
      this.#held.delete(id);
      this.#total -= held.bytes.byteLength;
    }
  }

  handles(url: string): boolean {
    const id = uploadIdOf(url);
    if (id === null) return false;
    this.sweep();
    return this.#held.get(id)?.sent === true;
  }

  async fetch(url: string, init: { signal: AbortSignal; redirect: "error" }): Promise<Response> {
    init.signal.throwIfAborted();
    const id = uploadIdOf(url);
    this.sweep();
    const held = id === null ? undefined : this.#held.get(id);
    // Only what went out on a line: an upload nobody sent is nobody's file yet.
    if (held === undefined || !held.sent) return new Response(null, { status: 404 });
    const headers: Record<string, string> = { "content-length": String(held.bytes.byteLength) };
    if (held.type !== "") headers["content-type"] = held.type;
    return new Response(held.bytes.slice(), { status: 200, headers });
  }

  /** Drops everything (the module stops). */
  clear(): void {
    this.#held.clear();
    this.#total = 0;
  }
}
