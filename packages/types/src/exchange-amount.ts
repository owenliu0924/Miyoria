// What a member types as an order's amount on the exchange (owner 2026-11-22: one input
// everywhere, Discord's modal and the member page's ticket alike): a bare number is SHARES (`3`,
// `0.5`); a number after `$` is FISH COINS (`$200`: as many shares as 200 coins buy; on a sale,
// that many coins' worth at the price then). `＄` works like `$`; spaces, thousands separators and
// a trailing 股 or 魚幣 are noise. A sale may also say 全部. Anything else is refused with one line
// that shows both forms. A file with no imports: the panel takes it as it is.

/** Shares are kept in millionths: more decimals than this cannot be bought or sold. */
export const SHARE_DECIMALS = 6;

export type OrderAmount =
  | { unit: "shares"; value: number }
  | { unit: "coins"; value: number }
  | { unit: "all"; value: 0 };

export type OrderAmountResult = { ok: true; amount: OrderAmount } | { ok: false; message: string };

/** The one line a refusal says: both forms. */
export const AMOUNT_HELP = "寫數字是股數(例如 3、0.5),前面加 $ 是魚幣(例如 $200)";

const fullWidth = (s: string): string =>
  s.replace(/[０-９．，]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** Parses what was typed; `sell`: 全部 (or `all`) is allowed too. */
export function parseOrderAmount(raw: string, side: "buy" | "sell"): OrderAmountResult {
  const no = (why: string): OrderAmountResult => ({ ok: false, message: `${why}:${AMOUNT_HELP}` });
  const t = fullWidth(raw).trim();
  if (side === "sell" && /^(全部|all)$/i.test(t))
    return { ok: true, amount: { unit: "all", value: 0 } };
  const m = /^([$＄])?\s*([+-]?)\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(股|魚幣|幣)?$/.exec(t);
  if (!m) return no(t === "" ? "還沒寫數量" : "看不懂這個數量");
  const coins = m[1] !== undefined;
  if (m[2] === "-") return no("數量要大於 0");
  const whole = (m[3] ?? "").replace(/,/g, "");
  const decimals = m[4] ?? "";
  const value = Number(decimals === "" ? whole : `${whole}.${decimals}`);
  if (!Number.isFinite(value) || value <= 0) return no("數量要大於 0");
  if (coins) {
    if (decimals !== "" && /[1-9]/.test(decimals)) return no("魚幣只能是整數");
    return { ok: true, amount: { unit: "coins", value: Math.round(value) } };
  }
  if (decimals.length > SHARE_DECIMALS && /[1-9]/.test(decimals.slice(SHARE_DECIMALS)))
    return no(`股數最多到小數點後 ${SHARE_DECIMALS} 位`);
  return { ok: true, amount: { unit: "shares", value } };
}

/** `3.5` shares as written back: whole shares plainly, else up to four places. */
export function sharesWord(shares: number): string {
  if (Number.isInteger(shares)) return shares.toLocaleString("en-US");
  return Number(shares.toFixed(4)).toString();
}

/**
 * The helper line under the amount, with this stock's live numbers: 「3 = 3 股(約 6,000 魚幣)・
 * $200 = 花 200 魚幣(約 0.1 股)」. `coinPrice` is one share in coins (`null`: not known yet).
 */
export function amountExamples(coinPrice: number | null, side: "buy" | "sell"): string {
  const shares = coinPrice !== null && coinPrice >= 1000 ? 1 : 3;
  const coins = 200;
  const coinWord = (n: number) => Math.round(n).toLocaleString("en-US");
  const a =
    coinPrice === null
      ? `${shares} = ${shares} 股`
      : `${shares} = ${shares} 股(約 ${coinWord(shares * coinPrice)} 魚幣)`;
  const verb = side === "buy" ? "花" : "賣掉價值";
  const b =
    coinPrice === null || coinPrice <= 0
      ? `$${coins} = ${verb} ${coins} 魚幣`
      : `$${coins} = ${verb} ${coins} 魚幣(約 ${sharesWord(coins / coinPrice)} 股)`;
  return `${a}・${b}${side === "sell" ? "・全部 = 全部賣出" : ""}`;
}
