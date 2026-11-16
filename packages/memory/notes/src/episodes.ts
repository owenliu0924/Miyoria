// Where the segment pass puts what is not a document line: the episode (L2) and the follow-ups.
//
// Until L2 is rebuilt on its own table, both go to today's `memory_records` through the memory
// engine's public write (`MemoryEngine.store`), with the scope translated to the old vocabulary
// (`toMemoryScope`), so recall keeps finding them. A scope the resolver cannot translate is not
// widened: the item is not stored.

import type { MemoryScope } from "@miyoria/store";
import type { ContextKey, PersonId, Timestamp } from "@miyoria/types";
import type { NewMemory, Stored } from "../../memory/src/engine.js";
import { LINE_REF_PREFIX } from "../../memory/src/evidence.js";
import { type NoteScope, type ScopeResolver, toMemoryScope } from "./scope.js";

/** One episode of a segment: what happened, who was there, how she felt. */
export interface SegmentEpisode {
  summary: string;
  /** Her feeling in a few words; `null`: none given. */
  feeling: string | null;
  /** 0..1 */
  importance: number;
  people: PersonId[];
  /** Where it may be recalled: the place's scope. */
  scope: NoteScope;
  session: string;
  seq_from: number;
  seq_to: number;
  /** The platform ids of the messages of the segment. */
  message_ids: string[];
  at: Timestamp;
}

/** Something to bring up later. */
export interface SegmentFollowup {
  about: string;
  /** Whom it is about; `null`: nobody in particular. */
  person: PersonId | null;
  due: Timestamp;
  scope: NoteScope;
  session: string;
  at: Timestamp;
}

/** Where the pass hands episodes and follow-ups. Each returns the id stored, `null`: not stored. */
export interface EpisodeSink {
  episode(episode: SegmentEpisode, signal?: AbortSignal): Promise<string | null>;
  followup?(followup: SegmentFollowup, signal?: AbortSignal): Promise<string | null>;
}

/** What the adapter needs of the memory engine: its one public write. */
export interface MemoryWriter {
  store(memory: NewMemory, now: Timestamp, signal?: AbortSignal): Promise<Stored>;
}

export interface MemorySinkOptions {
  resolver: ScopeResolver;
  /** The platform a DM scope's account is looked up on. */
  platform?: string;
  /** The context written as `source_context`, by session; `null`: none known. */
  contextOf?: (session: string) => ContextKey | null;
}

const idOf = (stored: Stored): string | null =>
  stored.type === "refused" ? null : stored.type === "superseded" ? stored.new : stored.id;

/** The episode as today's episodes read: the summary, then her feeling. */
export function episodeText(episode: Pick<SegmentEpisode, "summary" | "feeling">): string {
  const feeling = episode.feeling?.trim() ?? "";
  return feeling === "" ? episode.summary : `${episode.summary}(當時我的心情:${feeling})`;
}

/**
 * An `EpisodeSink` over the memory engine: an episode is a `memory_records` row of kind `episode`
 * (origin `experienced`, its evidence the segment's messages), a follow-up one of kind
 * `followup` with its due time.
 */
export function memoryEpisodeSink(writer: MemoryWriter, options: MemorySinkOptions): EpisodeSink {
  const scopeOf = (scope: NoteScope): MemoryScope | null =>
    toMemoryScope(scope, options.resolver, options.platform);
  const context = (session: string) => options.contextOf?.(session) ?? null;
  return {
    async episode(episode, signal) {
      const scope = scopeOf(episode.scope);
      if (scope === null) return null;
      const stored = await writer.store(
        {
          kind: "episode",
          scope,
          subjects: [...episode.people],
          content: episodeText(episode),
          importance: episode.importance,
          confidence: 1,
          source_context: context(episode.session),
          due: null,
          origin: "experienced",
          source_events: episode.message_ids.map((id) => `${LINE_REF_PREFIX}${id}`),
        },
        episode.at,
        signal,
      );
      return idOf(stored);
    },
    async followup(followup, signal) {
      const scope = scopeOf(followup.scope);
      if (scope === null) return null;
      const stored = await writer.store(
        {
          kind: "followup",
          scope,
          subjects: followup.person === null ? [] : [followup.person],
          content: followup.about,
          importance: 0.5,
          confidence: 1,
          source_context: context(followup.session),
          due: followup.due,
          origin: "experienced",
        },
        followup.at,
        signal,
      );
      return idOf(stored);
    },
  };
}
