// 深海交易所 on the member page (the lists with the local stocks first, the search with
// suggestions, sortable columns, a ticker with their position and the order ticket, their own
// book, the rich list with the switch to stay off it, the rules and the small print), the order
// ticket (金額 / 股數, the quick amounts, the estimate and the Core's quote, 2x, refusals beside
// their control, the sheet's focus, the small print) and 經濟 / 交易所 for the owner. Every name
// and number here is made up.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ExchangeAccount,
  ExchangeAdmin,
  ExchangeBoards,
  ExchangeLine,
  ExchangeMarket,
  ExchangePortfolio,
  ExchangeQuote,
} from "@miyoria/contracts/api";
import { PushProvider } from "@/app/push";
import { TestStream } from "@/test/push-stream";
import { mockFetch, renderPage, renderRoute } from "@/test/render";
import { change, downColor, Exchange, LEVERAGE_LINE, LEVERAGE_RISKS, upColor } from "./Exchange";

const BASE = "魚幣是遊戲點數,沒有現金價值,不能用真錢或現實物品買賣、交換。這裡的行情只供遊戲使用,不是投資建議。";

const line = (code: string, name: string, chg: number | null, more: Partial<ExchangeLine> = {}): ExchangeLine & { holders: number | null } => ({
  code,
  name,
  market: "local",
  price: 100,
  basis: "quote",
  price_date: "2026-11-23",
  price_note: null,
  next_open: null,
  currency: "COIN",
  local: { what_moves: "大家多餵她,白飯食品就容易漲", today: "昨天她被餵了 14 次,比平常多 → 今天開盤 +1.8%" },
  coin_price: 100,
  age_minutes: 3,
  source: "這裡獨家:價格由程式模擬",
  change: chg,
  at: "2026-11-23T04:00:00.000Z",
  open: true,
  stale: false,
  quotes: "intraday",
  holders: null,
  ...more,
});

const LOCAL = [line("RICE", "白飯食品", 0.012), line("WHLE", "鯨落唱片", -0.03), line("NAPS", "打盹床業", 0.002)];

const MARKET: ExchangeMarket = {
  enabled: true,
  currency: "魚幣",
  colors: "tw",
  colors_chosen: null,
  colors_default: "tw",
  rates: { twd_per_coin: 1, twd_per_usd: 30 },
  house: { buys_halted: false, net_today: 0, cap_daily: 1500 },
  sessions: [
    { market: "tw", open: true, hours: "09:00–13:30", zone: "Asia/Taipei", stale: false, notice: null },
    { market: "us", open: false, hours: "09:30–16:00", zone: "America/New_York", stale: false, notice: null },
  ],
  lists: [
    { kind: "local", label: "新手推薦 · 這裡獨家" },
    { kind: "popular", label: "大家都在買" },
    { kind: "watch", label: "我的觀察" },
  ],
  default_list: "local",
  rules: {
    fee: 0.01,
    fee_min: 1,
    order_min: 10,
    order_max: 500,
    orders_per_day: 20,
    buy_per_day: 1000,
    limit_total: 1000,
    min_hold_minutes: 10,
    leverage: true,
    leverage_line: 0.2,
    leverage_min_days: 30,
    leverage_min_tier: "朋友",
    margin_cap: 150,
    account_min_days: 7,
    account_min_tier: "認識",
    bankrupt_cooling_days: 7,
    quote_max_age_seconds: 300,
    payout_cap_daily: 1500,
    watch_max: 20,
  },
  small_print: { base: BASE, real: "資料來源:Yahoo Finance,報價可能延遲。", leverage: "槓桿可能讓你賠光錢包和其他持股。" },
  no_dividends: "不發放股息;除息日股價下跌屬正常。",
  no_exchange: "魚幣永遠不能換成真錢或現實中的物品,也不能用真錢或物品買魚幣,在伺服器裡外都一樣。",
};

const ACCOUNT: ExchangeAccount = {
  currency: "魚幣",
  known: true,
  blocked: false,
  opened: true,
  opened_at: "2026-11-01T00:00:00.000Z",
  cannot_open: null,
  leverage: { allowed: true, why: null, opted_in: true },
  limits: { company: 270, total: 1000, mult: 1 },
  today: { orders: 0, bought: 0, orders_left: 20, buy_left: 1000 },
  balance: 900,
  investable: 900,
  hide_boards: false,
  show_holdings: false,
};

const QUOTE: ExchangeQuote = {
  side: "buy",
  code: "RICE",
  price: 100,
  open: true,
  coins: 102,
  margin: 101,
  exposure: 101,
  fee: 1,
  qty: 1_010_000,
  leverage: 1,
  gross: 0,
  net: 0,
  line_price: null,
  price_note: null,
  next_open: null,
  sentence: "付 102 魚幣(含手續費 1),照現價約 1.0100 股,下一筆有效報價成交。",
  warning: null,
};

const PORTFOLIO: ExchangePortfolio = {
  balance: 798,
  holdings: [
    { id: "p1", code: "RICE", name: "白飯食品", leverage: 1, qty: 1_000_000, cost: 101, margin: 101, loan: 0, price: 100, value: 100, equity: 100, ratio: null, line_price: null, warn_half_price: null, warn_near_price: null, opened_at: "2026-11-23T04:00:00.000Z", can_sell: true },
    { id: "p2", code: "AAPL", name: "示範科技", leverage: 2, qty: 20_000, cost: 200, margin: 100, loan: 100, price: 9_000, value: 180, equity: 80, ratio: 0.8, line_price: 6_300, warn_half_price: null, warn_near_price: null, opened_at: "2026-11-23T04:00:00.000Z", can_sell: true },
  ],
  orders: [{ id: "o1", code: "RICE", side: "buy", coins: 50, qty: 0, leverage: 1, position: null, status: "open", why: null, at: "2026-11-23T04:00:00.000Z", next_open: "2026-11-24T04:00:00.000Z" }],
  fills: [],
  notices: [],
  bankrupt: null,
  totals: { cost: 301, value: 180 },
};

const BOARDS: ExchangeBoards = {
  currency: "魚幣",
  space: null,
  rich: [
    { rank: 1, name: "海帶芽", worth: 3420, holdings: null, me: false },
    { rank: 2, name: "小魚乾", worth: 1055, holdings: null, me: true },
  ],
  me: { rich: 2, hidden: false },
};

type Answer = { status?: number; body: unknown };

function exchange(
  o: {
    status?: number;
    line?: Partial<ExchangeLine>;
    colors?: "tw" | "us";
    account?: Partial<ExchangeAccount>;
    portfolio?: Partial<ExchangePortfolio>;
    quote?: (body: Record<string, unknown>) => Answer;
  } = {},
) {
  const shown = { ...LOCAL[0], ...o.line } as ExchangeLine;
  const posts: { path: string; body: unknown; key: string | null }[] = [];
  // The member's own colours: what they chose here, else the install's (`colors`, default tw).
  let chosen: "tw" | "us" | null = null;
  const fallback = o.colors ?? "tw";
  mockFetch((method, url, body, headers) => {
    const path = url.pathname;
    if (method === "POST") posts.push({ path, body, key: headers.get("Idempotency-Key") });
    if (!path.startsWith("/api/member/exchange")) return undefined;
    if (o.status) return { status: o.status, body: { error: "exchange module is not available" } };
    if (path === "/api/member/exchange")
      return { body: { ...MARKET, colors: chosen ?? fallback, colors_chosen: chosen, colors_default: fallback } };
    if (path === "/api/member/exchange/colors") {
      chosen = (body as { colors: "tw" | "us" | null }).colors;
      return { body: { colors: chosen ?? fallback, chosen, default: fallback } };
    }
    if (path === "/api/member/exchange/account") return { body: { ...ACCOUNT, ...o.account } };
    if (path === "/api/member/exchange/portfolio") return { body: { ...PORTFOLIO, ...o.portfolio } };
    if (path === "/api/member/exchange/boards") return { body: BOARDS };
    if (path === "/api/member/exchange/list/local") return { body: { kind: "local", label: "新手推薦 · 這裡獨家", rows: LOCAL } };
    if (path === "/api/member/exchange/list/popular") return { body: { kind: "popular", label: "大家都在買", rows: [{ ...LOCAL[0], holders: 4 }] } };
    if (path === "/api/member/exchange/suggest") return { body: { items: [{ code: "RICE", name: "白飯食品" }] } };
    if (path === "/api/member/exchange/lookup") return { body: { instrument: LOCAL[0] } };
    if (path.startsWith("/api/member/exchange/ticker/")) return { body: { line: shown, points: [{ at: "2026-11-23T04:00:00.000Z", price: 99 }, { at: "2026-11-23T05:00:00.000Z", price: 100 }], watching: false } };
    if (path === "/api/member/exchange/watch") return { body: { watching: true, count: 1 } };
    if (path === "/api/member/exchange/quote") return o.quote ? o.quote(body as Record<string, unknown>) : { body: QUOTE };
    if (path === "/api/member/exchange/cancel") return { body: { refunded: 50 } };
    if (path === "/api/member/exchange/leverage") return { body: { ...ACCOUNT, leverage: { allowed: true, why: null, opted_in: true } } };
    if (path === "/api/member/exchange/order") return { body: { ...PORTFOLIO.orders[0], id: "o2" } };
    if (path === "/api/member/exchange/visibility") return { body: { ...ACCOUNT, ...(body as object) } };
    return undefined;
  });
  return { posts };
}

const tab = async (name: string) => userEvent.click(await screen.findByRole("tab", { name }));

describe("深海交易所 on the member page", () => {
  it("shows the local stocks first with the explainer, signed moves in the convention's colour and the small print", async () => {
    exchange();
    renderPage(<Exchange />);
    expect(await screen.findByText("白飯食品")).toBeInTheDocument();
    expect(screen.getByText(/第一次來/)).toBeInTheDocument();
    expect(screen.getByText(/紅漲綠跌/)).toBeInTheDocument();
    const up = screen.getByText("▲ +1.2%");
    expect(up).toHaveStyle({ color: upColor("tw") });
    expect(screen.getAllByText(new RegExp(BASE.slice(0, 10))).length).toBeGreaterThan(0);
    expect(change(-0.012)).toBe("▼ −1.2%");
  });

  it("lets the member choose their own colours of up and down, in words and colours, at once", async () => {
    const { posts } = exchange();
    renderPage(<Exchange />);
    const choice = await screen.findByRole("radiogroup", { name: "漲跌顏色" });
    const tw = within(choice).getByRole("radio", { name: /紅漲綠跌/ });
    const us = within(choice).getByRole("radio", { name: /綠漲紅跌/ });
    // Both options say themselves in words and show their two colours (up first).
    const swatches = (el: HTMLElement) => [...el.querySelectorAll("span[aria-hidden]")].map((s) => (s as HTMLElement).style.background);
    expect(swatches(tw)).toEqual(["rgb(239, 95, 95)", "rgb(63, 196, 138)"]);
    expect(swatches(us)).toEqual(["rgb(63, 196, 138)", "rgb(239, 95, 95)"]);
    expect(tw).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/漲跌顏色・預設/)).toBeInTheDocument();
    expect(await screen.findByText("▲ +1.2%")).toHaveStyle({ color: upColor("tw") });
    await userEvent.click(us);
    await waitFor(() => expect(posts).toContainEqual(expect.objectContaining({ path: "/api/member/exchange/colors", body: { colors: "us" } })));
    // The page follows at once: up is green now, and the arrow and sign are still there.
    await waitFor(() => expect(screen.getByText("▲ +1.2%")).toHaveStyle({ color: upColor("us") }));
    expect(screen.getByText("▼ −3.0%")).toHaveStyle({ color: downColor("us") });
    expect(within(choice).getByRole("radio", { name: /綠漲紅跌/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/漲跌顏色・你選的/)).toBeInTheDocument();
  });

  it("draws an install whose default is green up in green until the member chooses", async () => {
    exchange({ colors: "us" });
    renderPage(<Exchange />);
    expect(await screen.findByText("▲ +1.2%")).toHaveStyle({ color: upColor("us") });
    expect(screen.getByText("▼ −3.0%")).toHaveStyle({ color: downColor("us") });
    expect(within(screen.getByRole("radiogroup", { name: "漲跌顏色" })).getByRole("radio", { name: /綠漲紅跌/ })).toHaveAttribute("aria-checked", "true");
  });

  it("moves a list's prices as they are pushed, without asking again", async () => {
    exchange();
    const stream = new TestStream();
    const polled = globalThis.fetch;
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith("/api/member/stream") ? Promise.resolve(stream.response) : polled(input, init),
    );
    vi.stubGlobal("fetch", fetch);
    renderPage(
      <PushProvider audience="member">
        <Exchange />
      </PushProvider>,
    );
    expect(await screen.findByText("▲ +1.2%")).toBeInTheDocument();
    await waitFor(() => expect(fetch.mock.calls.some(([u]) => decodeURIComponent(String(u)).includes("exchange_list~local"))).toBe(true));
    const list = { kind: "local", label: "新手推薦 · 這裡獨家", rows: LOCAL };
    stream.send({ kind: "value", topic: "exchange_list", param: "local", data: list });
    stream.send({ kind: "ready" }, "r.1.h");
    stream.send(
      { kind: "value", topic: "exchange_list", param: "local", data: { ...list, rows: [{ ...LOCAL[0], change: 0.05 }, ...LOCAL.slice(1)] } },
      "r.2.h",
    );
    expect(await screen.findByText("▲ +5.0%")).toBeInTheDocument();
    expect(screen.queryByText("▲ +1.2%")).toBeNull();
  });

  it("sorts the columns, and 大家都在買 shows counts only", async () => {
    exchange();
    renderPage(<Exchange />);
    await screen.findByText("白飯食品");
    await userEvent.click(screen.getByRole("button", { name: /漲跌/ }));
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0] as HTMLElement).getByText("WHLE")).toBeInTheDocument();
    await tab("大家都在買");
    expect(await screen.findByText("4")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "持有人數" })).toBeInTheDocument();
  });

  it("suggests while typing, opens a ticker, watches it and buys from the bar once with a key", async () => {
    const { posts } = exchange();
    renderPage(<Exchange />);
    await userEvent.type(await screen.findByLabelText(/找股票/), "ri");
    await userEvent.click(await screen.findByRole("button", { name: "RICE 白飯食品" }));
    expect(await screen.findByRole("button", { name: "加入觀察" })).toBeInTheDocument();
    // What moved today's open, from her day, in numbers.
    expect(screen.getByText("昨天她被餵了 14 次,比平常多 → 今天開盤 +1.8%")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "加入觀察" }));
    await waitFor(() => expect(posts).toContainEqual(expect.objectContaining({ path: "/api/member/exchange/watch", body: { code: "RICE", on: true } })));
    // Buying is one tap away; a local stock opens on shares, with no 2x.
    await userEvent.click(within(screen.getByRole("region", { name: "買賣" })).getByRole("button", { name: "買進" }));
    const sheet = await screen.findByRole("dialog", { name: /RICE/ });
    expect(within(sheet).getByRole("radio", { name: "股數" })).toHaveAttribute("aria-checked", "true");
    expect(within(sheet).queryByRole("radio", { name: "2 倍" })).not.toBeInTheDocument();
    await userEvent.type(within(sheet).getByLabelText("買多少股"), "1");
    const confirm = await within(sheet).findByRole("button", { name: "買進 1.0100 股・約 102 魚幣" });
    expect(within(sheet).getAllByText(new RegExp(BASE.slice(0, 10))).length).toBeGreaterThan(0);
    await userEvent.click(confirm);
    await waitFor(() => expect(posts.filter((p) => p.path === "/api/member/exchange/order")).toHaveLength(1));
    const order = posts.find((p) => p.path === "/api/member/exchange/order");
    expect(order?.body).toEqual({ side: "buy", code: "RICE", shares: 1 });
    expect(order?.key).toBeTruthy();
    expect(posts.find((p) => p.path === "/api/member/exchange/quote")?.body).toEqual({ side: "buy", code: "RICE", shares: 1 });
    // The same sheet says what happened and offers the next step.
    expect(await within(sheet).findByRole("heading", { name: "委託送出了" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "查看持股" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "再下一筆" })).toBeInTheDocument();
  });

  it("says a closed market's price is its last close and when a waiting order fills", async () => {
    exchange({ line: { basis: "close", price_note: "收盤價(11/22)・休市中", open: false, next_open: "2026-11-24T04:00:00.000Z", age_minutes: null } });
    renderPage(<Exchange initialCode="RICE" />);
    expect(await screen.findByText("收盤價(11/22)・休市中")).toBeInTheDocument();
    expect(screen.getByText("休市・下一個開盤 11/24(二)12:00")).toBeInTheDocument();
    expect(screen.getAllByText(/下一個開盤 11\/24\(二\)12:00\(台北時間\)後/).length).toBeGreaterThan(0);
  });

  it("shows their own book with the 2x line and says only they see it", async () => {
    exchange();
    renderPage(<Exchange />);
    await tab("我的");
    expect(await screen.findByText("只有你自己看得到這裡;她也看不到任何人的持股。")).toBeInTheDocument();
    expect(screen.getByText(/跌到 6,300 自動賣出/)).toBeInTheDocument();
    expect(screen.getAllByText(/槓桿可能讓你賠光錢包和其他持股/).length).toBeGreaterThan(0);
  });

  it("lists the rich list with the switch to stay off, and the rules' lines", async () => {
    const { posts } = exchange();
    renderPage(<Exchange />);
    await tab("富人榜");
    expect(await screen.findByText("海帶芽")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch", { name: "我要上榜" }));
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ path: "/api/member/exchange/visibility", body: { hide_boards: true } }));
    await tab("規則");
    expect(await screen.findByText(MARKET.no_dividends)).toBeInTheDocument();
    expect(screen.getByText(MARKET.no_exchange)).toBeInTheDocument();
  });

  it("is one line when the module is off", async () => {
    exchange({ status: 503 });
    renderPage(<Exchange />);
    expect(await screen.findByText("交易所現在沒有開")).toBeInTheDocument();
  });
});

/** A real stock (2x may be offered on it). */
const TSMC: Partial<ExchangeLine> = { code: "2330.TW", name: "示範半導體", market: "tw", currency: "TWD", local: null, price: 1000, coin_price: 1000, source: "資料來源:Yahoo Finance" };

/** Opens the ticket from the bar at the bottom of a ticker's page. */
async function ticket(side: "買進" | "賣出", name: RegExp = /RICE|2330/) {
  await userEvent.click(within(await screen.findByRole("region", { name: "買賣" })).getByRole("button", { name: side }));
  return screen.findByRole("dialog", { name });
}

const quotes = (posts: { path: string; body: unknown }[]) => posts.filter((p) => p.path === "/api/member/exchange/quote").map((p) => p.body);

describe("the order ticket", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("switches between 金額 and 股數, keeps the amount, and asks the Core for what the field says", async () => {
    const { posts } = exchange();
    renderPage(<Exchange initialCode="RICE" />);
    const sheet = await ticket("買進");
    const shares = within(sheet).getByLabelText("買多少股");
    expect(shares).toHaveAttribute("inputmode", "decimal");
    await userEvent.type(shares, "2");
    await waitFor(() => expect(quotes(posts)).toContainEqual({ side: "buy", code: "RICE", shares: 2 }));
    // 金額: two shares at 100 and the fee, in coins.
    await userEvent.click(within(sheet).getByRole("radio", { name: "金額" }));
    const coins = within(sheet).getByLabelText("買多少魚幣");
    expect(coins).toHaveValue("202");
    expect(within(sheet).getByText("魚幣", { selector: "span" })).toBeInTheDocument();
    await waitFor(() => expect(quotes(posts)).toContainEqual({ side: "buy", code: "RICE", coins: 202 }));
    // Anything else is one line under the field, and nothing is asked.
    const asked = quotes(posts).length;
    await userEvent.clear(coins);
    await userEvent.type(coins, "abc");
    expect(await within(sheet).findByText("只能寫數字")).toHaveAttribute("role", "alert");
    expect(coins).toHaveAttribute("aria-invalid", "true");
    await new Promise((r) => setTimeout(r, 500));
    expect(quotes(posts)).toHaveLength(asked);
  });

  it("fills the field from the quick amounts: a share of what they may spend, or of what they hold", async () => {
    const { posts } = exchange();
    renderPage(<Exchange initialCode="RICE" />);
    let sheet = await ticket("買進");
    await userEvent.click(within(sheet).getByRole("radio", { name: "金額" }));
    // What they may put in: the wallet's 900 under one order's cap of 500.
    expect(within(sheet).getByText("最多可投入 500 魚幣")).toBeInTheDocument();
    const quick = within(sheet).getByRole("group", { name: "快速數量" });
    expect(within(quick).getAllByRole("button").map((b) => b.textContent)).toEqual(["25%", "50%", "75%", "全部"]);
    await userEvent.click(within(quick).getByRole("button", { name: "50%" }));
    expect(within(sheet).getByLabelText("買多少魚幣")).toHaveValue("250");
    expect(within(quick).getByRole("button", { name: "50%" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(quotes(posts)).toContainEqual({ side: "buy", code: "RICE", coins: 250 }));
    await userEvent.click(within(quick).getByRole("button", { name: "全部" }));
    expect(within(sheet).getByLabelText("買多少魚幣")).toHaveValue("500");
    // A sale: a share of what they hold (one share here), and 全部 sells it all.
    await userEvent.keyboard("{Escape}");
    sheet = await ticket("賣出");
    const held = within(sheet).getByRole("group", { name: "快速數量" });
    expect(within(held).getAllByRole("button").map((b) => b.textContent)).toEqual(["25%", "50%", "全部"]);
    expect(within(sheet).getByText("可賣 1 股")).toBeInTheDocument();
    await userEvent.click(within(held).getByRole("button", { name: "50%" }));
    expect(within(sheet).getByLabelText("賣多少股")).toHaveValue("0.5");
    await waitFor(() => expect(quotes(posts)).toContainEqual({ side: "sell", code: "RICE", shares: 0.5 }));
    await userEvent.click(within(held).getByRole("button", { name: "全部" }));
    await waitFor(() => expect(quotes(posts)).toContainEqual({ side: "sell", code: "RICE", all: true }));
  });

  it("shows its own estimate at once, then the Core's numbers, and holds the button until they come", async () => {
    exchange();
    renderPage(<Exchange initialCode="RICE" />);
    const sheet = await ticket("買進");
    await userEvent.click(within(sheet).getByRole("radio", { name: "金額" }));
    await userEvent.type(within(sheet).getByLabelText("買多少魚幣"), "200");
    const numbers = within(sheet).getByRole("region", { name: "試算" });
    // At once: what 200 coins buy at 100 a share, the fee, what is left.
    expect(within(numbers).getByText("估計・等交易所試算")).toBeInTheDocument();
    expect(within(numbers).getByText("1.9800 股")).toBeInTheDocument();
    expect(within(numbers).getByText("200 魚幣")).toBeInTheDocument();
    expect(within(numbers).getByText("700 魚幣")).toBeInTheDocument();
    const rows = numbers.querySelectorAll("dt").length;
    expect(within(sheet).getByRole("button", { name: "試算中…" })).toBeDisabled();
    // Then the Core's quote, in the same rows.
    expect(await within(numbers).findByText("交易所試算")).toBeInTheDocument();
    expect(within(numbers).getByText("102 魚幣")).toBeInTheDocument();
    expect(within(numbers).getByText("1.0100 股")).toBeInTheDocument();
    expect(within(numbers).getByText("798 魚幣")).toBeInTheDocument();
    expect(numbers.querySelectorAll("dt")).toHaveLength(rows);
    expect(within(sheet).getByText(QUOTE.sentence)).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "買進 1.0100 股・約 102 魚幣" })).toBeEnabled();
  });

  it("disables what cannot be done and says why", async () => {
    exchange({ line: { code: "WHLE", name: "鯨落唱片" }, account: { blocked: true } });
    renderPage(<Exchange initialCode="WHLE" />);
    const bar = await screen.findByRole("region", { name: "買賣" });
    expect(await within(bar).findByRole("button", { name: /買進.*只能賣出/ })).toBeDisabled();
    expect(within(bar).getByRole("button", { name: /賣出.*沒有持股/ })).toBeDisabled();
  });

  it("holds the button while nothing is typed and refuses selling more than they hold", async () => {
    const { posts } = exchange();
    renderPage(<Exchange initialCode="RICE" />);
    const sheet = await ticket("賣出");
    expect(within(sheet).getByRole("button", { name: "輸入股數" })).toBeDisabled();
    await userEvent.type(within(sheet).getByLabelText("賣多少股"), "3");
    expect(await within(sheet).findByText("最多可賣 1 股")).toHaveAttribute("role", "alert");
    await new Promise((r) => setTimeout(r, 500));
    expect(quotes(posts)).toEqual([]);
  });

  it("says each refusal beside the control it is about", async () => {
    exchange({
      line: TSMC,
      quote: (b) =>
        b.coins === 800
          ? { status: 402, body: { error: "魚幣不夠" } }
          : b.leverage === 2
            ? { status: 409, body: { error: "這檔只能 1 倍:2 倍只開放一股至少 50 魚幣、有前一天收盤價的標的" } }
            : b.coins === 300
              ? { status: 409, body: { error: "一天最多 20 筆委託" } }
              : { body: { ...QUOTE, code: "2330.TW" } },
    });
    renderPage(<Exchange initialCode="2330.TW" />);
    const sheet = await ticket("買進");
    const field = within(sheet).getByLabelText("買多少魚幣");
    // Short of coins: under the amount.
    await userEvent.type(field, "800");
    const short = await within(sheet).findByText("魚幣不夠");
    expect(short).toHaveAttribute("role", "alert");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field.getAttribute("aria-describedby")).toBe(short.id);
    expect(within(sheet).getByRole("button", { name: "買進" })).toBeDisabled();
    // Not on this ticker at 2x: under the 1x/2x choice.
    await userEvent.clear(field);
    await userEvent.type(field, "100");
    await userEvent.click(within(sheet).getByRole("radio", { name: "2 倍" }));
    const lev = await within(sheet).findByText(/這檔只能 1 倍/);
    expect(lev).toHaveAttribute("role", "alert");
    expect(within(sheet).getByRole("radiogroup", { name: "倍數" }).parentElement).toContainElement(lev);
    expect(field).toHaveAttribute("aria-invalid", "false");
    // About the order as a whole: right above the button.
    await userEvent.click(within(sheet).getByRole("radio", { name: "1 倍" }));
    await userEvent.clear(field);
    await userEvent.type(field, "300");
    const whole = await within(sheet).findByText("一天最多 20 筆委託");
    expect(whole.nextElementSibling).toHaveAttribute("data-confirm");
  });

  it("offers 2x only where allowed: coins only, the warning word for word, the selling line and the small print", async () => {
    const { posts } = exchange({
      line: TSMC,
      quote: (b) => ({ body: { ...QUOTE, code: "2330.TW", leverage: b.leverage ?? 1, line_price: b.leverage ? 800 : null, warning: b.leverage ? "2 倍可能賠掉保證金以外的錢,最壞會賠光錢包和其他持股;跳空時可能沒有預警就被自動賣出。" : null } }),
    });
    renderPage(<Exchange initialCode="2330.TW" />);
    const sheet = await ticket("買進");
    await userEvent.type(within(sheet).getByLabelText("買多少魚幣"), "102");
    await userEvent.click(within(sheet).getByRole("radio", { name: "2 倍" }));
    expect(within(sheet).getByText(LEVERAGE_LINE)).toBeInTheDocument();
    expect(LEVERAGE_LINE).toBe("2 倍可能賠掉保證金以外的錢,最壞會賠光錢包和其他持股。");
    expect(within(sheet).getByRole("radio", { name: "股數" })).toBeDisabled();
    await waitFor(() => expect(quotes(posts)).toContainEqual({ side: "buy", code: "2330.TW", coins: 102, leverage: 2 }));
    expect(await within(sheet).findByRole("button", { name: "2 倍買進 1.0100 股・付 102 魚幣" })).toBeEnabled();
    expect(within(sheet).getByText(/跳空時可能沒有預警就被自動賣出/)).toBeInTheDocument();
    expect(within(sheet).getByText("跌到這裡自動賣出").nextElementSibling).toHaveTextContent("800");
    expect(within(sheet).getByText(/槓桿可能讓你賠光錢包和其他持股/)).toBeInTheDocument();
  });

  it("keeps the one-time 2x consent with its risks in full", async () => {
    const { posts } = exchange({ line: TSMC, account: { leverage: { allowed: true, why: null, opted_in: false } } });
    renderPage(<Exchange initialCode="2330.TW" />);
    const sheet = await ticket("買進");
    expect(within(sheet).queryByRole("radio", { name: "2 倍" })).not.toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "開啟 2 倍" }));
    const consent = await screen.findByRole("alertdialog");
    for (const r of LEVERAGE_RISKS) expect(within(consent).getByText(r)).toBeInTheDocument();
    const accept = within(consent).getByRole("button", { name: "我了解,開啟" });
    expect(accept).toBeDisabled();
    await userEvent.click(within(consent).getByRole("checkbox"));
    await userEvent.click(accept);
    await waitFor(() => expect(posts).toContainEqual(expect.objectContaining({ path: "/api/member/exchange/leverage", body: { accept: true } })));
  });

  it("is a dialog: focus goes to the amount, stays inside, Esc closes it and focus goes back", async () => {
    exchange();
    renderPage(<Exchange initialCode="RICE" />);
    const open = within(await screen.findByRole("region", { name: "買賣" })).getByRole("button", { name: "買進" });
    await userEvent.click(open);
    const sheet = await screen.findByRole("dialog", { name: /RICE 白飯食品/ });
    await waitFor(() => expect(within(sheet).getByLabelText("買多少股")).toHaveFocus());
    for (let i = 0; i < 14; i++) {
      await userEvent.tab();
      expect(sheet).toContainElement(document.activeElement as HTMLElement);
    }
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(open).toHaveFocus();
  });

  it("shows their position under the price, sells from it and cancels a waiting order there", async () => {
    const { posts } = exchange();
    renderPage(<Exchange initialCode="RICE" />);
    const mine = await screen.findByRole("region", { name: "你的持股" });
    expect(within(mine).getByText("1 股")).toBeInTheDocument();
    expect(within(mine).getByText("100 魚幣")).toBeInTheDocument();
    expect(within(mine).getByText("▼ −1")).toHaveStyle({ color: downColor("tw") });
    expect(within(mine).getByText("買進 50 魚幣")).toBeInTheDocument();
    await userEvent.click(within(mine).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(posts).toContainEqual(expect.objectContaining({ path: "/api/member/exchange/cancel", body: { order: "o1" } })));
    await userEvent.click(within(mine).getByRole("button", { name: "賣出" }));
    const sheet = await screen.findByRole("dialog", { name: /RICE/ });
    expect(within(sheet).getByRole("radio", { name: "賣出" })).toHaveAttribute("aria-checked", "true");
  });

  it("lists 我的 as rows that open the ticker, with 買 / 賣 and the fills folded away", async () => {
    exchange({ portfolio: { fills: [{ id: "f1", code: "RICE", side: "buy", kind: "fill", qty: 1_000_000, price: 100, gross: 100, fee: 1, paid: 0, shortfall: 0, leverage: 1, at: "2026-11-23T04:00:00.000Z" }] } });
    renderPage(<Exchange />);
    await tab("我的");
    expect(await screen.findByRole("button", { name: "RICE 白飯食品" })).toBeInTheDocument();
    expect(screen.getByText("白飯食品・1 股")).toBeInTheDocument();
    // A plain lot on its cost, a 2x position on its margin (80 left of 100).
    expect(screen.getByText("▼ −1")).toBeInTheDocument();
    expect(screen.getByText("▼ −20")).toBeInTheDocument();
    const folded = screen.getByRole("button", { name: "最近成交 1 筆" });
    expect(folded).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/每股 100/)).not.toBeInTheDocument();
    await userEvent.click(folded);
    expect(screen.getByText(/買進 1 股・每股 100・手續費 1/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "賣出 RICE" }));
    const sheet = await screen.findByRole("dialog", { name: /RICE/ });
    expect(within(sheet).getByRole("radio", { name: "賣出" })).toHaveAttribute("aria-checked", "true");
  });

  it("puts the ticket in a panel beside the chart on a wide screen, always there", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(min-width: 1024px)", media: q, addEventListener() {}, removeEventListener() {} }));
    exchange();
    renderPage(<Exchange initialCode="RICE" />);
    const panel = await screen.findByRole("complementary", { name: "買賣" });
    expect(await within(panel).findByRole("form", { name: "下單" })).toBeInTheDocument();
    expect(within(panel).getByRole("radio", { name: "買進" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "買賣" })).not.toBeInTheDocument();
  });

  it("keeps the small print on the ticker, the ticket and 我的", async () => {
    exchange({ line: { open: false, next_open: "2026-11-24T04:00:00.000Z", basis: "close", price_note: "收盤價(11/22)・休市中" } });
    renderPage(<Exchange initialCode="RICE" />);
    await screen.findByRole("region", { name: "你的持股" });
    expect(screen.getAllByText(new RegExp(BASE.slice(0, 12))).length).toBeGreaterThan(0);
    const sheet = await ticket("買進");
    expect(within(sheet).getByText(new RegExp(BASE.slice(0, 12)))).toBeInTheDocument();
    expect(within(sheet).getByText("休市中:下一個開盤 11/24(二)12:00(台北時間)後第一筆有效報價成交,之前可以取消;實際的數字可能不同。")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await tab("我的");
    expect(await screen.findByText("只有你自己看得到這裡;她也看不到任何人的持股。")).toBeInTheDocument();
    expect(screen.getAllByText(/槓桿可能讓你賠光錢包和其他持股/).length).toBeGreaterThan(0);
  });
});

const ADMIN: ExchangeAdmin = {
  enabled: true,
  rates: { twd_per_coin: 1, twd_per_usd: 30 },
  report: {
    today: { day: 20_780, date: "2026-11-23", burned: 20, minted: 12, net: -8, written_off: 0, buys_halted: false },
    days: [],
    cap_daily: 1500,
    bankrupt: [],
    quotes: [],
    books: { postings: 4, lines: 4, pending: 0 },
    mint: {
      windows: [
        { days: 1, burned: 20, minted: 12, net: -8, share: -0.0002 },
        { days: 7, burned: 900, minted: 4_000, net: 3_100, share: 0.062 },
        { days: 30, burned: 2_000, minted: 6_000, net: 4_000, share: 0.08 },
      ],
      circulation: 50_000,
      warn_share: 0.05,
      warning: "過去 7 天交易所淨發出 3,100 魚幣,是現在所有錢包合計的 6.2%,超過提醒線 5.0%。",
    },
  },
  tickers: [
    { code: "2330.TW", name: "示範半導體", provider_name: "Demo Semiconductor Manufacturing Company Limited", name_override: null, market: "tw", exchange: "TAI", type: "EQUITY", status: "paused", reason: null, added_at: "2026-11-23T02:00:00.000Z", missing_days: 0, holders: 2 },
  ],
  providers: [{ id: "yahoo", last_error: "沒有讀到:2330.TW" }],
  refresh_seconds: 60,
  positions: [{ id: "pos9", name: "海帶芽", code: "2330.TW", leverage: 1, qty: 50_000, value: 100 }],
};

describe("經濟 / 交易所 for the owner", () => {
  it("shows the day, the provider's problem, confirms a split and sells a position after asking", async () => {
    const posts: { path: string; body: unknown }[] = [];
    mockFetch((method, url, body) => {
      if (method === "POST") posts.push({ path: url.pathname, body });
      if (url.pathname === "/api/exchange") return { body: ADMIN };
      if (url.pathname === "/api/exchange/split") return { body: { positions: 2 } };
      if (url.pathname === "/api/exchange/sell") return { body: { paid: 100 } };
      if (url.pathname === "/api/exchange/name") return { body: { name: "台積電" } };
      return undefined;
    });
    renderRoute("/economy?tab=exchange");
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => a.textContent?.includes("沒有讀到"))).toBe(true);
    expect(screen.getByText("對得上")).toBeInTheDocument();
    // What the exchange minted, with the warning past the line (nothing halted by it).
    expect(alerts.some((a) => a.textContent?.includes("過去 7 天交易所淨發出 3,100 魚幣"))).toBe(true);
    const mint = screen.getByRole("region", { name: "魚幣發出" });
    expect(within(mint).getByText("淨發出 +3,100")).toBeInTheDocument();
    expect(within(mint).getByText("占流通 6.2%")).toBeInTheDocument();
    expect(within(mint).getByText(/流通中的魚幣\(所有錢包合計\):50,000/)).toBeInTheDocument();
    // The owner's display name for a ticker, with the provider's beside it.
    await userEvent.click(screen.getByRole("button", { name: "改名稱" }));
    const naming = await screen.findByRole("alertdialog");
    expect(naming).toHaveTextContent("Demo Semiconductor Manufacturing Company Limited");
    await userEvent.type(within(naming).getByLabelText(/顯示名稱/), "台積電");
    await userEvent.click(within(naming).getByRole("button", { name: "確定" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/api/exchange/name", body: { code: "2330.TW", name: "台積電" } }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "確認分割" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.type(within(dialog).getByLabelText(/每一股變成幾股/), "4");
    await userEvent.click(within(dialog).getByRole("button", { name: "確定" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/api/exchange/split", body: { code: "2330.TW", ratio: 4 } }));
    await userEvent.click(screen.getByRole("button", { name: "賣掉" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "確定" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/api/exchange/sell", body: { position: "pos9" } }));
  });
});
