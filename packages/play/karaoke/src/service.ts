// `KaraokeService`: single-player karaoke on the member page (docs/design/karaoke.md 「做了什麼
// (第一步)」). A member asks for a song by link or search; the song worker prepares it
// (`KaraokeWorkerKey`, the singing module's workers) and the pass follows the job; the backing
// track and the reference are fetched once onto Core and served to the member through signed
// links; at the end the browser sends its pitch track, Core scores it again with the shared
// module, stores the result and tells her once. Nothing here calls a model; nothing here moves
// coins.

import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  KaraokeAdminResults,
  KaraokeOverview,
  KaraokeRequestResult,
  KaraokeResult,
  KaraokeSession,
  KaraokeSongView,
} from "@miyoria/contracts/api";
import {
  KARAOKE_FRAME_HZ,
  KARAOKE_MAX_SHIFT,
  karaokeBackingName,
  karaokeReferenceV2,
  shiftKaraokeReference,
  WorkersKaraokeReferenceSchema,
  type WorkersKaraokeReferenceV2,
  type WorkersSingJob,
} from "@miyoria/contracts/workers";
import {
  type AccountRef,
  type ContextKey,
  type KaraokeFileName,
  type KaraokeWorker,
  newId,
  type PersonId,
  safeName,
  toTimestamp,
} from "@miyoria/types";
import { commentContext, type KaraokeConfig, lyricsOptions } from "./config.js";
import { resultNote } from "./notes.js";
import { decodeTrack, fromBase64, type ScoreResult, scoreSinging } from "./score/index.js";
import { FileSigner, LINK_MS } from "./signing.js";
import type { KaraokeStore, ResultRow, SongRow } from "./store.js";

const DAY_MS = 86_400_000;
/** How long a submitted track is kept (§13.2). */
export const TRACK_KEEP_MS = 7 * DAY_MS;
/** How long a song's files stay on Core after it was last sung (§13.3). */
export const FILES_KEEP_MS = DAY_MS;
/** How long her comment is waited for after she was told. */
export const COMMENT_WAIT_MS = 3 * 60_000;
/** Of the reference's voice the singer must have voiced for it to count as singing together. */
const TOGETHER_COVERAGE = 0.3;
/** Below this, she hears of it but is not asked to comment: hardly anything was sung. */
const COMMENT_COVERAGE = 0.15;
/** References kept parsed in memory. */
const KEEP_PARSED = 6;

export const KARAOKE_FILES: readonly KaraokeFileName[] = ["reference.json", "karaoke.m4a"];

/** A file a signed link may name: the two, or the backing in another key. */
function servable(name: string): name is KaraokeFileName {
  if ((KARAOKE_FILES as readonly string[]).includes(name)) return true;
  const m = /^karaoke\.k([+-])([1-9]\d?)\.m4a$/.exec(name);
  return m !== null && Number(m[2]) <= KARAOKE_MAX_SHIFT;
}

/** A refusal: its HTTP status and a sentence for the member. */
export class KaraokeError extends Error {
  override readonly name = "KaraokeError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Who a member is to her: their person, or `null` for one she has none for. */
export interface KaraokeWho {
  person: PersonId | null;
  blocked: boolean;
}

/** One note she hears: the summary, its key, whom it is about, and where to say something. */
export interface KaraokeNote {
  summary: string;
  key: string;
  person: PersonId | null;
  /** The comment channel; `null`: she only hears of it (silent). */
  context: ContextKey | null;
}

export interface KaraokeDeps {
  config: KaraokeConfig;
  store: KaraokeStore;
  worker: () => KaraokeWorker | null;
  now: () => number;
  /** Absolute: where the songs' files are kept on Core. */
  cacheDir: string;
  who: (account: AccountRef) => KaraokeWho;
  tell: (note: KaraokeNote) => void;
  /** Singing with her: evidence for her nightly reflection on them. */
  together: (person: PersonId, detail: string, at: number, session: string) => void;
  log: {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
  };
  signer?: FileSigner;
}

/** What the browser sends at the end of a song. */
export interface Submission {
  track: string;
  latency_ms: number;
  calibrated: boolean;
  client_total: number | null;
  browser: string;
}

/** The part of a song's preparation that is not kept: the worker's stage while it runs. */
interface Live {
  stage: string | null;
  progress: number;
  position: number | null;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `url:<link>` or `query:<words>` of what a member typed, or `null` when it is neither. */
export function sourceOf(text: string): { key: string; url?: string; query?: string } | null {
  const t = text.trim().replace(/\s+/g, " ");
  if (t === "") return null;
  if (/^https?:\/\//i.test(t)) {
    let url: URL;
    try {
      url = new URL(t);
    } catch {
      return null;
    }
    url.hash = "";
    const link = url.toString();
    return { key: `url:${link}`, url: link };
  }
  if (t.length > 200) return null;
  return { key: `query:${t.toLowerCase()}`, query: t };
}

export class KaraokeService {
  readonly #d: KaraokeDeps;
  readonly #signer: FileSigner;
  readonly #live = new Map<string, Live>();
  /** Parsed references (version 2's shape, whichever was written), the most recently used last. */
  readonly #parsed = new Map<string, WorkersKaraokeReferenceV2>();
  /** Backings in another key being fetched, so two sessions do not fetch one twice. */
  readonly #keying = new Map<string, Promise<void>>();
  /** Songs whose files are being fetched, so two sessions do not fetch them twice. */
  readonly #fetching = new Map<string, Promise<void>>();

  constructor(deps: KaraokeDeps) {
    this.#d = deps;
    this.#signer = deps.signer ?? new FileSigner();
  }

  get config(): KaraokeConfig {
    return this.#d.config;
  }

  // ---- what a member sees ---------------------------------------------------------------------

  /** The start of her local day containing `now`. */
  #dayStart(now: number): number {
    const offset = this.#d.config.utc_offset_minutes * 60_000;
    return Math.floor((now + offset) / DAY_MS) * DAY_MS - offset;
  }

  #person(account: AccountRef): KaraokeWho {
    const who = this.#d.who(account);
    if (who.blocked) throw new KaraokeError(403, "現在不能唱");
    return who;
  }

  #view(
    song: SongRow,
    person: PersonId | null,
    bests?: Map<string, { best: number | null; sung: number }>,
  ): KaraokeSongView {
    const live = this.#live.get(song.id);
    const mine = bests?.get(song.id);
    return {
      id: song.id,
      title: song.title || song.source,
      artist: song.artist,
      duration_s: song.duration_ms === null ? null : Math.round(song.duration_ms / 100) / 10,
      state: song.status as KaraokeSongView["state"],
      stage: song.status === "preparing" ? (live?.stage ?? "queued") : null,
      progress:
        song.status === "ready" ? 1 : song.status === "preparing" ? (live?.progress ?? 0) : 0,
      position: song.status === "preparing" ? (live?.position ?? null) : null,
      error: song.status === "failed" ? song.error : null,
      lyrics: song.lyrics,
      lyrics_source:
        song.lyrics_source === "found" || song.lyrics_source === "heard"
          ? song.lyrics_source
          : null,
      notes: song.notes,
      mine: person !== null && song.requested_by === person,
      best: mine?.best ?? null,
      sung: mine?.sung ?? 0,
    };
  }

  overview(account: AccountRef): KaraokeOverview {
    const { person } = this.#person(account);
    const now = this.#d.now();
    const store = this.#d.store;
    const bests = person === null ? new Map() : store.bestsOf(person);
    const ready = store.songsIn("ready", 300);
    const pending = person === null ? [] : store.pendingOf(person, now - DAY_MS);
    const cfg = this.#d.config;
    return {
      open: cfg.open,
      preparing: this.#d.worker() !== null,
      songs: [...pending, ...ready].map((s) => this.#view(s, person, bests)),
      limits: {
        daily: cfg.daily_songs,
        used: person === null ? 0 : store.requestsSince(person, this.#dayStart(now)),
        max_minutes: Math.round((cfg.max_song_secs / 60) * 10) / 10,
      },
      tolerance_cents: cfg.tolerance_cents,
      comments: cfg.comment && commentContext(cfg.comment_channel) !== null,
      recent:
        person === null
          ? []
          : store.resultsOf(person, 10).map((r) => ({
              session: r.session_id,
              song: r.song_id,
              title: store.song(r.song_id)?.title ?? "",
              total: r.total,
              unranked: r.unranked,
              at: r.created_at,
            })),
    };
  }

  song(account: AccountRef, id: string): KaraokeSongView {
    const { person } = this.#person(account);
    const song = this.#d.store.song(id);
    if (song === null) throw new KaraokeError(404, "沒有這首歌");
    return this.#view(song, person, person === null ? undefined : this.#d.store.bestsOf(person));
  }

  /** A link or a search: the song already known, or a new preparation. */
  async request(account: AccountRef, text: string): Promise<KaraokeRequestResult> {
    const { person } = this.#person(account);
    const cfg = this.#d.config;
    if (!cfg.open) throw new KaraokeError(409, "現在沒有開放唱 K");
    const source = sourceOf(text);
    if (source === null) throw new KaraokeError(400, "請貼一個連結,或打歌名");
    const store = this.#d.store;
    const now = this.#d.now();
    // A song known by this link or search is that song; only a failed one is prepared again.
    const known = store.songBySource(source.key);
    if (known !== null && known.status !== "failed") {
      return { song: this.#view(known, person), created: false };
    }
    if (person === null) throw new KaraokeError(403, "她還不認識你,先在 Discord 跟她說說話");
    const used = store.requestsSince(person, this.#dayStart(now));
    if (used >= cfg.daily_songs) {
      throw new KaraokeError(
        409,
        cfg.daily_songs === 0
          ? "現在只能唱已經準備好的歌"
          : `今天已經準備了 ${used} 首(一天 ${cfg.daily_songs} 首),準備好的歌還是可以唱`,
      );
    }
    const worker = this.#d.worker();
    if (worker === null) throw new KaraokeError(503, "現在沒有能準備歌的機器");
    let job: WorkersSingJob;
    try {
      job = await worker.prepare({
        ...(source.url === undefined ? {} : { url: source.url }),
        ...(source.query === undefined ? {} : { query: source.query }),
        lyrics: lyricsOptions(cfg),
      });
    } catch (error) {
      this.#d.log.warn({ err: errorText(error) }, "karaoke: the worker did not take the song");
      const status = (error as { status?: unknown }).status;
      throw new KaraokeError(
        status === 400 ? 400 : 503,
        status === 400 ? "這個連結不能用,換一個或改打歌名" : "現在連不上準備歌的機器,等一下再試",
      );
    }
    const title = job.source?.title ?? "";
    let song: SongRow;
    if (known === null) {
      song = store.addSong(
        { id: newId(), source_key: source.key, source: text.trim(), title },
        person,
        now,
      );
    } else {
      store.retrySong(known.id, person);
      song = store.song(known.id) as SongRow;
    }
    store.patchSong(song.id, { job: job.id, ...(title ? { title } : {}) });
    store.addRequest(person, song.id, now);
    this.#follow(song.id, job);
    return { song: this.#view(store.song(song.id) as SongRow, person), created: true };
  }

  // ---- preparing ------------------------------------------------------------------------------

  /** One look at every song being prepared, and the upkeep when `upkeep`. */
  async tick(signal: AbortSignal, upkeep = false): Promise<void> {
    for (const song of this.#d.store.songsIn("preparing")) {
      if (signal.aborted) return;
      await this.#poll(song, signal);
    }
    if (upkeep) await this.#upkeep();
  }

  async #poll(song: SongRow, signal: AbortSignal): Promise<void> {
    const worker = this.#d.worker();
    if (worker === null || song.job === null) return;
    let job: WorkersSingJob;
    try {
      job = await worker.job(song.job, signal);
    } catch (error) {
      if ((error as { status?: unknown }).status === 404) {
        this.#fail(song, "準備被中斷了,再點一次", errorText(error));
      }
      return;
    }
    this.#follow(song.id, job);
    if (job.state === "failed" || job.state === "cancelled") {
      this.#fail(
        song,
        failureText(job.error, this.#d.config.max_song_secs),
        job.error ?? job.state,
      );
      return;
    }
    if (job.state !== "done") return;
    const made = job.karaoke ?? null;
    if (made === null) {
      this.#fail(song, "準備失敗了,可以再點一次", "the job finished without a karaoke song");
      return;
    }
    if (made.quality !== null && !made.quality.ok) {
      this.#fail(song, "這首抓不到主旋律,換一首試試", made.quality.reason ?? "quality");
      return;
    }
    const duration = made.duration_s;
    if (duration !== null && duration > this.#d.config.max_song_secs) {
      this.#fail(song, tooLong(this.#d.config.max_song_secs), `${duration} s`);
      return;
    }
    this.#d.store.patchSong(song.id, { worker_song: made.id });
    try {
      await this.#fetch({ ...song, worker_song: made.id }, signal);
      const ref = await this.reference(song.id);
      this.#d.store.patchSong(song.id, {
        status: "ready",
        title: made.title || ref.title || song.title,
        artist: made.artist ?? ref.artist,
        duration_ms: Math.round(ref.duration_s * 1000),
        lyrics: ref.lyrics !== null && ref.lyrics.lines.length > 0,
        lyrics_source:
          ref.lyrics !== null && ref.lyrics.lines.length > 0 ? ref.lyrics.source : null,
        notes: ref.notes.length,
        ready_at: toTimestamp(this.#d.now()),
      });
      this.#live.delete(song.id);
    } catch (error) {
      if (signal.aborted) return;
      this.#fail(song, "準備好了但拿不到檔案,再點一次", errorText(error));
    }
  }

  #follow(id: string, job: WorkersSingJob): void {
    this.#live.set(id, {
      stage: job.stage || null,
      progress: job.progress,
      position: job.position,
    });
  }

  #fail(song: SongRow, text: string, detail: string): void {
    this.#d.log.info({ song: song.id, detail }, "karaoke: a song could not be prepared");
    this.#d.store.patchSong(song.id, {
      status: "failed",
      error: text,
      error_detail: detail.slice(0, 500),
    });
    this.#live.delete(song.id);
  }

  #dir(song: string): string {
    return join(this.#d.cacheDir, song);
  }

  /** The song's files onto Core (from the worker that made them), unless they are there. */
  async #fetch(song: SongRow, signal?: AbortSignal): Promise<void> {
    const running = this.#fetching.get(song.id);
    if (running !== undefined) return running;
    const work = (async () => {
      const dir = this.#dir(song.id);
      const missing: KaraokeFileName[] = [];
      for (const name of KARAOKE_FILES) {
        if (!(await exists(join(dir, name)))) missing.push(name);
      }
      if (missing.length === 0) return;
      const worker = this.#d.worker();
      if (worker === null || song.worker_song === null) throw new Error("no worker has the song");
      await mkdir(dir, { recursive: true });
      const made = song.worker_song;
      for (const name of missing) await worker.file(made, name, join(dir, name), signal);
    })();
    this.#fetching.set(song.id, work);
    try {
      await work;
    } finally {
      this.#fetching.delete(song.id);
    }
  }

  /** The song's reference, parsed, in version 2's shape (kept for the next few). */
  async reference(song: string): Promise<WorkersKaraokeReferenceV2> {
    const kept = this.#parsed.get(song);
    if (kept !== undefined) {
      this.#parsed.delete(song);
      this.#parsed.set(song, kept);
      return kept;
    }
    const row = this.#d.store.song(song);
    if (row === null) throw new KaraokeError(404, "沒有這首歌");
    await this.#fetch(row);
    const raw = await readFile(join(this.#dir(song), "reference.json"), "utf8");
    const parsed = karaokeReferenceV2(WorkersKaraokeReferenceSchema.parse(JSON.parse(raw)));
    this.#parsed.set(song, parsed);
    while (this.#parsed.size > KEEP_PARSED) {
      const oldest = this.#parsed.keys().next().value as string;
      this.#parsed.delete(oldest);
    }
    return parsed;
  }

  // ---- singing --------------------------------------------------------------------------------

  /** The backing `shift` semitones away onto Core: made by the worker that has the song, once. */
  async #fetchKey(song: SongRow, shift: number): Promise<void> {
    const name = karaokeBackingName(shift) as KaraokeFileName;
    const dest = join(this.#dir(song.id), name);
    if (await exists(dest)) return;
    const key = `${song.id}/${shift}`;
    const running = this.#keying.get(key);
    if (running !== undefined) return running;
    const work = (async () => {
      const worker = this.#d.worker();
      if (worker === null || song.worker_song === null) throw new Error("no worker has the song");
      const made = await worker.key(song.worker_song, shift);
      await worker.file(song.worker_song, made.file as KaraokeFileName, dest);
    })();
    this.#keying.set(key, work);
    try {
      await work;
    } finally {
      this.#keying.delete(key);
    }
  }

  /**
   * One singing of a ready song: a session and its signed links. `shift`: semitones to move the
   * key by (the worker renders the backing in that key; the reference moves with it).
   */
  async start(
    account: AccountRef,
    name: string,
    songId: string,
    shift = 0,
  ): Promise<KaraokeSession> {
    const { person } = this.#person(account);
    if (!this.#d.config.open) throw new KaraokeError(409, "現在沒有開放唱 K");
    if (!Number.isInteger(shift) || Math.abs(shift) > KARAOKE_MAX_SHIFT) {
      throw new KaraokeError(400, `升降調最多 ${KARAOKE_MAX_SHIFT} 個半音`);
    }
    const song = this.#d.store.song(songId);
    if (song === null) throw new KaraokeError(404, "沒有這首歌");
    if (song.status !== "ready") throw new KaraokeError(409, "這首還沒準備好");
    try {
      await this.#fetch(song);
      await this.reference(song.id);
    } catch (error) {
      if (error instanceof KaraokeError) throw error;
      this.#d.log.warn({ song: song.id, err: errorText(error) }, "karaoke: the files are gone");
      throw new KaraokeError(503, "這首的檔案現在拿不到,等一下再試");
    }
    if (shift !== 0) {
      try {
        await this.#fetchKey(song, shift);
      } catch (error) {
        this.#d.log.warn(
          { song: song.id, shift, err: errorText(error) },
          "karaoke: no backing in that key",
        );
        throw new KaraokeError(503, "現在做不出這個調,換回原調或等一下再試");
      }
    }
    const now = this.#d.now();
    const duration = song.duration_ms ?? this.#d.config.max_song_secs * 1000;
    const id = newId();
    this.#d.store.addSession({
      id,
      song_id: song.id,
      person_id: person,
      platform: account.platform,
      account_id: account.id,
      name: safeName(name, 60),
      started_at: toTimestamp(now),
      expires_at: toTimestamp(now + duration * 3 + 30 * 60_000),
      shift,
    });
    const exp = now + LINK_MS;
    return {
      session: id,
      song: this.#view(song, person, person === null ? undefined : this.#d.store.bestsOf(person)),
      backing_url: this.#signer.url(id, karaokeBackingName(shift) as KaraokeFileName, account, exp),
      reference_url: this.#signer.url(id, "reference.json", account, exp),
      expires_at: toTimestamp(exp),
      tolerance_cents: this.#d.config.tolerance_cents,
      frame_hz: KARAOKE_FRAME_HZ,
      shift,
    };
  }

  /**
   * The file a signed link names, for `account`: its path and type, or `null` (the route answers
   * 404 to anything wrong, the same for every reason).
   */
  async file(
    account: AccountRef,
    session: string,
    name: string,
    exp: string | undefined,
    sig: string | undefined,
  ): Promise<{ path: string; type: string } | null> {
    if (!servable(name)) return null;
    if (!this.#signer.check(session, name, account, exp, sig, this.#d.now())) return null;
    const row = this.#d.store.session(session);
    if (row === null || row.platform !== account.platform || row.account_id !== account.id) {
      return null;
    }
    // A backing in another key only for the session sung in it.
    if (name.startsWith("karaoke.k") && name !== karaokeBackingName(row.shift)) return null;
    const path = join(this.#dir(row.song_id), name);
    if (!(await exists(path))) return null;
    return { path, type: name.endsWith(".json") ? "application/json" : "audio/mp4" };
  }

  /** The browser's track, once, at the end: Core's score, stored, and her note. */
  async submit(account: AccountRef, sessionId: string, body: Submission): Promise<KaraokeResult> {
    const { person } = this.#person(account);
    const store = this.#d.store;
    const session = store.session(sessionId);
    if (
      session === null ||
      session.platform !== account.platform ||
      session.account_id !== account.id
    ) {
      throw new KaraokeError(404, "沒有這一次的紀錄");
    }
    if (session.status !== "open") throw new KaraokeError(409, "這一次已經交過了");
    const now = this.#d.now();
    if (now > Date.parse(session.expires_at)) throw new KaraokeError(409, "這一次已經過期了");
    const song = store.song(session.song_id);
    if (song === null) throw new KaraokeError(404, "沒有這首歌");
    const bytes = fromBase64(body.track);
    if (bytes === null) throw new KaraokeError(400, "音高軌的格式不對");
    // Sung in another key: the reference moves with the backing.
    const reference = shiftKaraokeReference(await this.reference(song.id), session.shift);
    const most = Math.ceil(reference.duration_s * KARAOKE_FRAME_HZ) + 5 * KARAOKE_FRAME_HZ;
    if (bytes.length > most) throw new KaraokeError(400, "音高軌比歌還長");
    // A track takes as long to sing as it is long: one made beforehand arrives too soon.
    const sungMs = (bytes.length / KARAOKE_FRAME_HZ) * 1000;
    if (now - Date.parse(session.started_at) < sungMs - 5000) {
      throw new KaraokeError(409, "這一次的時間對不上,沒有收");
    }
    const lines = reference.lyrics?.lines ?? [];
    const result = scoreSinging({
      reference: {
        hz: reference.pitch.hz,
        start: reference.pitch.start,
        midi: reference.pitch.midi,
      },
      sung: { hz: KARAOKE_FRAME_HZ, midi: decodeTrack(bytes) },
      latency_ms: body.latency_ms,
      calibrated: body.calibrated,
      phrases: lines.length > 0 ? lines.map((l) => ({ start: l.start, end: l.end })) : null,
      tuning: { tolerance_cents: this.#d.config.tolerance_cents },
    });
    const phraseText = lines.length > 0 ? lines.map((l) => l.text) : [];
    const unranked = result.flags.too_perfect;
    const bestBefore = person === null ? null : (store.bestsOf(person).get(song.id)?.best ?? null);
    const context = this.#d.config.comment ? commentContext(this.#d.config.comment_channel) : null;
    const speaks = context !== null && result.facts.coverage >= COMMENT_COVERAGE;
    const at = toTimestamp(now);
    const detail: StoredDetail = { result, lines: phraseText, latency_ms: body.latency_ms };
    const row: ResultRow = {
      session_id: session.id,
      song_id: song.id,
      person_id: person,
      total: result.total,
      pitch: result.pitch.score,
      stability: result.stability.score,
      rhythm: result.rhythm.score,
      expression: result.expression.score,
      unranked,
      reasons: JSON.stringify(result.flags.reasons),
      detail: JSON.stringify(detail),
      client_total: body.client_total,
      best_before: bestBefore,
      comment_state: speaks ? "waiting" : "none",
      comment: null,
      channel: speaks ? context.channel : null,
      noted_at: at,
      comment_at: null,
      created_at: at,
    };
    const stored = store.scored(
      {
        session_id: session.id,
        hz: KARAOKE_FRAME_HZ,
        frames: body.track.replace(/\s+/g, ""),
        latency_ms: body.latency_ms,
        calibrated: body.calibrated,
        browser: body.browser.slice(0, 60),
        submitted_at: at,
        purge_at: toTimestamp(now + TRACK_KEEP_MS),
      },
      row,
      {
        session: session.id,
        song: song.id,
        title: song.title,
        person,
        total: result.total,
        pitch: result.pitch.score,
        stability: result.stability.score,
        rhythm: result.rhythm.score,
        expression: result.expression.score,
        unranked,
      },
    );
    if (!stored) throw new KaraokeError(409, "這一次已經交過了");
    try {
      this.#d.tell({
        summary: resultNote({
          name: session.name,
          title: song.title,
          result,
          lines: phraseText,
          bestBefore,
        }),
        key: `karaoke:${session.id}`,
        person,
        context: speaks ? context : null,
      });
    } catch (error) {
      this.#d.log.warn({ err: errorText(error) }, "karaoke: cannot tell her about a song");
    }
    if (person !== null && result.facts.coverage >= TOGETHER_COVERAGE) {
      this.#d.together(
        person,
        `在會員頁唱 K 給她聽:「${safeName(song.title, 40)}」${result.total} 分`,
        now,
        session.id,
      );
    }
    return this.#resultView(store.result(session.id) as ResultRow, song);
  }

  /** A result of the member's own. */
  result(account: AccountRef, sessionId: string): KaraokeResult {
    this.#person(account);
    const store = this.#d.store;
    const session = store.session(sessionId);
    const row = store.result(sessionId);
    if (
      session === null ||
      row === null ||
      session.platform !== account.platform ||
      session.account_id !== account.id
    ) {
      throw new KaraokeError(404, "沒有這一次的紀錄");
    }
    const song = store.song(row.song_id);
    if (song === null) throw new KaraokeError(404, "沒有這首歌");
    return this.#resultView(row, song);
  }

  #resultView(row: ResultRow, song: SongRow): KaraokeResult {
    const { result, lines, latency_ms } = JSON.parse(row.detail) as StoredDetail;
    return {
      session: row.session_id,
      song: { id: song.id, title: song.title, artist: song.artist },
      at: row.created_at,
      total: result.total,
      pitch: result.pitch,
      stability: result.stability,
      rhythm: result.rhythm,
      expression: result.expression,
      phrases: result.phrases.map((p) => ({ ...p, text: lines[p.index] ?? null })),
      facts: result.facts,
      unranked: row.unranked,
      client_total: row.client_total,
      latency_ms,
      best_before: row.best_before,
      comment: { state: row.comment_state as KaraokeResult["comment"]["state"], text: row.comment },
    };
  }

  // ---- her comment ----------------------------------------------------------------------------

  /**
   * She finished a turn in `context` with `text`: when a result there is waiting for her comment
   * (told within `COMMENT_WAIT_MS`), the oldest takes it. A guess by place and time, so only the
   * first turn after the note counts.
   */
  heard(context: ContextKey, text: string): void {
    const want = commentContext(this.#d.config.comment_channel);
    if (want === null || context.kind !== "channel" || context.channel !== want.channel) return;
    if (context.platform !== want.platform || text.trim() === "") return;
    const now = this.#d.now();
    const [first] = this.#d.store.waitingIn(want.channel, now - COMMENT_WAIT_MS);
    if (first === undefined) return;
    this.#d.store.setComment(first.session_id, "said", text.trim().slice(0, 1000), now);
  }

  // ---- upkeep ---------------------------------------------------------------------------------

  async #upkeep(): Promise<void> {
    const now = this.#d.now();
    const store = this.#d.store;
    store.purgeTracks(now);
    store.giveUpComments(now - COMMENT_WAIT_MS);
    for (const song of store.idleReady(now - FILES_KEEP_MS)) {
      if (this.#fetching.has(song.id)) continue;
      const dir = this.#dir(song.id);
      if (!(await exists(dir))) continue;
      this.#parsed.delete(song.id);
      await rm(dir, { recursive: true, force: true }).catch((error: unknown) => {
        this.#d.log.warn({ song: song.id, err: errorText(error) }, "karaoke: cannot clear files");
      });
    }
  }

  // ---- the owner's look -----------------------------------------------------------------------

  adminResults(limit = 50): KaraokeAdminResults {
    return {
      results: this.#d.store.latest(limit).map((r) => ({
        session: r.session_id,
        person: r.person_id,
        name: r.name,
        song: r.song_id,
        title: r.title,
        total: r.total,
        client_total: r.client_total,
        unranked: r.unranked,
        reasons: JSON.parse(r.reasons) as string[],
        latency_ms: r.track?.latency_ms ?? 0,
        calibrated: r.track?.calibrated ?? false,
        browser: r.track?.browser ?? "",
        at: r.created_at,
      })),
    };
  }

  /** A song worker is there to prepare songs. */
  hasWorker(): boolean {
    return this.#d.worker() !== null;
  }

  /** For the card: songs ready and being prepared. */
  counts(): { ready: number; preparing: number } {
    return {
      ready: this.#d.store.songsIn("ready", 10_000).length,
      preparing: this.#d.store.songsIn("preparing").length,
    };
  }
}

/** What a result row keeps as `detail`. */
interface StoredDetail {
  result: ScoreResult;
  lines: (string | null)[];
  latency_ms: number;
}

function tooLong(maxSecs: number): string {
  return `這首太長了(最多 ${Math.round((maxSecs / 60) * 10) / 10} 分鐘)`;
}

/** A sentence for people from the worker's own words. */
export function failureText(error: string | null, maxSecs: number): string {
  const e = (error ?? "").toLowerCase();
  if (e.includes("host") || e.includes("not allowed") || e.includes("unsupported url")) {
    return "這個網站的連結不能用,換一個或改打歌名";
  }
  if (e.includes("too long") || e.includes("longer than")) return tooLong(maxSecs);
  if (e.includes("no result") || e.includes("not found") || e.includes("no video")) {
    return "找不到這首歌,換個寫法試試";
  }
  if (e === "cancelled") return "準備被取消了,可以再點一次";
  return "準備失敗了,可以再點一次";
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
