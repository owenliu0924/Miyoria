// The karaoke service on a real store (SQLite in memory) with a song worker in memory: asking for
// a song, following its preparation, sessions and their signed links, scoring a submitted track,
// her note and her comment, the daily limit, the upkeep and forgetting a person.

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import type { AccountRef, PersonId } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type KaraokeConfig, KaraokeConfigSchema } from "../src/config.js";
import { karaokeSchema } from "../src/migrations.js";
import { TrackRecorder } from "../src/score/index.js";
import {
  COMMENT_WAIT_MS,
  FILES_KEEP_MS,
  failureText,
  KaraokeError,
  type KaraokeNote,
  KaraokeService,
  sourceOf,
  TRACK_KEEP_MS,
} from "../src/service.js";
import { KaraokeStore } from "../src/store.js";
import {
  copySinger,
  FakeKaraokeWorker,
  humanSinger,
  referenceOf,
  referenceV1Of,
  type SynthSong,
  synthSong,
} from "../src/testing.js";

const ALICE: AccountRef = { platform: "discord", id: "1" };
const BOB: AccountRef = { platform: "discord", id: "2" };
const STRANGER: AccountRef = { platform: "discord", id: "9" };
const BLOCKED: AccountRef = { platform: "discord", id: "6" };
const PEOPLE: Record<string, { person: PersonId | null; blocked: boolean }> = {
  "1": { person: "p-alice", blocked: false },
  "2": { person: "p-bob", blocked: false },
  "6": { person: "p-blocked", blocked: true },
};
const CHANNEL = "discord:111111:222222";
const T0 = Date.UTC(2026, 10, 18, 4, 0, 0);

const song = synthSong(2, 6);
const LYRICS_DEFAULTS = {
  aligner: "w2v",
  matched: 0.75,
  uncertain: 0.5,
  keep_share: 0.5,
  wrong_share: 0.2,
};

interface Rig {
  service: KaraokeService;
  worker: FakeKaraokeWorker;
  store: KaraokeStore;
  notes: KaraokeNote[];
  together: { person: PersonId; detail: string }[];
  clock: { t: number };
  dir: string;
  raw: TestDb;
}

let rig: Rig;

async function makeRig(overrides: Partial<KaraokeConfig> = {}): Promise<Rig> {
  const raw = openTestDb({ plugins: [karaokeSchema] });
  const store = new KaraokeStore(raw.db, raw.events);
  const worker = new FakeKaraokeWorker();
  const notes: KaraokeNote[] = [];
  const together: Rig["together"] = [];
  const clock = { t: T0 };
  const dir = await mkdtemp(join(tmpdir(), "karaoke-"));
  const config = KaraokeConfigSchema.parse({ comment_channel: CHANNEL, ...overrides });
  const service = new KaraokeService({
    config,
    store,
    worker: () => worker,
    now: () => clock.t,
    cacheDir: dir,
    who: (account) => PEOPLE[account.id] ?? { person: null, blocked: false },
    tell: (note) => notes.push(note),
    together: (person, detail) => together.push({ person, detail }),
    log: { info: () => {}, warn: () => {} },
  });
  return { service, worker, store, notes, together, clock, dir, raw };
}

beforeEach(async () => {
  rig = await makeRig();
});

afterEach(async () => {
  rig.raw.close();
  await rm(rig.dir, { recursive: true, force: true });
});

const signal = new AbortController().signal;

/** Asks for a song and has the worker finish it; its id. */
async function ready(r: Rig, text = "https://youtu.be/abc", s: SynthSong = song): Promise<string> {
  const asked = await r.service.request(ALICE, text);
  const job = r.store.song(asked.song.id)?.job as string;
  r.worker.finish(job, referenceOf(s, `k-${job}`));
  await r.service.tick(signal);
  return asked.song.id;
}

/** Sings `track` in a session started now, after its length, and submits it. */
async function sing(
  r: Rig,
  songId: string,
  track = humanSinger(song),
  options: { latency_ms?: number; calibrated?: boolean; who?: AccountRef } = {},
) {
  const who = options.who ?? ALICE;
  const session = await r.service.start(who, "Alice", songId);
  const rec = new TrackRecorder(track.hz);
  track.midi.forEach((m, j) => {
    rec.push(j / track.hz, m);
  });
  r.clock.t += rec.seconds * 1000 + 2000;
  return {
    session,
    result: await r.service.submit(who, session.session, {
      track: rec.encode(),
      latency_ms: options.latency_ms ?? 0,
      calibrated: options.calibrated ?? true,
      client_total: 90,
      browser: "Chrome",
    }),
  };
}

describe("asking for a song", () => {
  it("prepares a new song, follows it, and makes it ready", async () => {
    const asked = await rig.service.request(ALICE, "  https://youtu.be/abc#t=3 ");
    expect(asked.created).toBe(true);
    expect(asked.song.state).toBe("preparing");
    expect(rig.worker.asked).toEqual([{ url: "https://youtu.be/abc", lyrics: LYRICS_DEFAULTS }]);
    const job = rig.store.song(asked.song.id)?.job as string;
    rig.worker.progress(job, "separate", 0.4);
    await rig.service.tick(signal);
    const preparing = rig.service.song(ALICE, asked.song.id);
    expect(preparing).toMatchObject({ state: "preparing", stage: "separate", progress: 0.4 });
    rig.worker.finish(job, referenceOf(song, "k-1"));
    await rig.service.tick(signal);
    const done = rig.service.song(ALICE, asked.song.id);
    expect(done.state).toBe("ready");
    expect(done.lyrics).toBe(true);
    expect(done.notes).toBe(song.notes.length);
    expect(done.mine).toBe(true);
    expect((await readdir(join(rig.dir, asked.song.id))).sort()).toEqual([
      "karaoke.m4a",
      "reference.json",
    ]);
    // The same link again is the same song, and costs nothing.
    const again = await rig.service.request(BOB, "https://youtu.be/abc");
    expect(again).toMatchObject({ created: false, song: { id: asked.song.id, mine: false } });
    expect(rig.service.overview(BOB).songs.map((s) => s.id)).toEqual([asked.song.id]);
  });

  it("searches with words", async () => {
    await rig.service.request(ALICE, "某首 歌");
    expect(rig.worker.asked).toEqual([{ query: "某首 歌", lyrics: LYRICS_DEFAULTS }]);
    expect(sourceOf("某首  歌")?.key).toBe("query:某首 歌");
    expect(sourceOf("")).toBeNull();
  });

  it("sends the lyrics settings with every song, and keeps where its lyrics came from", async () => {
    rig = await makeRig({ aligner: "mms", lyrics_matched: 0.8, lyrics_uncertain: 0.9 });
    const heard = await rig.service.request(ALICE, "heard");
    expect(rig.worker.asked[0]?.lyrics).toEqual({
      ...LYRICS_DEFAULTS,
      aligner: "mms",
      matched: 0.8,
      uncertain: 0.8, // never above the matched threshold
    });
    rig.worker.finish(
      rig.store.song(heard.song.id)?.job as string,
      referenceOf(song, "k-heard", "聽來的", true),
    );
    // A song a step 1 worker made (reference.json version 1) is still sung.
    const old = await rig.service.request(ALICE, "old");
    rig.worker.finish(rig.store.song(old.song.id)?.job as string, referenceV1Of(song, "k-old"));
    await rig.service.tick(signal);
    expect(rig.service.song(ALICE, heard.song.id)).toMatchObject({
      state: "ready",
      lyrics: true,
      lyrics_source: "heard",
    });
    expect(rig.service.song(ALICE, old.song.id)).toMatchObject({
      state: "ready",
      lyrics_source: "found",
    });
    const ref = await rig.service.reference(old.song.id);
    expect(ref.version).toBe(2);
    expect(ref.lyrics?.lines[0]).toMatchObject({
      status: "unchecked",
      source: "found",
      pieces: null,
    });
    const { result } = await sing(rig, old.song.id);
    expect(result.total).toBeGreaterThan(85);
  });

  it("holds each person to the day's limit, counted in her local day", async () => {
    rig = await makeRig({ daily_songs: 2 });
    await rig.service.request(ALICE, "a");
    await rig.service.request(ALICE, "b");
    await expect(rig.service.request(ALICE, "c")).rejects.toMatchObject({ status: 409 });
    expect(rig.service.overview(ALICE).limits).toMatchObject({ daily: 2, used: 2 });
    // Bob has his own; a known song is free.
    await rig.service.request(BOB, "c");
    await expect(rig.service.request(ALICE, "c")).resolves.toMatchObject({ created: false });
    // Her day starts at midnight UTC+8 (16:00 UTC).
    rig.clock.t = Date.UTC(2026, 10, 18, 16, 0, 1);
    await expect(rig.service.request(ALICE, "d")).resolves.toMatchObject({ created: true });
  });

  it("says why a song could not be prepared", async () => {
    const a = await rig.service.request(ALICE, "https://youtu.be/long");
    const ja = rig.store.song(a.song.id)?.job as string;
    rig.worker.finish(ja, { ...referenceOf(song, "k-long"), duration_s: 900 });
    const b = await rig.service.request(ALICE, "no melody");
    const jb = rig.store.song(b.song.id)?.job as string;
    rig.worker.finish(jb, {
      ...referenceOf(song, "k-quiet"),
      quality: { ok: false, reason: "voiced 3%", voiced_ratio: 0.03, notes: 2, lead_split: true },
    });
    const c = await rig.service.request(ALICE, "https://example.com/x");
    rig.worker.fail(
      rig.store.song(c.song.id)?.job as string,
      "that link is not on an allowed host",
    );
    await rig.service.tick(signal);
    expect(rig.service.song(ALICE, a.song.id).error).toBe("這首太長了(最多 8 分鐘)");
    expect(rig.service.song(ALICE, b.song.id).error).toBe("這首抓不到主旋律,換一首試試");
    expect(rig.service.song(ALICE, c.song.id).error).toBe("這個網站的連結不能用,換一個或改打歌名");
    // A failed song may be asked for again.
    const retry = await rig.service.request(ALICE, "no melody");
    expect(retry).toMatchObject({ created: true, song: { id: b.song.id, state: "preparing" } });
    expect(failureText("ERROR: video too long", 300)).toBe("這首太長了(最多 5 分鐘)");
  });

  it("refuses what it cannot do, in a sentence", async () => {
    await expect(rig.service.request(BLOCKED, "a")).rejects.toMatchObject({ status: 403 });
    await expect(rig.service.request(STRANGER, "a")).rejects.toMatchObject({ status: 403 });
    rig.worker.refuse = { message: "not an allowed host", status: 400 };
    await expect(rig.service.request(ALICE, "https://x.y/z")).rejects.toMatchObject({
      status: 400,
    });
    rig = await makeRig({ open: false });
    await expect(rig.service.request(ALICE, "a")).rejects.toBeInstanceOf(KaraokeError);
  });

  it("calls a job the worker lost an interrupted preparation", async () => {
    const asked = await rig.service.request(ALICE, "a");
    rig.worker.jobs.clear();
    await rig.service.tick(signal);
    expect(rig.service.song(ALICE, asked.song.id)).toMatchObject({
      state: "failed",
      error: "準備被中斷了,再點一次",
    });
  });
});

describe("singing", () => {
  it("serves the files only through its signed links, to its own member", async () => {
    const id = await ready(rig);
    const session = await rig.service.start(ALICE, "Alice", id);
    const url = new URL(session.backing_url, "http://x");
    const [, , , , , sid, name] = url.pathname.split("/");
    const exp = url.searchParams.get("exp") ?? undefined;
    const sig = url.searchParams.get("sig") ?? undefined;
    expect(session.backing_url).not.toContain("download");
    expect(await rig.service.file(ALICE, sid as string, name as string, exp, sig)).toMatchObject({
      type: "audio/mp4",
    });
    expect(await rig.service.file(BOB, sid as string, name as string, exp, sig)).toBeNull();
    expect(await rig.service.file(ALICE, sid as string, "reference.json", exp, sig)).toBeNull();
    expect(await rig.service.file(ALICE, sid as string, name as string, exp, `${sig}x`)).toBeNull();
    expect(await rig.service.file(ALICE, sid as string, "meta.json", exp, sig)).toBeNull();
    rig.clock.t += 11 * 60_000;
    expect(await rig.service.file(ALICE, sid as string, name as string, exp, sig)).toBeNull();
  });

  it("sings in another key: the worker's backing in it, and the reference moved with it", async () => {
    const id = await ready(rig);
    await expect(rig.service.start(ALICE, "Alice", id, 7)).rejects.toMatchObject({ status: 400 });
    const session = await rig.service.start(ALICE, "Alice", id, 3);
    expect(session.shift).toBe(3);
    const url = new URL(session.backing_url, "http://x");
    const [, , , , , sid, name] = url.pathname.split("/");
    expect(name).toBe("karaoke.k+3.m4a");
    const exp = url.searchParams.get("exp") ?? undefined;
    const sig = url.searchParams.get("sig") ?? undefined;
    expect(await rig.service.file(ALICE, sid as string, name as string, exp, sig)).toMatchObject({
      type: "audio/mp4",
    });
    expect(rig.worker.keys).toEqual([`${rig.store.song(id)?.worker_song}/3`]);
    // The same key again is not made again; the key is only this session's.
    const other = await rig.service.start(ALICE, "Alice", id, 3);
    expect(rig.worker.keys).toHaveLength(1);
    const plain = await rig.service.start(ALICE, "Alice", id);
    expect(plain.backing_url).toContain("karaoke.m4a");
    expect(await rig.service.file(ALICE, plain.session, "karaoke.k+3.m4a", exp, sig)).toBeNull();
    // Sung three semitones up, it scores as the song; the song's own key does not.
    const up = humanSinger(song);
    const shifted = { ...up, midi: up.midi.map((m) => (m === null ? null : m + 3)) };
    const rec = new TrackRecorder(shifted.hz);
    shifted.midi.forEach((m, j) => {
      rec.push(j / shifted.hz, m);
    });
    const body = {
      track: rec.encode(),
      latency_ms: 0,
      calibrated: true,
      client_total: null,
      browser: "",
    };
    rig.clock.t += rec.seconds * 1000 + 2000;
    expect((await rig.service.submit(ALICE, other.session, body)).total).toBeGreaterThan(85);
    expect((await rig.service.submit(ALICE, plain.session, body)).total).toBeLessThan(50);
    rig.worker.keyFails = true;
    await expect(rig.service.start(ALICE, "Alice", id, -2)).rejects.toMatchObject({ status: 503 });
  });

  it("scores the track again, keeps it, tells her once and counts it as singing together", async () => {
    const id = await ready(rig);
    const { result } = await sing(rig, id);
    expect(result.total).toBeGreaterThan(85);
    expect(result.unranked).toBe(false);
    expect(result.phrases).toHaveLength(song.lines.length);
    expect(result.phrases[0]?.text).toBe("第 1 句");
    expect(result.comment.state).toBe("waiting");
    expect(result.best_before).toBeNull();
    expect(rig.notes).toHaveLength(1);
    const note = rig.notes[0] as KaraokeNote;
    expect(note.context).toEqual({
      platform: "discord",
      scope: "111111",
      channel: "222222",
      kind: "channel",
    });
    expect(note.summary).toContain(`系統分數 ${result.total} 分`);
    expect(note.summary).toContain("第一次唱這首");
    expect(rig.together).toEqual([
      { person: "p-alice", detail: expect.stringContaining("測試的歌") },
    ]);
    // Her next turn in that channel is her comment.
    rig.service.heard(
      { platform: "discord", scope: "111111", channel: "222222", kind: "channel" },
      "唱得好穩!",
    );
    const again = rig.service.result(ALICE, result.session);
    expect(again.comment).toEqual({ state: "said", text: "唱得好穩!" });
    expect(rig.service.overview(ALICE).recent[0]).toMatchObject({ session: result.session });
    expect(() => rig.service.result(BOB, result.session)).toThrow(KaraokeError);
  });

  it("takes a track once, never too soon, and never a broken one", async () => {
    const id = await ready(rig);
    const { session } = await sing(rig, id);
    await expect(
      rig.service.submit(ALICE, session.session, {
        track: "AAAA",
        latency_ms: 0,
        calibrated: true,
        client_total: null,
        browser: "",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const fresh = await rig.service.start(ALICE, "Alice", id);
    const rec = new TrackRecorder(100);
    for (const [j, m] of humanSinger(song).midi.entries()) rec.push(j / 100, m);
    await expect(
      rig.service.submit(ALICE, fresh.session, {
        track: rec.encode(),
        latency_ms: 0,
        calibrated: true,
        client_total: null,
        browser: "",
      }),
    ).rejects.toMatchObject({ status: 409, message: "這一次的時間對不上,沒有收" });
    await expect(
      rig.service.submit(ALICE, fresh.session, {
        track: "@@@",
        latency_ms: 0,
        calibrated: true,
        client_total: null,
        browser: "",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      rig.service.submit(BOB, fresh.session, {
        track: "AAAA",
        latency_ms: 0,
        calibrated: true,
        client_total: null,
        browser: "",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("marks a track copied from the reference unranked, and never a best", async () => {
    const id = await ready(rig);
    const first = await sing(rig, id);
    const copied = await sing(rig, id, copySinger(song, 100));
    expect(copied.result.unranked).toBe(true);
    expect(copied.result.best_before).toBe(first.result.total);
    const third = await sing(rig, id);
    expect(third.result.best_before).toBe(first.result.total);
    expect(rig.service.song(ALICE, id).best).toBe(first.result.total);
    expect(rig.service.song(ALICE, id).sung).toBe(3);
    expect(rig.service.adminResults().results[1]).toMatchObject({
      unranked: true,
      reasons: expect.arrayContaining([expect.any(String)]),
    });
  });

  it("only lets her know when there is no comment channel", async () => {
    rig = await makeRig({ comment_channel: "" });
    const id = await ready(rig);
    const { result } = await sing(rig, id);
    expect(result.comment).toEqual({ state: "none", text: null });
    expect(rig.notes[0]?.context).toBeNull();
  });
});

describe("upkeep", () => {
  it("gives up on a comment, deletes old tracks and idle files", async () => {
    const id = await ready(rig);
    const { result } = await sing(rig, id);
    rig.clock.t += COMMENT_WAIT_MS + 1000;
    await rig.service.tick(signal, true);
    expect(rig.service.result(ALICE, result.session).comment.state).toBe("none");
    rig.clock.t += Math.max(TRACK_KEEP_MS, FILES_KEEP_MS) + 1000;
    await rig.service.tick(signal, true);
    expect(rig.store.latest(5)[0]?.track).toBeNull();
    expect(rig.store.result(result.session)).not.toBeNull();
    await expect(readdir(join(rig.dir, id))).rejects.toThrow();
    // Sung again: the files come back from the worker.
    await sing(rig, id);
    expect((await readdir(join(rig.dir, id))).length).toBe(2);
  });

  it("forgets a person's singing, and keeps the songs", async () => {
    const id = await ready(rig);
    await sing(rig, id);
    const counts = rig.store.forgetPerson(["p-alice"]);
    expect(counts).toMatchObject({ karaoke_results: 1, karaoke_sessions: 1, karaoke_tracks: 1 });
    expect(rig.store.song(id)?.requested_by).toBeNull();
    expect(rig.service.overview(ALICE).recent).toEqual([]);
  });
});
