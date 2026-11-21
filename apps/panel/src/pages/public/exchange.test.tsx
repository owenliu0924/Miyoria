// 深海交易所 on the member page (the market, the ticket with its confirmation, their own book with
// the line drawn, the boards and the switch to stay off them) and 經濟 / 交易所 for the owner.
// Every name and number here is made up.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ExchangeAccount, ExchangeAdmin, ExchangeBoards, ExchangeMarket, ExchangePortfolio, ExchangeQuote } from "@miyoria/contracts/api";
import { mockFetch, renderPage, renderRoute } from "@/test/render";
import { change, Exchange } from "./Exchange";

const company = (code: string, name: string, chg: number, limit: "up" | "down" | null = null) => ({
  code,
  name,
  sector: "AI",
  blurb: "假的公司",
  price: 10_000,
  ref: 9_800,
  change: chg,
  limit,
  spark: [9_800, 10_000],
});

const MARKET: ExchangeMarket = {
  enabled: true,
  paused: false,
  halted: false,
  currency: "魚幣",
  last_round: { round: 1, at: "2026-11-23T04:00:00.000Z", status: "held" },
  next_round_at: "2026-11-23T05:00:00.000Z",
  fish: 1012,
  fish_ref: 1000,
  level: 1.02,
  vault: 4300,
  obligations: 4200,
  burned_week: 84,
  companies: [company("DPSK", "DipSick AI", 0.0204), company("NVDY", "Envydia", 0.1, "up"), company("CUBE", "方塊礦業", -0.1, "down")],
  news: [{ id: "n1", company: "DPSK", kind: "event", direction: "up", size: "small", headline: "DipSick AI 傳出利多", body: "這一盤的價格已經反映。", by: "plain", round: 1, at: "2026-11-23T04:00:00.000Z" }],
  rules: {
    rounds_per_day: 12,
    first_hour: 12,
    daily_limit: 0.1,
    round_limit: 0.05,
    breaker: 0.07,
    fee_buy: 0.015,
    fee_sell: 0.015,
    tax_sell: 0.03,
    fee_min: 1,
    order_min: 10,
    order_max: 200,
    orders_per_day: 20,
    buy_per_day: 300,
    limit_company: 200,
    limit_total: 600,
    concentration: 0.25,
    transfer_lock_hours: 24,
    account_min_days: 7,
    account_min_tier: "認識",
    leverage: { enabled: true, max: 2, line: 0.2, warn_half: 0.5, warn_near: 0.35, carry_daily: 0.002, min_days: 30, min_tier: "朋友", margin_cap: 150 },
  },
  her: { text: "今天大家都很有精神。", kind: "open", at: "2026-11-23T04:00:00.000Z" },
  rating: null,
};

const ACCOUNT: ExchangeAccount = {
  currency: "魚幣",
  known: true,
  blocked: false,
  opened: true,
  opened_at: "2026-11-01T00:00:00.000Z",
  cannot_open: null,
  leverage: { allowed: true, why: null, opted_in: true },
  limits: { company: 270, total: 810, mult: 1.35 },
  today: { orders: 1, bought: 100, orders_left: 19, buy_left: 200 },
  balance: 900,
  investable: 900,
  hide_boards: false,
  show_holdings: false,
};

const QUOTE: ExchangeQuote = {
  side: "buy",
  code: "DPSK",
  price: 10_000,
  coins: 80,
  margin: 77,
  exposure: 154,
  fee: 3,
  qty: 1540,
  leverage: 2,
  gross: 0,
  tax: 0,
  net: 0,
  max_loss: 77,
  line_price: 6_000,
  warn_half_price: 7_500,
  warn_near_price: 6_750,
  sentence: "最多賠掉 77 魚幣(這筆的保證金),跌到 60 會自動賣出。你錢包裡的其他魚幣不會被動到,也不會欠錢。",
};

const PORTFOLIO: ExchangePortfolio = {
  account: ACCOUNT,
  holdings: [{ code: "DPSK", name: "DipSick AI", qty: 980, sellable: 980, cost: 98, value: 98, price: 10_000 }],
  leveraged: [
    {
      id: "pos1",
      code: "CUBE",
      name: "方塊礦業",
      qty: 3000,
      leverage: 2,
      exposure: 154,
      margin: 77,
      loan: 77,
      carry: 1,
      price: 4_500,
      value: 135,
      equity: 57,
      ratio: 0.74,
      line_price: 3_100,
      warn_half_price: 3_850,
      warn_near_price: 3_470,
      opened_day: 20_780,
      can_close: true,
      at_risk: 57,
    },
  ],
  orders: [{ id: "o1", code: "DPSK", side: "buy", kind: "market", limit: null, coins: 100, qty: 0, leverage: 1, position: null, status: "open", why: null, at: "2026-11-23T03:30:00.000Z" }],
  fills: [],
  notices: [{ id: "x1", kind: "warn_half", text: "CUBE(方塊礦業) 的槓桿部位:保證金剩 50%", at: "2026-11-23T04:00:00.000Z" }],
  totals: { cost: 175, value: 155, worth: 1055 },
};

const BOARDS: ExchangeBoards = {
  currency: "魚幣",
  rich: [
    { rank: 1, name: "海帶芽", worth: 3420, holdings: [{ code: "NAPS", value: 200 }], me: false },
    { rank: 2, name: "小魚乾", worth: 1055, holdings: null, me: true },
  ],
  volume: [{ rank: 1, name: "小魚乾", volume: 300, trades: 3, me: true }],
  me: { rich: 2, volume: 1, hidden: false },
  week_start: "2026-11-23",
};

function exchange(o: { status?: number; account?: ExchangeAccount } = {}) {
  const posts: { path: string; body: unknown; key: string | null }[] = [];
  const fn = mockFetch((method, url, body, headers) => {
    const path = url.pathname;
    if (method === "POST") posts.push({ path, body, key: headers.get("Idempotency-Key") });
    if (!path.startsWith("/api/member/exchange")) return undefined;
    if (o.status) return { status: o.status, body: { error: "exchange module is not available" } };
    if (path === "/api/member/exchange") return { body: MARKET };
    if (path === "/api/member/exchange/account") return { body: o.account ?? ACCOUNT };
    if (path === "/api/member/exchange/portfolio") return { body: { ...PORTFOLIO, account: o.account ?? ACCOUNT } };
    if (path === "/api/member/exchange/boards") return { body: BOARDS };
    if (path.startsWith("/api/member/exchange/company/")) {
      return { body: { company: MARKET.companies[0], history: [{ round: 1, at: "2026-11-23T04:00:00.000Z", price: 9_900 }, { round: 2, at: "2026-11-23T05:00:00.000Z", price: 10_000 }], closes: [], news: MARKET.news, mine: null } };
    }
    if (path === "/api/member/exchange/quote") return { body: QUOTE };
    if (path === "/api/member/exchange/order") return { body: { ...PORTFOLIO.orders[0], id: "o2" } };
    if (path === "/api/member/exchange/visibility") return { body: { ...ACCOUNT, ...(body as object) } };
    return undefined;
  });
  return { fn, posts };
}

const tab = async (name: string) => userEvent.click(await screen.findByRole("tab", { name }));

describe("深海交易所 on the member page", () => {
  it("shows the index, the companies with signed moves and 漲停/跌停 in words, the news and her line", async () => {
    exchange();
    renderPage(<Exchange />);
    expect(await screen.findByText("DipSick AI")).toBeInTheDocument();
    expect(screen.getByText("今天大家都很有精神。")).toBeInTheDocument();
    expect(screen.getAllByText(/\+10\.0%/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("漲停").length).toBeGreaterThan(0);
    expect(screen.getAllByText("跌停").length).toBeGreaterThan(0);
    expect(screen.getByText("DipSick AI 傳出利多")).toBeInTheDocument();
    expect(change(-0.012)).toBe("−1.2%");
  });

  it("confirms a leveraged buy with the most it can lose and the line, then sends it once with a key", async () => {
    const { posts } = exchange();
    renderPage(<Exchange />);
    await tab("下單");
    await userEvent.click(await screen.findByRole("radio", { name: "2 倍" }));
    await userEvent.click(screen.getByRole("button", { name: "試算並確認" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("最多賠掉 77 魚幣");
    expect(within(dialog).getByText("60.00")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "送出委託" }));
    await waitFor(() => expect(posts.filter((p) => p.path === "/api/member/exchange/order")).toHaveLength(1));
    const order = posts.find((p) => p.path === "/api/member/exchange/order");
    expect(order?.body).toEqual({ side: "buy", company: "DPSK", coins: 100, leverage: 2 });
    expect(order?.key).toBeTruthy();
  });

  it("asks to open an account first, with the Core's reason when they cannot yet", async () => {
    exchange({ account: { ...ACCOUNT, opened: false, cannot_open: "她認識你滿 7 天才能開戶(現在 3 天)" } });
    renderPage(<Exchange />);
    await tab("下單");
    expect(await screen.findByRole("alert")).toHaveTextContent("滿 7 天");
    expect(screen.queryByRole("button", { name: "開戶" })).not.toBeInTheDocument();
  });

  it("shows their own holdings and the leveraged line, and says only they see it", async () => {
    exchange();
    renderPage(<Exchange />);
    await tab("我的");
    expect(await screen.findByText("只有你自己看得到這裡;她也看不到任何人的持股。")).toBeInTheDocument();
    expect(screen.getAllByText("31.00").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "加保證金" })).toBeDisabled();
    expect(screen.getByText(/保證金剩 50%/)).toBeInTheDocument();
  });

  it("lists the boards and says plainly that one is on them by default, with the switch to stay off", async () => {
    const { posts } = exchange();
    renderPage(<Exchange />);
    await tab("排行榜");
    expect(await screen.findByText("海帶芽")).toBeInTheDocument();
    expect(screen.getByText(/預設會上榜/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "我要上榜" }));
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ path: "/api/member/exchange/visibility", body: { hide_boards: true } }));
  });

  it("is one line when the module is off, and nothing on a Core without it", async () => {
    exchange({ status: 503 });
    renderPage(<Exchange />);
    expect(await screen.findByText("交易所現在沒有開")).toBeInTheDocument();
  });
});

const ADMIN: ExchangeAdmin = {
  enabled: true,
  paused: false,
  paused_by: null,
  vault: 4300,
  vault_rows: 4300,
  burned: 900,
  burned_week: 84,
  obligations: 4200,
  level: 1.02,
  fish: 1012,
  owed: [],
  pending_postings: 0,
  accounts: 12,
  positions: 1,
  open_orders: 0,
  rounds: [{ round: 1, at: "2026-11-23T04:00:00.000Z", status: "skipped", fish: 1000, level: null, vault: 0, burned: 0, volume: 0 }],
  holders: [{ person: "p1", name: "海帶芽", positions: [{ id: "pos9", code: "NAPS", leverage: 1, qty: 2800, value: 200, equity: 200 }] }],
  params: { open: true, fee_buy: 0.015, leverage: true },
};

describe("經濟 / 交易所 for the owner", () => {
  it("shows the state and the parameters, pauses after asking, and sells a holding with a note", async () => {
    const posts: { path: string; body: unknown }[] = [];
    mockFetch((method, url, body) => {
      if (method === "POST") posts.push({ path: url.pathname, body });
      if (url.pathname === "/api/exchange") return { body: ADMIN };
      if (url.pathname === "/api/exchange/pause") return { body: { paused: true, refunded: 2 } };
      if (url.pathname === "/api/exchange/sell") return { body: { paid: 200 } };
      return undefined;
    });
    renderRoute("/economy?tab=exchange");
    expect(await screen.findByText("跳過(停機)")).toBeInTheDocument();
    expect(screen.getByText("fee_buy")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "暫停交易" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "暫停" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/api/exchange/pause", body: { paused: true } }));
    await userEvent.click(screen.getByRole("button", { name: "賣掉" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(within(dialog).getByLabelText("為什麼"), "清理");
    await userEvent.click(within(dialog).getByRole("button", { name: "賣掉" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/api/exchange/sell", body: { position: "pos9", note: "清理" } }));
  });
});
