// The tools a session has found so far. A turn offers the always-on tools and then these, in
// this order: a name is only ever added at the end and never moved, so the tool list of a session
// keeps its prefix (and the provider's prefix cache keeps hitting). The one exception is
// `retain`, right after the session's transcript was compacted: the cache starts over then
// anyway, and without it a long-lived place would carry every tool it ever found.

import { z } from "zod";

/** `LoadedTools` as JSON: session id to its names, in the order they were loaded. */
export const LoadedToolsSchema = z.record(z.string(), z.array(z.string()));
export type LoadedToolsJson = z.output<typeof LoadedToolsSchema>;

export class LoadedTools {
  readonly #sessions = new Map<string, string[]>();

  /** The names loaded in `session`, oldest first. */
  loaded(session: string): readonly string[] {
    return this.#sessions.get(session) ?? [];
  }

  /** Adds `names` at the end of `session`'s list, skipping what it has; returns the new ones. */
  load(session: string, names: readonly string[]): string[] {
    const list = this.#sessions.get(session) ?? [];
    const added: string[] = [];
    for (const name of names) {
      if (list.includes(name)) continue;
      list.push(name);
      added.push(name);
    }
    if (added.length > 0) this.#sessions.set(session, list);
    return added;
  }

  /**
   * Keeps of `session`'s list only the names in `names`, in the order they were loaded; returns
   * the ones dropped. Only for right after a compaction (see above).
   */
  retain(session: string, names: Iterable<string>): string[] {
    const list = this.#sessions.get(session);
    if (list === undefined) return [];
    const keep = new Set(names);
    const kept = list.filter((n) => keep.has(n));
    const dropped = list.filter((n) => !keep.has(n));
    if (kept.length === 0) this.#sessions.delete(session);
    else this.#sessions.set(session, kept);
    return dropped;
  }

  /** Forgets a session that ended; while it lives, only `retain` takes names off its list. */
  end(session: string): void {
    this.#sessions.delete(session);
  }

  toJSON(): LoadedToolsJson {
    return Object.fromEntries([...this.#sessions].map(([session, names]) => [session, [...names]]));
  }

  /** The lists `toJSON` wrote. Throws a `ZodError` for anything else. */
  static parse(value: unknown): LoadedTools {
    const loaded = new LoadedTools();
    for (const [session, names] of Object.entries(LoadedToolsSchema.parse(value))) {
      loaded.load(session, names);
    }
    return loaded;
  }
}
