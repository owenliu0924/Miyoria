// What people attached to their messages, as selfhost saw it, so `workspace_attach` can put a file
// where the shell can see it (docs/design/v6-sandbox.md §11.1). The run's own file reading
// (`around.ts`) picks what to read as text; this keeps the plain list, images and every type
// included, for a short while. Nothing is kept past `KEEP_MS` or the 256th message.

import {
  accountRefString,
  contextKeyString,
  type FileRequest,
  type IncomingMessage,
  type MessageFiles,
  type MessageRef,
} from "@miyoria/types";

export const MAX_MESSAGES = 256;
export const KEEP_MS = 30 * 60_000;
const DEFAULT_WITHIN_MS = 10 * 60_000;

interface Seen {
  place: string;
  id: string;
  who: string;
  at: number;
  files: FileRequest[];
}

export class MessageFilesBook implements MessageFiles {
  readonly #seen = new Map<string, Seen>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Notes a message and what it carried. Messages from bots are not kept. */
  record(message: IncomingMessage): void {
    if (message.author.is_bot) return;
    const who = accountRefString(message.author.account);
    const place = contextKeyString(message.id.context);
    const files: FileRequest[] = [
      ...message.attachments,
      ...(message.forwarded ?? []).flatMap((f) => f.attachments),
    ].map((a) => ({ who, name: a.filename, url: a.url, size: a.size ?? null, id: a.id ?? null }));
    const parsed = Date.parse(message.ts);
    const at = Number.isFinite(parsed) ? parsed : this.#now();
    const key = `${place}\n${message.id.id}`;
    this.#seen.delete(key);
    this.#seen.set(key, { place, id: message.id.id, who, at, files });
    this.#trim();
  }

  #trim(): void {
    const oldest = this.#now() - KEEP_MS;
    for (const [key, seen] of this.#seen) {
      if (seen.at < oldest || this.#seen.size > MAX_MESSAGES) this.#seen.delete(key);
    }
  }

  filesOf(message: MessageRef, options: { withinMs?: number } = {}): FileRequest[] {
    this.#trim();
    const anchor = this.#seen.get(`${contextKeyString(message.context)}\n${message.id}`);
    if (anchor === undefined) return [];
    const within = options.withinMs ?? DEFAULT_WITHIN_MS;
    const found = [...this.#seen.values()]
      .filter(
        (s) =>
          s.place === anchor.place &&
          s.who === anchor.who &&
          s.at <= anchor.at &&
          s.at >= anchor.at - within,
      )
      // The anchor first even when a neighbour has the same time.
      .sort((a, b) => b.at - a.at || Number(b === anchor) - Number(a === anchor));
    const out: FileRequest[] = [];
    const urls = new Set<string>();
    for (const s of found) {
      for (const f of s.files) {
        const key = f.id !== null ? `id:${f.id}` : `url:${f.url.split("?")[0]}`;
        if (urls.has(key)) continue;
        urls.add(key);
        out.push(f);
      }
    }
    return out;
  }
}

/**
 * Notes the messages a run is for. `around.ts` calls it before it picks files, so the list is
 * there when the model asks for `workspace_attach`.
 */
export function recordRunFiles(book: MessageFilesBook, inputs: readonly IncomingMessage[]): void {
  for (const input of inputs) book.record(input);
}
