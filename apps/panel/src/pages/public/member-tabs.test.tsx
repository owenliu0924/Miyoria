// The member area in tabs: which tab holds which block (every block that was on the old single
// page, each in exactly one tab), the addresses (each tab its own, old links landing on the right
// one), that only the open tab asks the Core and the push stream for anything, the keyboard, and
// the one place the server is chosen.

import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "@/app/App";
import { createAppRouter } from "@/app/router";
import { WORLD } from "@/lib/world";
import { answer as exchangeAnswer } from "./exchange/demo";
import { DEMO_LIVE_HELLO, type DemoOptions, memberDemoAnswer } from "./member-demo/fixtures";
import { isOwnPath, MEMBER_TABS, memberTabIn, memberTabPath, type SectionKey, tabSections } from "./member-tabs";
import { SECTIONS } from "./PublicSite";

/**
 * Every block the member page had before it was split into tabs, by its region name. A new block
 * goes into `SECTIONS` and a tab; this list only guards that none of these was dropped.
 */
const BEFORE_TABS = [
  // the main column
  "現場",
  "她眼中的你",
  "你和她說的話",
  "她這兩週",
  "現在",
  "一起的回憶",
  "你點的歌",
  "卡冊",
  "市集",
  WORLD.exchange_name,
  "預測",
  "商店",
  "今日籤詩",
  "贊助排行榜",
  "她的懸賞",
  "怎麼賺",
  "最近",
  "她收到的東西",
  "她做給我的",
  "歌單",
  // the rail
  "錢包",
  "送她禮物",
  "今天的任務",
  "她給你的卡",
  "轉給朋友",
  "點歌",
  "GitHub",
  "你的資料",
];

const placed = MEMBER_TABS.flatMap((t) => tabSections(t).map((key) => ({ tab: t.id, key })));
const labelOf = (key: SectionKey) => SECTIONS[key].label;

describe("which tab holds what", () => {
  it("places every block in exactly one tab", () => {
    const keys = Object.keys(SECTIONS) as SectionKey[];
    for (const key of keys) expect(placed.filter((p) => p.key === key), key).toHaveLength(1);
    expect(placed).toHaveLength(keys.length);
  });

  it("keeps every block of the old single page, each in one tab", () => {
    const labels = placed.map((p) => labelOf(p.key));
    for (const name of BEFORE_TABS) expect(labels.filter((l) => l === name), name).toHaveLength(1);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("has a handful of tabs, the overview first", () => {
    expect(MEMBER_TABS.length).toBeGreaterThanOrEqual(4);
    expect(MEMBER_TABS.length).toBeLessThanOrEqual(6);
    expect(MEMBER_TABS[0]?.id).toBe("overview");
    // What they can do today is on the first tab.
    const first = MEMBER_TABS[0] ? tabSections(MEMBER_TABS[0]) : [];
    expect(first).toEqual(expect.arrayContaining(["profile", "wallet", "quests", "now"]));
  });
});

describe("the addresses", () => {
  it("gives each tab its own, under /me", () => {
    expect(memberTabPath("overview")).toBe("/me");
    expect(memberTabPath("cards")).toBe("/me/cards");
    for (const t of MEMBER_TABS) expect(memberTabIn(memberTabPath(t.id))).toBe(t.id);
  });

  it("reads the old ones as the overview, and a tab that is not there as nothing", () => {
    expect(memberTabIn("/")).toBe("overview");
    expect(memberTabIn("/me")).toBe("overview");
    expect(memberTabIn("/me/")).toBe("overview");
    expect(memberTabIn("/me?github=linked")).toBe("overview");
    expect(memberTabIn("/me/wallet?x=1")).toBe("wallet");
    expect(memberTabIn("/me/wallet/")).toBe("wallet");
    expect(memberTabIn("/me/nope")).toBeNull();
    expect(memberTabIn("/me/overview")).toBeNull();
  });

  it("knows its own page from the admin panel's", () => {
    for (const p of ["/me", "/me?github=taken", "/me/cards", "/me/play?x"]) expect(isOwnPath(p)).toBe(true);
    for (const p of ["/", "/meow", "/system", "/karaoke"]) expect(isOwnPath(p)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the app, logged in as a member, over the made-up Core of the dev demo

/** The member stream, held open and quiet: a test reads what it was asked for. */
function streamResponse(signal: AbortSignal | undefined): Response {
  const body = new ReadableStream({
    start(ctl) {
      signal?.addEventListener("abort", () => ctl.close(), { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let asked: string[] = [];
const realFetch = globalThis.fetch;

function core(o: DemoOptions = {}) {
  const answer = memberDemoAnswer(o);
  asked = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), "http://panel.test");
    asked.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/member/stream") return streamResponse(init?.signal ?? undefined);
    if (url.pathname.startsWith("/api/member/exchange")) {
      const res = exchangeAnswer(init?.method ?? "GET", url.pathname, url.searchParams);
      if (res) return res;
    }
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const res = answer(init?.method ?? "GET", url, body) ?? { status: 404, body: { error: "no such endpoint" } };
    return new Response(JSON.stringify(res.body ?? null), {
      status: res.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** Her live feed for `LiveStage`: one hello. */
class FakeSource extends EventTarget {
  readyState = 1;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("hello", { data: JSON.stringify(DEMO_LIVE_HELLO) })));
  }
  close() {
    this.readyState = 2;
  }
}

const memberPaths = () => asked.map((a) => a.split("?")[0] ?? "");
const streamTopics = () =>
  asked.filter((a) => a.startsWith("/api/member/stream")).map((a) => new URL(a, "http://x").searchParams.get("topics") ?? "");

function renderAt(path: string) {
  window.history.replaceState(null, "", path);
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const utils = render(<App router={router} />);
  return { ...utils, history: router.history };
}

const tab = (name: string) => screen.getByRole("tab", { name });

beforeEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = FakeSource;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as { EventSource?: unknown }).EventSource;
  window.history.replaceState(null, "", "/");
});

describe("each tab's address", () => {
  for (const t of MEMBER_TABS) {
    it(`${memberTabPath(t.id)} opens ${t.label} with its blocks`, async () => {
      core();
      renderAt(memberTabPath(t.id));
      expect(await screen.findByRole("tab", { name: t.label })).toHaveAttribute("aria-selected", "true");
      for (const key of tabSections(t)) {
        expect(await screen.findByRole("region", { name: labelOf(key) }, { timeout: 4000 }), key).toBeInTheDocument();
      }
      // Nothing of another tab.
      for (const other of placed.filter((p) => p.tab !== t.id)) {
        expect(screen.queryByRole("region", { name: labelOf(other.key) }), other.key).toBeNull();
      }
      expect(document.title).toContain(t.label);
    });
  }

  it("is a link a click follows in the page, and back returns to the tab before", async () => {
    core();
    const { history } = renderAt("/me");
    await screen.findByRole("region", { name: "她眼中的你" });
    expect(tab("卡片")).toHaveAttribute("href", "/me/cards");
    await userEvent.click(tab("卡片"));
    await waitFor(() => expect(history.location.pathname).toBe("/me/cards"));
    expect(await screen.findByRole("region", { name: "卡冊" })).toBeInTheDocument();
    history.back();
    await waitFor(() => expect(tab("總覽")).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("region", { name: "她眼中的你" })).toBeInTheDocument();
  });

  it("sends an address under /me that is no tab to the overview", async () => {
    core();
    const { history } = renderAt("/me/nope");
    await waitFor(() => expect(history.location.pathname).toBe("/me"));
    expect(await screen.findByRole("region", { name: "她眼中的你" })).toBeInTheDocument();
  });

  it("lands the old page and the way back from GitHub on the overview, where the GitHub block is", async () => {
    core();
    renderAt("/me?github=linked");
    expect(await screen.findByRole("tab", { name: "總覽" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("region", { name: "GitHub" })).toBeInTheDocument();
    expect(await screen.findByText("已連結 GitHub 帳號")).toBeInTheDocument();
  });

  it("is the overview at / for a member, as before", async () => {
    core();
    renderAt("/");
    expect(await screen.findByRole("tab", { name: "總覽" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("region", { name: "錢包" })).toBeInTheDocument();
  });
});

describe("what loads", () => {
  it("asks only for the open tab's data, and switching back draws from what it has", async () => {
    core();
    renderAt("/me/cards");
    await screen.findByRole("region", { name: "卡冊" });
    await waitFor(() => expect(memberPaths()).toContain("/api/member/card"));
    for (const other of [
      "/api/member/me",
      "/api/member/quests",
      "/api/member/gifts",
      "/api/member/files",
      "/api/member/predictions",
      "/api/member/bounties",
      "/api/member/market/auction",
      "/api/member/exchange",
      "/api/member/board",
    ]) {
      expect(memberPaths(), other).not.toContain(other);
    }

    await userEvent.click(tab("總覽"));
    expect(await screen.findByRole("region", { name: "她眼中的你" })).toBeInTheDocument();
    await waitFor(() => expect(memberPaths()).toContain("/api/member/me"));
    expect(memberPaths()).not.toContain("/api/member/exchange");
    expect(memberPaths()).not.toContain("/api/member/market/auction");
    await screen.findByText("鯨鯨喜歡在下雨天聽歌");

    const before = memberPaths().filter((p) => p === "/api/member/cards").length;
    await userEvent.click(tab("卡片"));
    // Drawn at once from the cache: no wait, and not asked again.
    expect(screen.getByRole("region", { name: "她給你的卡" })).toBeInTheDocument();
    expect(memberPaths().filter((p) => p === "/api/member/cards").length).toBe(before);
  });

  it("follows on the push stream only the header's status and the open tab's topics", async () => {
    core();
    renderAt("/me/cards");
    await screen.findByRole("region", { name: "卡冊" });
    await waitFor(() => expect(streamTopics().length).toBeGreaterThan(0));
    expect(streamTopics().at(-1)).toBe("status");

    await userEvent.click(tab("互動"));
    await screen.findByRole("region", { name: "現場" });
    await waitFor(() => expect(streamTopics().at(-1)?.split(",")).toEqual(expect.arrayContaining(["status", "songs", "danmaku"])));

    await userEvent.click(tab("卡片"));
    await screen.findByRole("region", { name: "卡冊" });
    await waitFor(() => expect(streamTopics().at(-1)).toBe("status"));
  });
});

describe("the tab row", () => {
  it("is a tab list the arrow keys move along, and the address follows", async () => {
    core();
    const { history } = renderAt("/me");
    const list = await screen.findByRole("tablist", { name: "我的頁面" });
    expect(within(list).getAllByRole("tab").map((t) => t.textContent)).toEqual(MEMBER_TABS.map((t) => t.label));
    tab("總覽").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(tab("互動")).toHaveFocus();
    await waitFor(() => expect(tab("互動")).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(history.location.pathname).toBe("/me/gifts"));
    await userEvent.keyboard("{End}");
    await waitFor(() => expect(history.location.pathname).toBe("/me/exchange"));
    await userEvent.keyboard("{Home}");
    await waitFor(() => expect(history.location.pathname).toBe("/me"));
    expect(tab("總覽")).toHaveAttribute("aria-selected", "true");
  });
});

describe("the server choice", () => {
  it("is drawn once, above the blocks of a tab that has something per server", async () => {
    core();
    renderAt("/me/play");
    await screen.findByRole("region", { name: "市集" });
    const pickers = await screen.findAllByRole("radiogroup", { name: "伺服器" });
    expect(pickers).toHaveLength(1);
    const picker = pickers[0] as HTMLElement;
    for (const region of screen.getAllByRole("region")) expect(region.contains(picker)).toBe(false);
    await waitFor(() => expect(asked).toContain("/api/member/predictions?space=S-bay"));
    await userEvent.click(within(picker).getByRole("radio", { name: "月光島" }));
    await waitFor(() => expect(asked).toContain("/api/member/predictions?space=S-isle"));
    await waitFor(() => expect(asked).toContain("/api/member/market/auction?space=S-isle"));
    // The choice holds on the other tabs.
    await userEvent.click(tab(WORLD.currency));
    expect(within(await screen.findByRole("radiogroup", { name: "伺服器" })).getByRole("radio", { name: "月光島" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("is not on a tab with nothing per server", async () => {
    core();
    renderAt("/me/cards");
    await screen.findByRole("region", { name: "卡冊" });
    await waitFor(() => expect(memberPaths()).toContain("/api/member/card"));
    expect(screen.queryByRole("radiogroup", { name: "伺服器" })).toBeNull();
  });

  it("is not there at all for someone in one server", async () => {
    core({ spaces: [{ id: "S-bay", name: "鯨魚灣" }] });
    renderAt("/me/play");
    await screen.findByRole("region", { name: "市集" });
    await waitFor(() => expect(memberPaths()).toContain("/api/member/spaces"));
    expect(screen.queryByRole("radiogroup", { name: "伺服器" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "伺服器" })).toBeNull();
  });
});
