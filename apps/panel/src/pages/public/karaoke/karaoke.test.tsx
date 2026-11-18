// 唱歌 (`/karaoke`): the song list with its search, asking for a song, a song being prepared or
// failed, the closed states, and the result with her comment. The audio is not reached here.

import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { KaraokeOverview, KaraokeResult, KaraokeSongView } from "@miyoria/contracts/api";
import { App } from "@/app/App";
import { createAppRouter } from "@/app/router";
import { mockFetch, renderPage } from "@/test/render";
import { KaraokePage } from "./KaraokePage";
import { Result } from "./Result";

const MEMBER = { name: "小魚乾", avatar_url: null };

const song = (over: Partial<KaraokeSongView> = {}): KaraokeSongView => ({
  id: "k1",
  title: "夜に駆ける",
  artist: "YOASOBI",
  duration_s: 261,
  state: "ready",
  stage: null,
  progress: 1,
  position: null,
  error: null,
  lyrics: true,
  lyrics_source: "found",
  notes: 240,
  mine: false,
  best: 82.4,
  sung: 3,
  ...over,
});

const overview = (over: Partial<KaraokeOverview> = {}): KaraokeOverview => ({
  open: true,
  preparing: true,
  songs: [
    song(),
    song({ id: "k2", title: "Lemon", artist: "米津玄師", best: null, sung: 0, lyrics: false, duration_s: 255 }),
    song({
      id: "k3",
      title: "怪物",
      artist: null,
      state: "preparing",
      stage: "separate",
      progress: 0.42,
      position: 2,
      mine: true,
      best: null,
      sung: 0,
    }),
    song({
      id: "k4",
      title: "很長的歌",
      artist: null,
      state: "failed",
      error: "這首超過 8 分鐘,沒有準備",
      mine: true,
      best: null,
      sung: 0,
    }),
  ],
  limits: { daily: 10, used: 2, max_minutes: 8 },
  tolerance_cents: 50,
  comments: true,
  recent: [{ session: "S0", song: "k1", title: "夜に駆ける", total: 82.4, unranked: false, at: "2026-11-17T12:00:00Z" }],
  ...over,
});

interface Options {
  overview?: KaraokeOverview;
  status?: number;
  /** What `GET /songs/k3` answers, in turn. */
  preparing?: KaraokeSongView[];
  request?: { status?: number; body: unknown };
}

function karaoke(o: Options = {}) {
  const posts: { path: string; body: unknown; csrf: string | null }[] = [];
  let polled = 0;
  const fn = mockFetch((method, url, body, headers) => {
    const path = url.pathname;
    if (method === "POST") posts.push({ path, body, csrf: headers.get("X-Miyoria-Request") });
    if (!path.startsWith("/api/member/karaoke")) return undefined;
    if (o.status) return { status: o.status, body: { error: "karaoke module is not available" } };
    if (path === "/api/member/karaoke") return { body: o.overview ?? overview() };
    if (path === "/api/member/karaoke/songs" && method === "POST") {
      return o.request ?? { body: { song: song({ id: "k9", title: "新的歌", state: "preparing", mine: true }), created: true } };
    }
    if (path === "/api/member/karaoke/songs/k3") {
      const list = o.preparing ?? [];
      const at = Math.min(polled++, list.length - 1);
      return { body: list[at] ?? overview().songs[2] };
    }
    return undefined;
  });
  return { fn, posts };
}

const listed = async () => screen.findByRole("region", { name: "可以唱的歌" });

describe("唱歌: picking a song", () => {
  it("lists the ready songs with their length, lyrics, best and times sung, and searches them", async () => {
    karaoke();
    renderPage(<KaraokePage member={MEMBER as never} home="/" />);
    const list = await listed();
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("夜に駆ける");
    expect(rows[0]).toHaveTextContent("4:21");
    expect(rows[0]).toHaveTextContent("有歌詞");
    expect(rows[0]).toHaveTextContent("最好 82.4");
    expect(rows[0]).toHaveTextContent("唱過 3 次");
    expect(rows[1]).toHaveTextContent("只有旋律");
    expect(rows[1]).not.toHaveTextContent("最好");
    expect(within(list).getByRole("button", { name: "唱 Lemon" })).toBeEnabled();

    await userEvent.type(within(list).getByLabelText("找歌名或歌手"), "米津");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByRole("listitem")).toHaveTextContent("Lemon");
    await userEvent.clear(within(list).getByLabelText("找歌名或歌手"));
    await userEvent.type(within(list).getByLabelText("找歌名或歌手"), "沒有這首");
    expect(list).toHaveTextContent("沒有符合的歌");
  });

  it("says when a song's lyrics are what was heard", async () => {
    karaoke({ overview: overview({ songs: [song({ lyrics_source: "heard" })] }) });
    renderPage(<KaraokePage member={MEMBER as never} home="/" />);
    const list = await listed();
    expect(within(list).getByRole("listitem")).toHaveTextContent("聽寫的歌詞");
  });

  it("shows their song being prepared, its stage, how far and its place, until it is ready", async () => {
    const { fn } = karaoke({ preparing: [song({ id: "k3", title: "怪物", state: "ready", mine: true })] });
    renderPage(<KaraokePage member={MEMBER as never} home="/" />);
    const part = await screen.findByRole("region", { name: "準備中的歌" });
    const row = within(part).getByText("怪物").closest("li") as HTMLElement;
    expect(row).toHaveTextContent("分離人聲 · 前面還有 2 首");
    expect(row).toHaveTextContent("42%");
    expect(within(row).getByRole("meter")).toHaveAttribute("aria-valuenow", "0.42");
    // Asked again every two seconds; once it is ready, the list is asked again.
    const calls = (end: string) => fn.mock.calls.filter(([u]) => String(u).endsWith(end)).length;
    const before = calls("/api/member/karaoke");
    await waitFor(() => expect(calls("/api/member/karaoke/songs/k3")).toBe(1), { timeout: 3000 });
    await waitFor(() => expect(calls("/api/member/karaoke")).toBeGreaterThan(before));
  });

  it("shows why a song failed and asks for it again with the same words", async () => {
    const { posts } = karaoke();
    renderPage(<KaraokePage member={MEMBER as never} home="/" />);
    const part = await screen.findByRole("region", { name: "準備中的歌" });
    expect(within(part).getByRole("alert")).toHaveTextContent("這首超過 8 分鐘,沒有準備");
    await userEvent.click(within(part).getByRole("button", { name: "再試一次" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ path: "/api/member/karaoke/songs", body: { text: "很長的歌" }, csrf: "1" });
  });

  it("asks for a new song by link or name, with the day's limit, and shows the Core's refusal", async () => {
    const { posts } = karaoke({ request: { status: 409, body: { error: "今天已經準備了 10 首,明天再來" } } });
    renderPage(<KaraokePage member={MEMBER as never} home="/" />);
    const ask = await screen.findByRole("region", { name: "點歌" });
    expect(ask).toHaveTextContent("今天 2 / 10 首 · 一首最長 8 分鐘");
    const send = within(ask).getByRole("button", { name: "準備這首" });
    expect(send).toBeDisabled();
    await userEvent.type(within(ask).getByLabelText("貼連結或打歌名"), "https://youtu.be/x");
    await userEvent.click(send);
    await waitFor(() => expect(within(ask).getByRole("alert")).toHaveTextContent("今天已經準備了 10 首,明天再來"));
    expect(posts[0]).toEqual({ path: "/api/member/karaoke/songs", body: { text: "https://youtu.be/x" }, csrf: "1" });
  });

  it("says when new songs cannot be prepared but ready ones can be sung", async () => {
    karaoke({ overview: overview({ preparing: false }) });
    renderPage(<KaraokePage member={MEMBER as never} home="/" />);
    const ask = await screen.findByRole("region", { name: "點歌" });
    expect(ask).toHaveTextContent("現在沒辦法準備新的歌,準備好的歌還是可以唱");
    expect(within(ask).queryByRole("textbox")).toBeNull();
    expect(await listed()).toHaveTextContent("Lemon");
  });

  it("is a calm line when singing is closed or the module is off", async () => {
    karaoke({ overview: overview({ open: false }) });
    const first = renderPage(<KaraokePage member={MEMBER as never} home="/" />);
    expect(await screen.findByText("現在沒有開放唱歌")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "點歌" })).toBeNull();
    first.unmount();
    karaoke({ status: 503 });
    renderPage(<KaraokePage member={MEMBER as never} home="/" />);
    expect(await screen.findByText("現在沒有開放唱歌")).toBeInTheDocument();
  });

  it("lists what they sang lately, and says when this browser cannot sing", async () => {
    karaoke();
    renderPage(<KaraokePage member={MEMBER as never} home="/me" />);
    const recent = await screen.findByRole("region", { name: "最近唱的" });
    expect(recent).toHaveTextContent("夜に駆ける");
    expect(recent).toHaveTextContent("82.4");
    // jsdom has no Web Audio.
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent("Chrome 或 Edge");
    expect(screen.getByRole("link", { name: "回到你的頁面" })).toHaveAttribute("href", "/me");
  });
});

describe("唱歌: the way there", () => {
  function site(member: boolean) {
    mockFetch((_method, url) => {
      const path = url.pathname;
      if (path === "/api/auth/methods") return { body: { token: true, discord: true } };
      if (path === "/api/auth/session") return { status: 401, body: { error: "no" } };
      if (path === "/api/public/status") {
        return { body: { state: "idle", live: false, in_voice: false, game: null, today: { songs_sung: 0, hours_live: 0, hours_in_voice: 0 } } };
      }
      if (path === "/api/member/session") {
        return member ? { body: { name: "小魚乾", avatar_url: null } } : { status: 401, body: { error: "not logged in" } };
      }
      if (path === "/api/member/karaoke") return { body: overview() };
      return undefined;
    });
  }
  const renderApp = () =>
    render(<App router={createAppRouter(createMemoryHistory({ initialEntries: [window.location.pathname] }))} />);

  afterEach(() => window.history.replaceState(null, "", "/"));

  it("is linked from the member page while karaoke is open", async () => {
    site(true);
    renderApp();
    expect(await screen.findByRole("link", { name: "唱歌" })).toHaveAttribute("href", "/karaoke");
  });

  it("opens at /karaoke for someone logged in", async () => {
    window.history.replaceState(null, "", "/karaoke");
    site(true);
    renderApp();
    expect(await screen.findByRole("heading", { level: 1, name: "唱歌" })).toBeInTheDocument();
    expect(await listed()).toHaveTextContent("Lemon");
  });

  it("is not there for someone not logged in", async () => {
    window.history.replaceState(null, "", "/karaoke");
    site(false);
    renderApp();
    await screen.findAllByRole("heading", { level: 1 });
    expect(screen.queryByRole("region", { name: "可以唱的歌" })).toBeNull();
  });
});

const coreResult =(over: Partial<KaraokeResult> = {}): KaraokeResult =>
  ({
    session: "S1",
    song: { id: "k1", title: "夜に駆ける", artist: "YOASOBI" },
    at: "2026-11-18T01:00:00Z",
    total: 78.6,
    pitch: { score: 45.2, max: 60, hit: 0.8 },
    stability: { score: 12.1, max: 15, wobble_cents: 16, held: 9 },
    rhythm: {
      score: 11.3,
      max: 15,
      calibrated: false,
      measured: false,
      offset_ms: null,
      spread_ms: null,
      onsets: 40,
      found: 0,
      feel: null,
    },
    expression: { score: 10, max: 10, vibrato_s: 6.2, long_tones: 3, scoops: 1, falls: 0 },
    phrases: [
      { index: 0, start: 12, end: 16, score: 91, hit: 0.9, sung: 1, text: "沈むように溶けてゆくように" },
      { index: 1, start: 16, end: 20, score: 54, hit: 0.5, sung: 0.8, text: "二人だけの空が広がる夜に" },
    ],
    facts: {
      coverage: 0.93,
      best: 0,
      weakest: 1,
      octave: 0,
      offset_cents: -8,
      sung_s: 180,
      reference_s: 190,
    },
    unranked: false,
    client_total: 78.4,
    latency_ms: 60,
    best_before: 72.1,
    comment: { state: "waiting", text: null },
    ...over,
  }) as KaraokeResult;

function results(answers: KaraokeResult[]) {
  let n = 0;
  const posts: unknown[] = [];
  mockFetch((method, url, body) => {
    if (url.pathname === "/api/member/karaoke/sessions/S1/result" && method === "POST") {
      posts.push(body);
      return { body: answers[0] };
    }
    if (url.pathname === "/api/member/karaoke/sessions/S1") {
      const r = answers[Math.min(n++, answers.length - 1)];
      return { body: r };
    }
    return undefined;
  });
  return { posts };
}

describe("唱歌: the result", () => {
  it("shows the total, the four parts in words, the phrases, and that she is thinking", async () => {
    results([coreResult()]);
    renderPage(<Result session="S1" title="夜に駆ける" artist="YOASOBI" onAgain={() => {}} onBack={() => {}} />);
    const total = await screen.findByLabelText("系統分數 78.6");
    expect(total).toBeInTheDocument();
    const parts = screen.getByRole("region", { name: "四個項目" });
    expect(within(parts).getByLabelText("音程")).toHaveTextContent("45.2 / 60");
    expect(within(parts).getByLabelText("音程")).toHaveTextContent("命中 80%");
    expect(within(parts).getByLabelText("節奏")).toHaveTextContent("沒有校正延遲,節奏照音程給分");
    expect(within(parts).getByLabelText("表現")).toHaveTextContent("顫音 6.2 秒 · 長音 3 個 · 往上滑進 1 次");
    expect(screen.getByText("新的最好成績")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "分數" })).toHaveTextContent("之前最好72.1");
    expect(screen.getByRole("region", { name: "分數" })).toHaveTextContent("唱到93%");
    const phrases = screen.getByRole("region", { name: "每一句" });
    const [best, weakest] = within(phrases).getAllByRole("listitem");
    expect(best).toHaveTextContent("沈むように溶けてゆくように");
    expect(best).toHaveTextContent("最好");
    expect(weakest).toHaveTextContent("最弱");
    expect(screen.getByRole("region", { name: "她的講評" })).toHaveTextContent("她正在想要說什麼");
    expect(screen.queryByText("沒有驗證")).toBeNull();
  });

  it("shows what she said, and an unchecked result as 沒有驗證 without a new best", async () => {
    results([coreResult({ unranked: true, comment: { state: "said", text: "最後那句很穩喔" } })]);
    renderPage(<Result session="S1" title="夜に駆ける" artist={null} onAgain={() => {}} onBack={() => {}} />);
    expect(await screen.findByText("最後那句很穩喔")).toBeInTheDocument();
    expect(screen.getByText("沒有驗證")).toBeInTheDocument();
    expect(screen.queryByText("新的最好成績")).toBeNull();
  });

  it("says nothing of her when she will not comment", async () => {
    results([coreResult({ comment: { state: "none", text: null } })]);
    renderPage(<Result session="S1" title="夜に駆ける" artist={null} onAgain={() => {}} onBack={() => {}} />);
    await screen.findByLabelText("系統分數 78.6");
    expect(screen.queryByRole("region", { name: "她的講評" })).toBeNull();
  });

  it("sends the track once and shows Core's number when it answers", async () => {
    const { posts } = results([coreResult({ total: 80.2 })]);
    const body = { track: "AAAA", latency_ms: 120, calibrated: true, client_total: 79.9, browser: "Chrome 131" };
    const pending = {
      session: "S1",
      song: { id: "k1", title: "夜に駆ける", artist: null },
      body,
      provisional: null,
      lines: [],
    };
    renderPage(
      <Result session="S1" title="夜に駆ける" artist={null} pending={pending} onAgain={() => {}} onBack={() => {}} />,
    );
    expect(await screen.findByLabelText("系統分數 80.2")).toBeInTheDocument();
    expect(posts).toEqual([body]);
  });
});
