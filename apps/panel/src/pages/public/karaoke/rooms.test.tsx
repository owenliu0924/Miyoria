// Rooms (step 4) on screen: a singer's stage shows their trend and never a ranking (even if a board
// reached it), a spectator's stage shows the live ranking, the round's results, opening a room
// (price and balance before paying), the admin's notice while karaoke is closed, and the recording
// sent only when Core asks for it (and asked for again on a later look).

import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KaraokeOverview,
  KaraokeResult,
  KaraokeRoomEvent,
  KaraokeRoomView,
  KaraokeSession,
  KaraokeSongView,
} from "@miyoria/contracts/api";
import type { WorkersKaraokeReferenceV2 } from "@miyoria/contracts/workers/karaoke";
import { encodeTrack, toBase64 } from "@miyoria/play/karaoke/score";
import { mockFetch, renderPage } from "@/test/render";
import type { KaraokeEngine, MicStream } from "./audio";
import { KaraokePage } from "./KaraokePage";
import type { StreamPiece } from "./mulaw";
import type { Detection } from "./pitch";
import { Result } from "./Result";
import { type RoomEventsHandlers, setRoomEventsFactory } from "./room-api";
import { RoomPage } from "./RoomPage";

// The generated route table may not list the rooms yet (`pnpm contracts:gen`): the test adds them
// from the contract itself, as the generator would (method, path, metadata).
vi.mock("@miyoria/contracts/schema/api.routes.json", async (importOriginal) => {
  const original = (await importOriginal()) as { default?: { contract: Record<string, unknown> }; contract?: Record<string, unknown> };
  const table = (original.default ?? original) as { contract: Record<string, unknown> };
  const { karaokeRooms } = (await import("@miyoria/contracts/api")).contract;
  const routes = Object.fromEntries(
    Object.entries(karaokeRooms).map(([name, proc]) => {
      const orpc = (proc as unknown as { "~orpc": { route: object; meta: object } })["~orpc"];
      return [name, { "~orpc": { errorMap: {}, meta: orpc.meta, route: { inputStructure: "detailed", ...orpc.route } } }];
    }),
  );
  const merged = { ...table, contract: { ...table.contract, karaokeRooms: routes } };
  return { ...merged, default: merged };
});

const MEMBER = { name: "小魚乾", avatar_url: null };

// ---- the room's event stream, by hand ---------------------------------------------------------

const handlers = new Set<RoomEventsHandlers>();
setRoomEventsFactory((_url, h) => {
  handlers.add(h);
  return () => handlers.delete(h);
});
const emit = (e: KaraokeRoomEvent) =>
  act(() => {
    for (const h of handlers) h.onEvent(e);
  });

// ---- fixtures -----------------------------------------------------------------------------------

const song = (over: Partial<KaraokeSongView> = {}): KaraokeSongView => ({
  id: "k1",
  title: "紙船",
  artist: "示範",
  duration_s: 30,
  state: "ready",
  stage: null,
  progress: 1,
  position: null,
  error: null,
  lyrics: true,
  lyrics_source: "found",
  notes: 1,
  video: false,
  mine: false,
  best: null,
  sung: 0,
  ...over,
});

const session = (id = "S7"): KaraokeSession => ({
  session: id,
  song: song(),
  backing_url: `/api/member/karaoke/files/${id}/karaoke.m4a?sig=x`,
  reference_url: `/api/member/karaoke/files/${id}/reference.json?sig=x`,
  video_url: null,
  expires_at: "2026-11-18T02:00:00Z",
  tolerance_cents: 50,
  frame_hz: 50,
  shift: 0,
  recording: { max_bytes: 8_000_000, max_seconds: 600 },
});

const TERMS = { currency: "魚幣", price: 20, prize: 15, finish: 3, rounds: 5, max_singers: 8 };

const room = (over: Partial<KaraokeRoomView> = {}): KaraokeRoomView => ({
  code: "KTV888",
  state: "lobby",
  closed_reason: null,
  song: song(),
  shift: 0,
  members: [
    { id: "me", name: "小魚乾", role: "singer", ready: false, opener: true, color: 0 },
    { id: "a", name: "海苔", role: "singer", ready: true, opener: false, color: 1 },
    { id: "b", name: "路過的人", role: "spectator", ready: false, opener: false, color: 5 },
  ],
  me: { id: "me", role: "singer", opener: true, singing: false, session: null },
  round: 0,
  rounds_left: 5,
  start_at_ms: null,
  result: null,
  terms: TERMS,
  ...over,
});

const REFERENCE: WorkersKaraokeReferenceV2 = {
  format: "miyoria.karaoke.reference",
  version: 2,
  id: "k1",
  title: "紙船",
  artist: null,
  duration_s: 30,
  backing: "karaoke.m4a",
  pitch: { hz: 50, start: 0, midi: Array.from({ length: 1500 }, (_, i) => (i > 100 ? 60 + ((i / 50) % 3) : null)) },
  notes: [{ start: 2, end: 3, midi: 60, source: "pitch", line: null, char: null }],
  lyrics: null,
  quality: { ok: true, reason: null, voiced_ratio: 0.8, notes: 1, lead_split: true },
  made: { pitch: "t", notes: "t", lyrics: "t", asr: "t", aligner: "t" },
};

const BOARD: KaraokeRoomEvent = {
  type: "board",
  round: 1,
  at_ms: 0,
  lines: [
    { member: "a", name: "海苔", color: 1, rank: 1, total: 81.25, source: "voice", move: "up", pitch: { from: 0, track: toBase64(encodeTrack([60, 60, 61])) } },
    { member: "c", name: "Akari", color: 3, rank: 2, total: 77, source: "estimate", move: "down", pitch: null },
  ],
};

function fakeEngine() {
  const listeners = new Set<(d: Detection) => void>();
  const pieces: ((p: StreamPiece) => void)[] = [];
  const played: { at: number; offset: number }[] = [];
  const mic: MicStream = { start: (on) => void pieces.push(on), stop: () => {} };
  const engine: KaraokeEngine = {
    now: () => performance.now() / 1000,
    heard: () => performance.now() / 1000,
    estimateLatencyMs: () => 40,
    openMic: async () => ({}),
    setFloor: () => {},
    onDetection: (f) => {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    loadBacking: async () => 30,
    play: () => performance.now() / 1000 + 0.05,
    playAt: (at, offset) => {
      played.push({ at, offset });
      return { at, offset };
    },
    stop: () => {},
    beeps: () => {},
    recorder: () => null,
    micStream: async () => mic,
    close: () => {},
  };
  return { engine, played, pieces };
}

/** The room's routes; `view` is what `GET .../rooms/KTV888` answers. */
function roomSite(view: KaraokeRoomView, extra?: Parameters<typeof mockFetch>[0]) {
  const posts: { path: string; body: unknown }[] = [];
  const fn = mockFetch((method, url, body, headers) => {
    const path = url.pathname;
    if (method === "POST") posts.push({ path, body });
    const more = extra?.(method, url, body, headers);
    if (more) return more;
    if (path === "/api/member/karaoke/rooms/KTV888") return { body: view };
    if (path === "/api/member/karaoke/rooms/KTV888/clock") return { body: { t0: (body as { t0: number }).t0, server_ms: Date.now() } };
    if (path === "/api/member/karaoke/rooms/KTV888/audio") return { body: { stream: "live" } };
    if (path === "/api/member/karaoke/rooms/KTV888/pitch") return { status: 204 };
    if (path.endsWith("/reference.json")) return { body: REFERENCE };
    if (path === "/api/member/karaoke/songs/k1/sessions" && method === "POST") return { body: session("W1") };
    return undefined;
  });
  return { fn, posts };
}

const overview = (over: Partial<KaraokeOverview> = {}): KaraokeOverview => ({
  open: true,
  admin: false,
  preparing: true,
  songs: [song(), song({ id: "k2", title: "Lemon", artist: "米津玄師" })],
  limits: { daily: 10, used: 2, max_minutes: 8 },
  tolerance_cents: 50,
  comments: true,
  recent: [],
  ...over,
});

function renderRoom(engine: KaraokeEngine) {
  return renderPage(
    <RoomPage
      code="KTV888"
      overview={overview()}
      engine={() => engine}
      latency={{ latency_ms: 40, calibrated: true }}
      floor={null}
      prepareMic={async () => ({ latency_ms: 40, calibrated: true })}
      onCalibrate={() => {}}
      onExit={() => {}}
    />,
  );
}

beforeEach(() => {
  handlers.clear();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
});

describe("一起唱: a singer's stage", () => {
  it("starts at the room's moment, shows their trend, and never a ranking even if a board arrives", async () => {
    const view = room({
      state: "countdown",
      round: 1,
      start_at_ms: Date.now() + 3_000,
      me: { id: "me", role: "singer", opener: true, singing: true, session: session() },
    });
    roomSite(view);
    const { engine, played, pieces } = fakeEngine();
    const { container } = renderRoom(engine);
    await screen.findByRole("region", { name: "唱 紙船" });
    // Scheduled on the context's clock about three seconds out, from the song's start.
    await waitFor(() => expect(played).toHaveLength(1));
    const first = played[0] as { at: number; offset: number };
    expect(first.offset).toBe(0);
    expect(first.at - performance.now() / 1000).toBeGreaterThan(2.5);
    expect(first.at - performance.now() / 1000).toBeLessThan(3.2);
    // The microphone's stream begins with the song.
    await waitFor(() => expect(pieces).toHaveLength(1));
    expect(await screen.findByRole("timer")).toHaveTextContent("秒後一起開始");
    // No start button, no restart, no key control: the room decides.
    expect(screen.queryByRole("button", { name: "開始" })).toBeNull();
    expect(screen.queryByRole("button", { name: "從頭開始" })).toBeNull();
    expect(screen.queryByRole("group", { name: "升降調" })).toBeNull();

    emit({ type: "trend", round: 1, trend: "rising", source: "voice" });
    expect(await screen.findByRole("status", { name: "上升中,正式" })).toBeInTheDocument();
    emit({ type: "trend", round: 1, trend: "dropping", source: "estimate" });
    expect(await screen.findByRole("status", { name: "下降中,預估" })).toBeInTheDocument();

    emit(BOARD);
    expect(screen.queryByText("即時排名")).toBeNull();
    expect(container.querySelector("[data-board]")).toBeNull();
    expect(screen.queryByText("海苔")).toBeNull();
    expect(screen.queryByText("81.3")).toBeNull();
  });
});

describe("一起唱: a spectator's stage", () => {
  it("shows the live ranking with each singer's colour, movement and 預估", async () => {
    const view = room({
      state: "singing",
      round: 1,
      start_at_ms: Date.now() - 5_000,
      // The room's files to watch with (`me.session` while not singing).
      me: { id: "b", role: "spectator", opener: false, singing: false, session: session() },
    });
    const { posts } = roomSite(view);
    const { engine } = fakeEngine();
    renderRoom(engine);
    const stage = await screen.findByRole("region", { name: "看 紙船" });
    expect(within(stage).getByText("開始唱之後會出現")).toBeInTheDocument();
    emit(BOARD);
    const board = await within(stage).findByRole("list", { name: "即時排名" });
    const rows = within(board).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("1海苔81.3");
    expect(within(rows[0] as HTMLElement).getByLabelText("上升")).toHaveTextContent("↑");
    expect(rows[1]).toHaveTextContent("Akari");
    expect(rows[1]).toHaveTextContent("預估");
    expect(within(rows[1] as HTMLElement).getByLabelText("下降")).toBeInTheDocument();
    // The backing is off until asked for; the song's files come from the room, nothing is started
    // or sent.
    expect(within(stage).getByRole("button", { name: "聽伴奏" })).toHaveAttribute("aria-pressed", "false");
    expect(posts.some((p) => p.path === "/api/member/karaoke/songs/k1/sessions")).toBe(false);
    expect(posts.some((p) => p.path.endsWith("/result"))).toBe(false);
  });
});

describe("一起唱: the results", () => {
  it("shows the final ranking: places, the official score and its parts, 預估, checks, coins, the winner, notes", async () => {
    const view = room({
      state: "results",
      round: 1,
      result: {
        round: 1,
        song: { id: "k1", title: "紙船", artist: "示範" },
        settling: true,
        note: "這一輪只有一個人唱完,沒有獎",
        places: [
          { member: "a", name: "海苔", color: 1, rank: 1, total: 86.4, pitch: 52.1, stability: 13.2, rhythm: 12.8, expression: 8.3, source: "voice", finished: true, checks: [], coins: 18, winner: true, note: null },
          { member: "me", name: "小魚乾", color: 0, rank: 2, total: 74.9, pitch: 45, stability: 11.8, rhythm: 11, expression: 7.1, source: "estimate", finished: true, checks: ["bleed"], coins: 3, winner: false, note: "預估分數不能拿獎" },
          { member: "c", name: "Akari", color: 3, rank: null, total: null, pitch: null, stability: null, rhythm: null, expression: null, source: null, finished: false, checks: [], coins: 0, winner: false, note: null },
        ],
      },
    });
    roomSite(view);
    renderRoom(fakeEngine().engine);
    const ranking = await screen.findByRole("region", { name: "這一輪的名次" });
    expect(ranking).toHaveTextContent("第 1 輪 · 紙船");
    expect(within(ranking).getByRole("status")).toHaveTextContent("還在等正式分數,名次可能會變");
    const rows = within(ranking).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("海苔");
    expect(rows[0]).toHaveTextContent("贏了");
    expect(rows[0]).toHaveTextContent("86.4");
    expect(rows[0]).toHaveTextContent("音程 52.1 · 安定 13.2 · 節奏 12.8 · 表現 8.3");
    expect(rows[0]).toHaveTextContent("+18 魚幣");
    expect(rows[1]).toHaveTextContent("小魚乾(你)");
    expect(rows[1]).toHaveTextContent("預估");
    expect(rows[1]).toHaveTextContent("間奏也收到了音高");
    expect(rows[1]).toHaveTextContent("預估分數不能拿獎");
    expect(rows[2]).toHaveTextContent("—");
    expect(rows[2]).toHaveTextContent("沒有唱完");
    expect(ranking).toHaveTextContent("這一輪只有一個人唱完,沒有獎");
    // The opener picks the next song or closes.
    expect(screen.getByRole("button", { name: "選下一首" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "關房" })).toBeEnabled();
  });
});

describe("一起唱: the lobby", () => {
  it("lists who is in, their part and readiness; ready sends the device's latency", async () => {
    const view = room();
    const { posts } = roomSite(view, (method, url) =>
      url.pathname === "/api/member/karaoke/rooms/KTV888/ready" && method === "POST" ? { body: view } : undefined,
    );
    renderRoom(fakeEngine().engine);
    const members = await screen.findByRole("region", { name: "成員" });
    expect(within(members).getAllByRole("listitem")).toHaveLength(3);
    expect(members).toHaveTextContent("小魚乾(你)");
    expect(members).toHaveTextContent("唱 2 / 8");
    expect(screen.getByText("KTV888")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "準備好了" }));
    await waitFor(() => expect(posts.find((p) => p.path.endsWith("/ready"))).toBeDefined());
    expect(posts.find((p) => p.path.endsWith("/ready"))?.body).toEqual({ ready: true, latency_ms: 40, calibrated: true });
  });
});

describe("一起唱: opening a room", () => {
  function listSite(o: { balance: number | null; open?: Partial<KaraokeOverview> }) {
    const posts: { path: string; body: unknown }[] = [];
    mockFetch((method, url, body) => {
      const path = url.pathname;
      if (method === "POST") posts.push({ path, body });
      if (path === "/api/member/karaoke") return { body: overview(o.open) };
      if (path === "/api/member/karaoke/rooms" && method === "GET") {
        return { body: { available: true, reason: null, terms: TERMS, balance: o.balance, mine: null } };
      }
      if (path === "/api/member/karaoke/rooms" && method === "POST") return { body: room() };
      if (path === "/api/member/karaoke/rooms/KTV888") return { body: room() };
      return undefined;
    });
    return posts;
  }

  it("shows the price and the balance before paying, and pays only on the explicit button", async () => {
    window.history.replaceState(null, "", "/karaoke");
    const posts = listSite({ balance: 128 });
    renderPage(<KaraokePage member={MEMBER as never} home="/" />);
    const block = await screen.findByRole("region", { name: "一起唱" });
    await userEvent.click(await within(block).findByRole("button", { name: "開一間房" }));
    expect(block).toHaveTextContent("開房20 魚幣");
    expect(block).toHaveTextContent("你有128 魚幣");
    const dialog = await screen.findByRole("dialog", { name: "開一間房" });
    const price = within(dialog).getByLabelText("價錢");
    expect(price).toHaveTextContent("開房20 魚幣");
    expect(price).toHaveTextContent("你有128 魚幣");
    expect(price).toHaveTextContent("開房後108 魚幣");
    const pay = within(dialog).getByRole("button", { name: "付 20 魚幣開房" });
    // A song first.
    expect(pay).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("radio", { name: /Lemon/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "升半音" }));
    expect(posts.filter((p) => p.path === "/api/member/karaoke/rooms")).toHaveLength(0);
    await userEvent.click(pay);
    await waitFor(() => expect(posts.filter((p) => p.path === "/api/member/karaoke/rooms")).toHaveLength(1));
    expect(posts.find((p) => p.path === "/api/member/karaoke/rooms")?.body).toEqual({ song: "k2", shift: 1 });
    // And the room's own address.
    await waitFor(() => expect(window.location.pathname).toBe("/karaoke/room/KTV888"));
    window.history.replaceState(null, "", "/");
  });

  it("will not pay with too few coins", async () => {
    window.history.replaceState(null, "", "/karaoke");
    listSite({ balance: 15 });
    renderPage(<KaraokePage member={MEMBER as never} home="/" />);
    const block = await screen.findByRole("region", { name: "一起唱" });
    await userEvent.click(await within(block).findByRole("button", { name: "開一間房" }));
    const dialog = await screen.findByRole("dialog", { name: "開一間房" });
    await userEvent.click(within(dialog).getByRole("radio", { name: /Lemon/ }));
    expect(within(dialog).getByRole("button", { name: "付 20 魚幣開房" })).toBeDisabled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("魚幣不夠,開房要 20 魚幣");
  });

  it("joins by a code typed in any case", async () => {
    window.history.replaceState(null, "", "/karaoke");
    listSite({ balance: 128 });
    renderPage(<KaraokePage member={MEMBER as never} home="/" />);
    const block = await screen.findByRole("region", { name: "一起唱" });
    await userEvent.type(await within(block).findByLabelText("房號或連結"), "ktvo88");
    await userEvent.click(within(block).getByRole("button", { name: "加入" }));
    expect(within(block).getByRole("alert")).toHaveTextContent("房號是 6 個英文字母和數字");
    await userEvent.clear(within(block).getByLabelText("房號或連結"));
    await userEvent.type(within(block).getByLabelText("房號或連結"), "ktv888");
    await userEvent.click(within(block).getByRole("button", { name: "加入" }));
    await waitFor(() => expect(window.location.pathname).toBe("/karaoke/room/KTV888"));
    window.history.replaceState(null, "", "/");
  });
});

describe("唱歌 while it is closed", () => {
  it("is closed to members, and open to an admin with a quiet line", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/member/karaoke" ? { body: overview({ open: false }) } : undefined));
    const closed = renderPage(<KaraokePage member={MEMBER as never} home="/" />);
    expect(await screen.findByText("現在沒有開放唱歌")).toBeInTheDocument();
    expect(screen.queryByText("還沒開放,只有管理員能用")).toBeNull();
    closed.unmount();

    mockFetch((_m, url) => (url.pathname === "/api/member/karaoke" ? { body: overview({ open: false, admin: true }) } : undefined));
    renderPage(<KaraokePage member={MEMBER as never} home="/" />);
    expect(await screen.findByText("還沒開放,只有管理員能用")).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "可以唱的歌" })).toHaveTextContent("Lemon");
    expect(screen.queryByText("現在沒有開放唱歌")).toBeNull();
  });
});

describe("the recording goes only when Core asks for it", () => {
  const result = (voice: Partial<KaraokeResult["voice"]>): KaraokeResult =>
    ({
      session: "S1",
      source: "estimate",
      voice: { state: "waiting", estimate_total: null, checks: [], upload: false, ...voice },
      song: { id: "k1", title: "紙船", artist: null },
      at: "2026-11-18T01:00:00Z",
      total: 70,
      pitch: { score: 40, max: 60, hit: 0.7 },
      stability: { score: 10, max: 15, wobble_cents: 20, held: 3 },
      rhythm: { score: 10, max: 15, calibrated: true, measured: true, offset_ms: 10, spread_ms: 30, onsets: 9, found: 8, feel: "steady" },
      expression: { score: 10, max: 10, vibrato_s: 1, long_tones: 1, scoops: 0, falls: 0 },
      phrases: [],
      facts: { coverage: 0.9, best: null, weakest: null, octave: 0, offset_cents: null, sung_s: 20, reference_s: 22 },
      unranked: false,
      client_total: 70,
      latency_ms: 40,
      best_before: null,
      comment: { state: "none", text: null },
    }) as KaraokeResult;

  const pending = {
    session: "S1",
    song: { id: "k1", title: "紙船", artist: null },
    body: { track: "AAAA", latency_ms: 40, calibrated: true, client_total: 70, browser: "Chrome 131", recording: true },
    provisional: null,
    lines: [],
    voice: { blob: new Blob([new Uint8Array(16)], { type: "audio/webm" }), type: "audio/webm", offset_ms: 5 },
  };

  it("not while the stream holds, and then when a later look asks for it", async () => {
    const uploads: string[] = [];
    let looks = 0;
    mockFetch((method, url) => {
      if (url.pathname === "/api/member/karaoke/sessions/S1/result" && method === "POST") return { body: result({ upload: false }) };
      if (url.pathname === "/api/member/karaoke/sessions/S1/voice" && method === "POST") {
        uploads.push(url.search);
        return { status: 202, body: { state: "scoring" } };
      }
      if (url.pathname === "/api/member/karaoke/sessions/S1") {
        looks++;
        // The stream was lost after all: Core wants the recording.
        return { body: result({ upload: looks >= 1 }) };
      }
      return undefined;
    });
    renderPage(<Result session="S1" title="紙船" artist={null} pending={pending} onAgain={() => {}} onBack={() => {}} />);
    await screen.findByLabelText("預估 70.0");
    await waitFor(() => expect(looks).toBeGreaterThan(0), { timeout: 5_000 });
    await waitFor(() => expect(uploads).toEqual(["?offset_ms=5"]));
  }, 10_000);

  it("never when Core does not ask", async () => {
    const uploads: string[] = [];
    mockFetch((method, url) => {
      if (url.pathname === "/api/member/karaoke/sessions/S1/result" && method === "POST") {
        return { body: result({ state: "scoring", upload: false }) };
      }
      if (url.pathname === "/api/member/karaoke/sessions/S1/voice") uploads.push(url.search);
      if (url.pathname === "/api/member/karaoke/sessions/S1") return { body: result({ state: "scoring", upload: false }) };
      return undefined;
    });
    renderPage(<Result session="S1" title="紙船" artist={null} pending={pending} onAgain={() => {}} onBack={() => {}} />);
    await screen.findByLabelText("預估 70.0");
    await new Promise((r) => setTimeout(r, 300));
    expect(uploads).toEqual([]);
  });
});
