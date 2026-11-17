// Module `heart`: the owner of `heart_person` (docs/design/v5-heart.md §2.9). It puts the rules of
// its config section (`[modules.heart]`, `HeartPersonConfigSchema` and the job's own key) in force,
// moves the old records over once (owner decision H8), runs the daily pass, and provides
// `HeartKey` for everyone else: the host applies her `feel` through it, `social` tells it who said
// a line, the prompt and her initiative read it.
//
// Config changes reach it the way they reach every module: the supervisor restarts it, and `start`
// puts the section's rules in force again (`setRules`).

import {
  defineManifest,
  errorMessage,
  interval,
  type Logger,
  type Module,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import {
  type Relationship,
  type RelationshipDelta,
  type SettingsStore,
  StoreKey,
} from "@miyoria/store";
import {
  type Clock,
  type FeelProposal,
  HeartKey,
  type HeartLine,
  type HeartPeople,
  type HeartView,
  type JsonValue,
  type PersonId,
  type ProfileId,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import { FeelingsBook } from "../../self/src/feelings.js";
import { HeartPersonConfigSchema } from "./config.js";
import type { LegacyResult } from "./legacy.js";
import { BLOCKED_TAG, type HeartPerson, hasTag, isProposalField, OWNER_TAG } from "./model.js";
import { CARES_THRESHOLD, cares, type HeartChangeRequest } from "./rules.js";
import { type HeartStore, heartTables } from "./store.js";

/** `[modules.heart]`: the rules of `heart_person`, and how often the daily pass looks. */
export const HeartConfigSchema = HeartPersonConfigSchema.extend({
  /**
   * How often (minutes) the daily pass looks for people whose local day it has not run for yet.
   * It runs once per person and local day however often it looks.
   */
  decay_check_mins: z.number().int().positive().default(10),
});

export type HeartConfig = z.output<typeof HeartConfigSchema>;

/** Settings key that records the migration ran (owner decision H8): it never runs twice. */
export const MIGRATED_KEY = "heart:migrated";
/** Where `self` keeps its state (`SelfModule`'s `STATE_KEY`), with the old `hearts`. */
const SELF_STATE_KEY = "self:state";
/** The feeling cards are read whole (the book only cuts what it writes). */
const CARD_CHARS = 100_000;
/** At most this many people are looked through for the one she cares about most. */
const MOST_CARED_POOL = 200;

/** A row as its readers see it. */
export function viewOf(p: HeartPerson): HeartView {
  return {
    person: p.person_id,
    bond: p.bond,
    trust: p.trust,
    familiarity: p.familiarity,
    warmth: p.warmth,
    respect: p.respect,
    ease: p.ease,
    grudge: p.grudge,
    longing: p.longing,
    rapport: p.rapport,
    stance: p.stance,
    impression: p.impression,
    call_name: p.call_name,
    tags: [...p.tags],
    owner: hasTag(p, OWNER_TAG),
    blocked: hasTag(p, BLOCKED_TAG),
    last_seen: p.last_seen,
    last_together: p.last_together,
  };
}

/** `HeartKey`: the store's rows, read and moved by the rules. */
export class HeartService implements HeartPeople {
  readonly #people: HeartStore;
  readonly #clock: Clock;

  constructor(people: HeartStore, clock: Clock) {
    this.#people = people;
    this.#clock = clock;
  }

  feel(
    person: PersonId,
    proposals: readonly FeelProposal[],
    options: { turn: string | null; now?: number },
  ): number {
    const row = this.#people.get(person);
    if (row !== null && hasTag(row, BLOCKED_TAG)) return 0;
    const requests: HeartChangeRequest[] = [];
    for (const p of proposals) {
      if (!isProposalField(p.field)) continue;
      requests.push({ type: "propose", field: p.field, direction: p.direction, quote: p.quote });
    }
    if (requests.length === 0) return 0;
    return this.#people.applyAll(person, requests, {
      now: options.now ?? this.#clock.now(),
      turn: options.turn,
    }).length;
  }

  seen(person: PersonId, line: HeartLine): void {
    this.#people.seen(person, line);
  }

  view(person: PersonId): HeartView | null {
    const row = this.#people.get(person);
    return row === null ? null : viewOf(row);
  }

  cares(person: PersonId): number {
    const row = this.#people.get(person);
    return row === null || hasTag(row, BLOCKED_TAG) ? 0 : cares(row);
  }

  mostCared(among?: readonly PersonId[]): { person: PersonId; cares: number } | null {
    if (among === undefined) return this.#cared()[0] ?? null;
    return rank(among.flatMap((p) => this.#people.get(p) ?? []))[0] ?? null;
  }

  caredAbout(max: number): { person: PersonId; cares: number }[] {
    return this.#cared().slice(0, Math.max(0, max));
  }

  /**
   * Everyone she cares about, most first, read again at most every `CARED_TTL_MS`: her emotions
   * ask on every event, and who she cares about moves by the day.
   */
  #cared(): { person: PersonId; cares: number }[] {
    const now = this.#clock.now();
    if (this.#caredCache !== null && now - this.#caredCache.at < CARED_TTL_MS) {
      return this.#caredCache.list;
    }
    const list = rank(this.#people.list({ limit: MOST_CARED_POOL }).entries.map((e) => e.person));
    this.#caredCache = { at: now, list };
    return list;
  }

  #caredCache: { at: number; list: { person: PersonId; cares: number }[] } | null = null;
}

/** How long the list of people she cares about is kept before it is read again. */
const CARED_TTL_MS = 60_000;

/** The rows at or above the threshold, as `{person, cares}`, most first (blocked never). */
function rank(rows: readonly HeartPerson[]): { person: PersonId; cares: number }[] {
  const out: { person: PersonId; cares: number }[] = [];
  for (const row of rows) {
    if (hasTag(row, BLOCKED_TAG)) continue;
    const c = cares(row);
    if (c >= CARES_THRESHOLD) out.push({ person: row.person_id, cares: c });
  }
  return out.sort((a, b) => b.cares - a.cares || (a.person < b.person ? -1 : 1));
}

/** What the migration on start reads and writes through. */
export interface MigrationDeps {
  people: HeartStore;
  settings: SettingsStore;
  relationships: {
    list(profile: ProfileId): Promise<Relationship[]>;
    deltasSince(profile: ProfileId, person: PersonId, since: string): Promise<RelationshipDelta[]>;
  };
  profile: ProfileId;
  now: number;
  log: Pick<Logger, "info">;
}

/**
 * The migration from the old records (H8), once: only when it never ran (`MIGRATED_KEY`) and
 * `heart_person` is still empty. Whatever happens, the key is set after, so it never runs again
 * (a table emptied later, by forgetting everyone, is not filled from the old records once more).
 * One log line with the counts. The result; `null` when it did not run.
 */
export async function migrateOnStart(d: MigrationDeps): Promise<LegacyResult | null> {
  if ((await d.settings.get(d.profile, MIGRATED_KEY)) !== null) return null;
  const at = toTimestamp(d.now);
  if (d.people.list({ limit: 1 }).total > 0) {
    await d.settings.set(d.profile, MIGRATED_KEY, { at, rows: 0, skipped: "rows already there" });
    return null;
  }
  const relationships = await d.relationships.list(d.profile);
  const deltas = new Map<PersonId, RelationshipDelta[]>();
  for (const r of relationships) {
    deltas.set(r.person, await d.relationships.deltasSince(d.profile, r.person, toTimestamp(0)));
  }
  const book = new FeelingsBook(d.settings, d.profile, CARD_CHARS);
  await book.load();
  const cards = book.records();
  const selfState: JsonValue | null = await d.settings.get(d.profile, SELF_STATE_KEY);
  const result = d.people.migrateLegacy(
    { relationships, deltas, cards, selfState },
    { now: d.now },
  );
  await d.settings.set(d.profile, MIGRATED_KEY, {
    at,
    rows: result.rows.length,
    skipped: result.skipped.length,
  });
  d.log.info(
    {
      rows: result.rows.length,
      skipped: result.skipped.length,
      relationships: relationships.length,
      cards: cards.length,
      self_state: selfState !== null,
    },
    "heart: the old records moved to heart_person",
  );
  return result;
}

/**
 * The daily pass (H9) for everyone it has not run for on the local day of `now` (her day, the
 * rules' `utc_offset_minutes`; `now` from the module's clock, so tests set the day).
 */
export function runDecay(people: HeartStore, now: number): { people: number; changes: number } {
  let done = 0;
  let changes = 0;
  for (const person of people.decayDue(now)) {
    const pass = people.applyDecay(person, { now });
    if (pass === null) continue;
    done += 1;
    changes += pass.changes.length;
  }
  return { people: done, changes };
}

export interface HeartModuleOptions {
  /** Replaces the module context's clock (tests). */
  clock?: Clock;
}

export class HeartModule implements Module {
  static readonly ID = "heart";
  readonly manifest = defineManifest(HeartModule.ID, "Heart", {
    description:
      "Her numbers and words for each person (heart_person): her feel proposals, the daily pass, the migration from the old records",
    // After the modules whose old records it moves over once.
    optional: ["social", "self"],
    configSchema: HeartConfigSchema,
  });
  readonly #profile: ProfileId;
  readonly #options: HeartModuleOptions;

  constructor(profile: ProfileId, options: HeartModuleOptions = {}) {
    this.#profile = profile;
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(HeartConfigSchema);
    const clock = this.#options.clock ?? ctx.clock;
    const store = ctx.services.get(StoreKey);
    if (store === undefined) {
      ctx.log.warn("no store: the heart is not kept");
      return;
    }
    const people = store.plugin(heartTables).people;
    people.setRules(config);
    try {
      await migrateOnStart({
        people,
        settings: store.settings,
        relationships: store.relationships,
        profile: this.#profile,
        now: clock.now(),
        log: ctx.log,
      });
    } catch (error) {
      // The old records stay where they are; the next start tries again.
      ctx.log.warn({ err: errorMessage(error) }, "heart: the old records could not be moved");
    }
    ctx.provide(HeartKey, new HeartService(people, clock));
    const decay = () => {
      try {
        const done = runDecay(people, clock.now());
        if (done.changes > 0) ctx.log.debug(done, "heart: the daily pass ran");
      } catch (error) {
        ctx.log.warn({ err: errorMessage(error) }, "heart: the daily pass failed");
      }
    };
    ctx.spawn("decay", async (signal) => {
      decay();
      for await (const _ of interval(config.decay_check_mins * 60_000, signal)) decay();
    });
  }
}
