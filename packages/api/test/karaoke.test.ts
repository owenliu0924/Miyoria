// Karaoke's routes, and the offline end-to-end check without people (docs/design/karaoke.md
// 「做了什麼(第一步)」): a song prepared by a song worker in memory, fetched through the member
// routes and the signed file links, then a "singer" made from the reference curve itself (and
// detuned, late and noisy ones) recorded the way the browser records, encoded, sent through the
// route, and scored again by Core with the shared module. The scores have to make sense.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contract,
  type KaraokeResult,
  type KaraokeSession,
  routeMeta,
} from "@miyoria/contracts/api";
import { WorkersKaraokeReferenceSchema } from "@miyoria/contracts/workers";
import {
  KaraokeConfigSchema,
  KaraokeKey,
  KaraokeService,
  KaraokeStore,
  karaokeSchema,
} from "@miyoria/play/karaoke";
import { type PitchTrack, TrackRecorder } from "@miyoria/play/karaoke/score";
import {
  FAKE_BACKING,
  FakeKaraokeWorker,
  humanSinger,
  noiseSinger,
  referenceOf,
  synthSong,
} from "@miyoria/play/karaoke/testing";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { AuthorizerKey } from "@miyoria/types";
import type { AnyRouter } from "@orpc/server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { karaokeAdminRpc, karaokeRoutes, karaokeRpc } from "../src/karaoke-routes.js";
import { rpcRoutes, tableRoutes } from "../src/rpc.js";
import type { ApiEnv } from "../src/state.js";

const ALICE = { platform: "discord", id: "1" };
const BOB = { platform: "discord", id: "2" };
const T0 = Date.UTC(2026, 10, 18, 4, 0, 0);
const song = synthSong(4, 8);

interface Rig {
  hono: Hono<ApiEnv>;
  service: KaraokeService;
  worker: FakeKaraokeWorker;
  clock: { t: number };
  /** Who the next request is from. */
  as: { account: typeof ALICE };
  raw: TestDb;
  dir: string;
}

let rig: Rig;

beforeEach(async () => {
  const raw = openTestDb({ plugins: [karaokeSchema] });
  const worker = new FakeKaraokeWorker();
  const clock = { t: T0 };
  const dir = await mkdtemp(join(tmpdir(), "karaoke-api-"));
  const service = new KaraokeService({
    config: KaraokeConfigSchema.parse({ comment_channel: "discord:111111:222222" }),
    store: new KaraokeStore(raw.db, raw.events),
    worker: () => worker,
    now: () => clock.t,
    cacheDir: dir,
    who: (account) => ({ person: `p-${account.id}`, blocked: false }),
    tell: () => {},
    together: () => {},
    log: { info: () => {}, warn: () => {} },
  });
  const as = { account: ALICE };
  const state = {
    publicSide: { config: { enabled: true }, admitMember: () => null },
    optional: (key: unknown) => (key === AuthorizerKey ? { allows: () => true } : undefined),
    service: (key: unknown, what: string) => {
      if (key === KaraokeKey) return service;
      throw ApiError.unavailable(`${what} is not available`);
    },
  };
  const table: AnyRouter = { karaoke: karaokeRpc, karaokeAdmin: karaokeAdminRpc };
  const hono = new Hono<ApiEnv>();
  const all = [
    ...tableRoutes(state as never, table, { responseCheck: "strict" }),
    ...karaokeRoutes(state as never),
  ];
  for (const r of all) {
    hono.on(r.method, r.path, async (c) => {
      if (r.member) c.set("member", { account: as.account, name: "Alice" } as never);
      try {
        return await r.handler(c);
      } catch (error) {
        return error instanceof ApiError
          ? error.toResponse()
          : ApiError.internal(error).toResponse();
      }
    });
  }
  rig = { hono, service, worker, clock, as, raw, dir };
});

afterEach(async () => {
  rig.raw.close();
  await rm(rig.dir, { recursive: true, force: true });
});

const post = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

async function call<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await rig.hono.request(path, init);
  const text = await res.text();
  return { status: res.status, body: (text === "" ? null : JSON.parse(text)) as T };
}

/** A song asked for through the route and finished by the worker; its id. */
async function prepared(): Promise<string> {
  const asked = await call<{ song: { id: string }; created: boolean }>(
    "/api/member/karaoke/songs",
    post({ text: "https://youtu.be/e2e" }),
  );
  expect(asked.status).toBe(200);
  expect(asked.body.created).toBe(true);
  const [job] = [...rig.worker.jobs.keys()];
  rig.worker.finish(job as string, referenceOf(song, "k-e2e"));
  // The module's pass, once.
  await rig.service.tick(new AbortController().signal);
  return asked.body.song.id;
}

/**
 * One singing through the routes, the way the page does it: start, fetch the reference and the
 * backing through their signed links, record the detections at 100 Hz, wait the song's length,
 * send the encoded track.
 */
async function singThrough(
  songId: string,
  singer: PitchTrack,
  latency_ms: number,
  calibrated = true,
): Promise<KaraokeResult> {
  const started = await call<KaraokeSession>(
    `/api/member/karaoke/songs/${songId}/sessions`,
    post({}),
  );
  expect(started.status).toBe(200);
  const refRes = await rig.hono.request(started.body.reference_url);
  expect(refRes.status).toBe(200);
  expect(refRes.headers.get("content-type")).toBe("application/json");
  expect(refRes.headers.get("content-disposition")).toBeNull();
  const reference = WorkersKaraokeReferenceSchema.parse(await refRes.json());
  const backing = await rig.hono.request(started.body.backing_url);
  expect(backing.headers.get("content-type")).toBe("audio/mp4");
  expect(new Uint8Array(await backing.arrayBuffer())).toEqual(FAKE_BACKING);
  const rec = new TrackRecorder(100);
  singer.midi.forEach((m, j) => {
    rec.push(j / singer.hz, m);
  });
  expect(rec.seconds).toBeLessThanOrEqual(reference.duration_s + 1);
  rig.clock.t += reference.duration_s * 1000 + 3000;
  const sent = await call<KaraokeResult>(
    `/api/member/karaoke/sessions/${started.body.session}/result`,
    post({ track: rec.encode(), latency_ms, calibrated, client_total: null, browser: "test" }),
  );
  expect(sent.status).toBe(200);
  return sent.body;
}

describe("the karaoke routes", () => {
  it("are member routes, limited; the owner's list is an admin route", () => {
    for (const name of ["overview", "request", "song", "start", "submit", "result"]) {
      expect(routeMeta(contract, ["karaoke", name])).toEqual({
        audience: "member",
        permission: null,
        limited: true,
      });
    }
    expect(routeMeta(contract, ["karaokeAdmin", "results"])).toEqual({
      audience: "admin",
      permission: null,
    });
  });

  it("go away with the public side's switch, the owner's stays", () => {
    const off = { publicSide: { config: { enabled: false } }, optional: () => undefined };
    const paths = rpcRoutes(off as never).map((r) => r.path);
    expect(paths).not.toContain("/api/member/karaoke");
    expect(paths).toContain("/api/karaoke/results");
    expect(karaokeRoutes(off as never)).toEqual([]);
  });

  it("answer a refusal with its status and sentence, and a stranger's link with a 404", async () => {
    const id = await prepared();
    const bad = await call<{ error: string }>("/api/member/karaoke/songs/nope");
    expect(bad).toMatchObject({ status: 404, body: { error: "沒有這首歌" } });
    const started = await call<KaraokeSession>(
      `/api/member/karaoke/songs/${id}/sessions`,
      post({}),
    );
    rig.as.account = BOB;
    expect((await rig.hono.request(started.body.backing_url)).status).toBe(404);
    const theirs = await call(`/api/member/karaoke/sessions/${started.body.session}`);
    expect(theirs.status).toBe(404);
    const overview = await call<{ songs: { id: string; state: string }[] }>("/api/member/karaoke");
    expect(overview.body.songs).toEqual([expect.objectContaining({ id, state: "ready" })]);
  });
});

describe("offline end to end: encoder, route, Core's score", () => {
  it("scores the reference sung back high (and flags the exact copy), a detuned or noisy one low", async () => {
    const id = await prepared();
    // The reference curve itself, as a program would send it: high, and unranked.
    const copy = await singThrough(id, { hz: 50, midi: song.reference.midi.map((m) => m) }, 0);
    expect(copy.total).toBeGreaterThan(90);
    expect(copy.unranked).toBe(true);
    // A good human-like singer on a device 150 ms late, calibrated: high, steady, ranked.
    const good = await singThrough(id, humanSinger(song, { lateMs: 150 }), 150);
    expect(good.total).toBeGreaterThan(85);
    expect(good.unranked).toBe(false);
    expect(good.rhythm.feel).toBe("steady");
    expect(good.comment.state).toBe("waiting");
    // The same singer whose latency was not taken out: late.
    const late = await singThrough(id, humanSinger(song, { lateMs: 150 }), 0);
    expect(late.rhythm.feel).toBe("late");
    expect(late.total).toBeLessThan(good.total);
    // Without calibration, rhythm stands in for pitch and says nothing about timing.
    const uncalibrated = await singThrough(id, humanSinger(song), 0, false);
    expect(uncalibrated.rhythm.measured).toBe(false);
    // A semitone sharp all the way: the pitch part is gone.
    const detuned = await singThrough(id, humanSinger(song, { transpose: 1 }), 0);
    expect(detuned.pitch.score).toBeLessThan(5);
    expect(detuned.total).toBeLessThan(40);
    // Noise.
    const noisy = await singThrough(id, noiseSinger(song, 11, 0.7), 0);
    expect(noisy.total).toBeLessThan(15);
    // An octave low is as good as in the original octave.
    const low = await singThrough(id, humanSinger(song, { transpose: -12 }), 0);
    expect(low.facts.octave).toBe(-1);
    const same = await singThrough(id, humanSinger(song), 0);
    expect(Math.abs(low.total - same.total)).toBeLessThanOrEqual(1);
    // The owner sees the flag; the member's list has every result.
    const admin = await call<{ results: { unranked: boolean }[] }>("/api/karaoke/results");
    expect(admin.body.results.filter((r) => r.unranked)).toHaveLength(1);
    const mine = await call<{ recent: unknown[] }>("/api/member/karaoke");
    expect(mine.body.recent).toHaveLength(8);
  });
});
