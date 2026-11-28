// The picture that stands behind her in the room (`[modules.api.room] backdrop`): one image file the
// owner chose, served as it is to a member's session under `/api/member/room/backdrop/`. Nothing is
// made of it (no resizing, no re-encoding); it is named by its content's hash, so the browser keeps
// it a year and a replaced picture is a new name the room's state hands out.
//
// The file is read whole into memory (it is capped, below) so the name and the bytes served under
// it can never disagree, and looked at again at most once a minute, so a replaced picture is picked
// up without a restart. A file that is missing, is not a regular file, is not one of the image kinds
// or is too large is no picture at all: the page draws its own backdrop, and the log says why once.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { ROOM_BACKDROP_PATH } from "@miyoria/contracts/api";
import { ApiError } from "../errors.js";
import type { RoomConfig } from "./config.js";
import { FIGURE_IMMUTABLE, type FigureLog } from "./figure.js";

/** The largest picture served: a full-screen photograph, not a video frame dump. */
export const BACKDROP_MAX_BYTES = 12 * 1024 * 1024;
/** How often the source file is looked at again. */
export const BACKDROP_RECHECK_MS = 60_000;

const TYPES: Record<string, string> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".avif": "image/avif",
};

export interface BackdropOptions {
  /** The picture, absolute; empty: none set. */
  path: string;
  log: FigureLog;
  /** The clock for the re-check (tests move it). */
  now?: () => number;
  /** How long a look at the file is trusted, in milliseconds. */
  recheckMs?: number;
}

interface Ready {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** The backdrop's file from the room's config, relative to the Core's working folder like `figure_cache`. */
export function backdropPath(config: Pick<RoomConfig, "backdrop">, cwd = process.cwd()): string {
  return config.backdrop === "" ? "" : resolve(cwd, config.backdrop);
}

export class RoomBackdrop {
  readonly #o: BackdropOptions;
  readonly #now: () => number;
  readonly #every: number;
  #ready: Ready | null = null;
  #stamp = "";
  #checkedAt = Number.NEGATIVE_INFINITY;
  #working: Promise<void> | null = null;
  #said = "";

  constructor(options: BackdropOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#every = options.recheckMs ?? BACKDROP_RECHECK_MS;
  }

  /** Looks at the file now (again); resolves when done, never rejects. */
  prepare(): Promise<void> {
    if (this.#working !== null) return this.#working;
    const work = this.#load().finally(() => {
      this.#checkedAt = this.#now();
      this.#working = null;
    });
    this.#working = work;
    return work;
  }

  /** The room state's `backdrop`: the picture's URL, or `null` (the page's own backdrop). */
  state(): { image: string } | null {
    this.#recheck();
    const r = this.#ready;
    return r === null ? null : { image: `${ROOM_BACKDROP_PATH}/${r.name}` };
  }

  /** `GET /api/member/room/backdrop/{name}`: the picture under its current name, or a 404. */
  file(name: string): Response {
    this.#recheck();
    const r = this.#ready;
    if (r === null || r.name !== name) throw ApiError.notFound("no such file");
    return new Response(r.bytes as unknown as ArrayBuffer, {
      status: 200,
      headers: {
        "content-type": r.type,
        "content-length": String(r.bytes.byteLength),
        "cache-control": FIGURE_IMMUTABLE,
        "x-content-type-options": "nosniff",
      },
    });
  }

  async #load(): Promise<void> {
    const path = this.#o.path;
    if (path === "") {
      this.#ready = null;
      this.#stamp = "";
      return;
    }
    try {
      const info = await stat(path).catch(() => null);
      this.#stamp = info === null ? "-" : `${info.size}:${info.mtimeMs}`;
      const ext = extname(path).toLowerCase();
      if (info === null) return this.#none(`the backdrop ${path} does not exist`);
      if (!info.isFile()) return this.#none(`the backdrop ${path} is not a file`);
      const type = TYPES[ext];
      if (type === undefined)
        return this.#none(`the backdrop ${path} is not .webp, .png, .jpg, .jpeg or .avif`);
      if (info.size > BACKDROP_MAX_BYTES)
        return this.#none(`the backdrop ${path} is larger than 12 MB`);
      const bytes = await readFile(path);
      // It may have grown between the look and the read.
      if (bytes.byteLength > BACKDROP_MAX_BYTES)
        return this.#none(`the backdrop ${path} is larger than 12 MB`);
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 20);
      const name = `backdrop-${hash}${ext}`;
      this.#ready = { name, type, bytes };
      this.#say("info", `her room has a backdrop picture (${name})`, {});
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.#none(`the backdrop ${path} cannot be read: ${why}`);
    }
  }

  #none(why: string): void {
    this.#ready = null;
    this.#say("warn", `the room draws its own backdrop: ${why}`, {});
  }

  /** The source changed since it was read (at most once a minute): read it again. */
  #recheck(): void {
    if (this.#o.path === "" || this.#working !== null) return;
    const now = this.#now();
    if (now - this.#checkedAt < this.#every) return;
    this.#checkedAt = now;
    void stat(this.#o.path)
      .then((s) => `${s.size}:${s.mtimeMs}`)
      .catch(() => "-")
      .then((stamp) => (stamp !== this.#stamp ? this.prepare() : undefined))
      .catch(() => undefined);
  }

  /** Says the backdrop's state, once per change of what is said. */
  #say(level: "info" | "warn", msg: string, extra: object): void {
    if (this.#said === msg) return;
    this.#said = msg;
    this.#o.log[level](extra, msg);
  }
}
