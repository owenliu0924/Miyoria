// Module `karaoke` (docs/design/karaoke.md 「做了什麼(第一步)」): the owner of the `karaoke`
// plugin's tables. It puts `[modules.karaoke]` in force and provides `KaraokeKey`
// (`KaraokeService`), which the member routes of `packages/api` call. Songs are prepared on the
// song workers through `KaraokeWorkerKey` (the singing module's); without it nothing new is
// prepared, and the songs already on Core can still be sung.
//
// She hears of each finished song as a note she may react to (an observation, like the cards'
// and the market's notes), in the comment channel when one is set; her next turn there is kept as
// her comment on that result. Singing counts as `played_together` for the heart. No model is
// called here, and no coins move.

import { resolve } from "node:path";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleCard,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import { StoreKey } from "@miyoria/store";
import {
  type Clock,
  EventLogKey,
  Events,
  HandleDirectoryKey,
  HeartKey,
  is,
  KaraokeWorkerKey,
  SocialSignalsKey,
  serviceKey,
} from "@miyoria/types";
import { karaokeCard } from "./card.js";
import { commentContext, KaraokeConfigSchema } from "./config.js";
import { type KaraokeNote, KaraokeService } from "./service.js";
import { karaokeTables } from "./store.js";

export const KaraokeKey = serviceKey<KaraokeService>("Karaoke");

/** How often the jobs being prepared are looked at. */
export const TICK_MS = 3_000;
/** Every this many looks, the upkeep (old tracks, idle files, comments not made). */
const UPKEEP_EVERY = 20;
/** Her working-context bucket for karaoke, and how many notes it keeps. */
const WRITER = "karaoke";
const MAX_ENTRIES = 4;

export interface KaraokeModuleOptions {
  /** What a relative `cache_dir` is relative to (the directory of `miyoria.toml`). */
  baseDir?: string;
  /** Replaces the module context's clock (tests). */
  clock?: Clock;
  tickMs?: number;
}

export class KaraokeModule implements Module {
  static readonly ID = "karaoke";
  readonly manifest = defineManifest(KaraokeModule.ID, "Karaoke", {
    icon: "mic-vocal",
    category: "play",
    description:
      "Karaoke on the member page: songs prepared by the song worker, sung in the browser, scored by Core, and her comment",
    optional: ["sing", "heart", "api"],
    configSchema: KaraokeConfigSchema,
  });
  readonly #options: KaraokeModuleOptions;
  #running: KaraokeService | null = null;

  constructor(options: KaraokeModuleOptions = {}) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(KaraokeConfigSchema);
    const store = ctx.services.get(StoreKey);
    if (store === undefined) {
      ctx.log.warn("no store: no karaoke");
      return;
    }
    const clock = this.#options.clock ?? ctx.clock;
    const service = new KaraokeService({
      config,
      store: store.plugin(karaokeTables),
      worker: () => ctx.services.get(KaraokeWorkerKey) ?? null,
      now: () => clock.now(),
      cacheDir: resolve(this.#options.baseDir ?? process.cwd(), config.cache_dir),
      who: (account) => {
        const attitude = ctx.services.get(SocialSignalsKey)?.attitude(account) ?? null;
        return { person: attitude?.person ?? null, blocked: attitude?.blocked ?? false };
      },
      tell: (note) => tell(ctx, note),
      together: (person, detail, at, session) => {
        try {
          ctx.services.get(HeartKey)?.evidence?.({
            person,
            kind: "played_together",
            detail,
            weight: null,
            at,
            session: `karaoke:${session}`,
          });
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "karaoke: cannot record singing together");
        }
      },
      log: ctx.log,
    });
    ctx.provide(KaraokeKey, service);
    this.#running = service;

    // Her turns in the comment channel: the first after a note is her comment on it.
    const turns = ctx.subscribe([Events.AgentTurnCompleted.type]);
    ctx.spawn("comments", async () => {
      for await (const env of turns) {
        if (!is(Events.AgentTurnCompleted, env)) continue;
        try {
          service.heard(env.data.context, env.data.text);
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "karaoke: cannot keep her comment");
        }
      }
    });
    const every = this.#options.tickMs ?? TICK_MS;
    ctx.spawn("pass", async (signal) => {
      let n = 0;
      const pass = async () => {
        try {
          await service.tick(signal, n++ % UPKEEP_EVERY === 0);
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "karaoke: the pass failed");
        }
      };
      await pass();
      for await (const _ of interval(every, signal)) await pass();
    });
  }

  async card(): Promise<ModuleCard> {
    const service = this.#running;
    if (service === null) return { facts: [] };
    const cfg = service.config;
    return karaokeCard({
      open: cfg.open,
      ...service.counts(),
      worker: service.hasWorker(),
      comments: cfg.comment && commentContext(cfg.comment_channel) !== null,
    });
  }

  async stop(): Promise<void> {
    this.#running = null;
  }
}

/** A finished song she hears of: may speak in the comment channel, else only knows. */
function tell(ctx: ModuleContext, note: KaraokeNote): void {
  const handle =
    note.person === null
      ? null
      : (ctx.services.get(HandleDirectoryKey)?.ofPerson(note.person) ?? null);
  ctx.services.get(EventLogKey)?.observe(
    {
      source: "game.karaoke",
      silent: note.context === null,
      salience: "notable",
      attention_key: note.key,
      revision: 1,
      summary: note.summary,
      addressed_to_her: false,
      from: handle,
      context: note.context,
    },
    {
      buckets: [
        {
          op: "append-self",
          writer: WRITER,
          owner: KaraokeModule.ID,
          untrusted: true,
          max_entries: MAX_ENTRIES,
        },
      ],
      person: handle,
    },
  );
}
