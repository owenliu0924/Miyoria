// Made-up answers for every route the member area reads, for the dev-only demo (`demo.ts`) and the
// member area's tests. Every name, number and line here is invented; nothing comes from a Core.
// `answer` is a router-like handler: the route's answer, or `undefined` for a route it does not
// know (the caller answers that like the Core's fallback, a 404).

import type {
  IssuedCard,
  IssuedFortune,
  MemberSession,
  MemberView,
  PublicSongs,
  PublicStatus,
  WalletView,
} from "@miyoria/contracts/api";
import { WORLD } from "@/lib/world";

/** The coins are named as this profile names them, like everything the Core would send. */
const COIN = WORLD.currency;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface DemoOptions {
  /** The person's servers; two by default so the server choice shows. */
  spaces?: { id: string; name: string }[];
  /** Today's quests are there (default) or not. */
  quests?: boolean;
}

export const DEMO_MEMBER: MemberSession = { name: "小鯨", avatar_url: null };

const day = (offset: number) => {
  const d = new Date(Date.now() + offset * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

const STATUS: PublicStatus = {
  state: "singing",
  live: true,
  in_voice: true,
  game: null,
  today: { songs_sung: 3, hours_live: 1.5, hours_in_voice: 2 },
  days: Array.from({ length: 14 }, (_, i) => ({
    date: day(i - 13),
    songs_sung: [4, 0, 3, 2, 5, 1, 0, 6, 2, 3, 4, 0, 2, 3][i] ?? 0,
    hours_live: [2, 0, 1.5, 1, 2.5, 0.5, 0, 3, 1, 1.5, 2, 0, 1, 1.5][i] ?? 0,
    hours_in_voice: [3, 1, 2, 2, 3, 1, 0, 4, 2, 2, 3, 1, 2, 2][i] ?? 0,
  })),
};

const SONGS: PublicSongs = {
  playing: { title: "海邊的歌", artist: "示範樂團", duration_s: 241 },
  upcoming: [
    { title: "月光下", artist: "示範樂團", duration_s: 228, ready: true },
    { title: null, artist: null, duration_s: null, ready: false },
  ],
  recent: [{ title: "晚安曲", artist: "示範歌手", duration_s: 203 }],
};

const ME: MemberView = {
  card: {
    call_name: "鯨鯨",
    relationship: "好朋友",
    affinity: "很好",
    trust: "信任",
    familiarity: "熟",
    public_feeling: "你每次來都會先問我今天好不好,我記得喔。",
  },
  bond: {
    tier: "好朋友",
    stage: 2,
    tier_label: "好朋友 II",
    next_tier: "摯友",
    next_label: "好朋友 III",
    tier_progress: 0.4,
    ring: { lap: 1, fraction: 0.55, full: false },
  },
  memories: [
    { text: "鯨鯨喜歡在下雨天聽歌", kind: "fact", date: day(-2) },
    { text: "一起猜中了海龜湯的結局", kind: "episode", date: day(-6) },
    { text: "鯨鯨養了一隻叫豆豆的貓", kind: "fact", date: day(-11) },
  ],
  songs: [
    { title: "月光下", artist: "示範樂團", state: "ready", requested_at: iso(-HOUR) },
    { title: "晚安曲", artist: "示範歌手", state: "done", requested_at: iso(-DAY) },
  ],
  activity: Array.from({ length: 14 }, (_, i) => ({
    date: day(i - 13),
    text: [5, 2, 0, 8, 3, 0, 1, 6, 4, 0, 2, 7, 3, 5][i] ?? 0,
    voice: [2, 0, 0, 3, 1, 0, 0, 2, 2, 0, 1, 4, 0, 2][i] ?? 0,
  })),
  can_request_song: true,
  forget: {
    removes: "會刪除:關於你的記憶、你告訴她的事,和從你說過的話整理出來的記憶。",
    keeps: "不會刪除:聊天紀錄的時間,和你送她的東西(不寫是誰送的)。",
  },
};

const WALLET: WalletView = {
  currency: COIN,
  balance: 268,
  can_earn: true,
  today_earned: 20,
  checked_in_today: false,
  streak: 5,
  earn: [
    { reason: "checkin", label: "每日簽到", amount: 10, earned_today: 0, cap: 10 },
    { reason: "talked", label: "今天和她說過話", amount: 10, earned_today: 10, cap: 10 },
    { reason: "voice", label: "在她的語音頻道", amount: 2, earned_today: 10, cap: 20 },
  ],
  shop: [
    { id: "rice", kind: "feed", label: "一碗白飯", price: 10, available: true, why: null },
    { id: "big_bowl", kind: "feed", label: "鋼盆", price: 40, available: true, why: null },
    { id: "dessert", kind: "feed", label: "甜點", price: 25, available: true, why: null },
    { id: "frame:sakura", kind: "frame", label: "櫻花", price: 100, available: true, why: null },
    { id: "frame:abyss", kind: "frame", label: "深海", price: 150, available: true, why: null },
    { id: "frame:gold", kind: "frame", label: "金框", price: 300, available: true, why: null },
    { id: "screen_message", kind: "stream", label: "留言上大螢幕", price: 30, available: true, why: null },
    { id: "fortune", kind: "fortune", label: "今日籤詩", price: 10, available: true, why: null },
  ],
  frames: { owned: ["sakura"], selected: "sakura" },
  hungry: "hungry",
  recent: [
    { ts: iso(-2 * HOUR), delta: 10, label: "今天和她說過話" },
    { ts: iso(-5 * HOUR), delta: -10, label: "餵了一碗白飯" },
    { ts: iso(-DAY), delta: 10, label: "每日簽到" },
    { ts: iso(-DAY - HOUR), delta: -30, label: "抽了一張卡" },
  ],
  on_board: true,
  transfer_fee: 0.05,
};

const CARD: IssuedCard = {
  serial: "MYR-DEMO-0000-0007",
  issued_at: iso(-3 * HOUR),
  name: DEMO_MEMBER.name,
  avatar_url: null,
  number: 7,
  call_name: "鯨鯨",
  relationship: "好朋友",
  affinity: "很好",
  trust: "信任",
  familiarity: "熟",
  public_feeling: ME.card.public_feeling,
  line: "今天也一起聽歌吧。",
  stamp: null,
  fields: [],
  pose: "smile",
  frame: "sakura",
  foil: false,
  voided_at: null,
  rarity: "SR",
  parts: [{ id: "background.stars", slot: "background", name: "星點", rarity: "R" }],
  expression: "微笑",
};

const SLIP: IssuedFortune = {
  id: "f-demo",
  date: day(0),
  issued_at: iso(-HOUR),
  rank: "吉",
  title: "雨後的海",
  poem: ["雨停海更藍", "有人在等你", "慢慢走不急", "今夜有好眠"],
  fields: [
    { label: "心情", text: "會慢慢變好" },
    { label: "提醒", text: "記得喝水" },
  ],
  line: "今天也要好好吃飯喔。",
};

const QUESTS = {
  currency: COIN,
  quests: [
    { id: "new_topic", label: "跟她聊一件新的事", hint: "她判斷", done: true, by: null },
    { id: "together", label: "和大家一起玩一場", hint: "派對遊戲", done: false, by: null },
    { id: "her_pick", label: "跟她說說豆豆最近好不好", hint: "她想的", done: false, by: "her" },
  ],
  reward: 10,
  bonus: 15,
  bonus_done: false,
  earned_today: 10,
  cap: 45,
};

const PREDICTIONS = (space: { id: string; name: string } | null) => ({
  currency: COIN,
  predictions: [
    {
      id: "p-demo-1",
      ...(space ? { space } : {}),
      question: "這碗海龜湯今晚會被猜中嗎",
      options: [
        { label: "猜中", staked: 60, backers: 3, multiplier: 1.6 },
        { label: "沒猜中", staked: 30, backers: 1, multiplier: 2.9 },
      ],
      total: 90,
      closes_at: iso(2 * HOUR),
      status: "open",
      winner: null,
      settles: { kind: "soup", label: "照這碗海龜湯的結果自動結算" },
      settled_by: null,
      my_bet: { option: "猜中", amount: 20, outcome: "open", payout: null },
    },
  ],
});

const LOT = {
  id: "L-demo",
  week: 20_410,
  kind: "frame",
  name: "只此一件的卡框",
  detail: "得標的人有一個只有他有的卡框",
  state: "open",
  picked_by: "her",
  opens_at: iso(-20 * HOUR),
  ends_at: iso(30 * HOUR),
  extended: false,
  opening_bid: 50,
  step: 5,
  min_bid: 125,
  top: { amount: 120, name: "阿貓" },
  bids: 4,
  bidders: 3,
  winner: null,
  call_name: null,
  name_due: null,
  applied_until: null,
};

const AUCTION = {
  currency: COIN,
  running: true,
  lot: LOT,
  next: { opens_at: iso(5 * DAY), plan: null },
  mine: { amount: 100, leading: false, won: false },
  history: [
    { amount: 120, name: "阿貓", at: iso(-HOUR) },
    { amount: 100, name: DEMO_MEMBER.name, at: iso(-2 * HOUR) },
  ],
};

const LOTTERY = {
  currency: COIN,
  running: true,
  price: 10,
  per_person: 20,
  min_buyers: 3,
  prize_share: 0.7,
  week: 20_411,
  state: "open",
  draw_at: iso(3 * DAY),
  tickets: 23,
  buyers: 5,
  pot: 230,
  mine: { tickets: 3 },
  last: { week: 20_404, state: "drawn", drawn_at: iso(-4 * DAY), tickets: 40, buyers: 7, pot: 400, prize: 280, burned: 120, winner: "阿貓" },
};

const BIDS = {
  bids: [
    { lot: "L-demo", week: 20_410, kind: "frame", name: "只此一件的卡框", amount: 100, state: "outbid", at: iso(-2 * HOUR) },
  ],
};

const TICKETS = {
  weeks: [{ week: 20_411, draw_at: iso(3 * DAY), tickets: 3, paid: 30, state: "open", won: false, prize: 0 }],
};

const chance = (percent: number) => ({ percent, shown: percent.toFixed(2) });

const LISTED = [
  { ...CARD, kind: "daily", pity_hit: false, wished: [], price: 30, portrait: "fixed" },
  {
    ...CARD,
    serial: "MYR-DEMO-0000-0006",
    number: 6,
    kind: "drop",
    rarity: "SSR",
    foil: true,
    frame: null,
    issued_at: iso(-2 * DAY),
    parts: [{ id: "background.aurora", slot: "background", name: "極光", rarity: "SSR" }],
    pity_hit: true,
    wished: ["background.aurora"],
    price: 0,
    portrait: "fixed",
  },
  { ...CARD, serial: "MYR-DEMO-0000-0005", number: 5, kind: "daily", rarity: "N", frame: null, issued_at: iso(-4 * DAY), parts: [], pity_hit: false, wished: [], price: 30, portrait: "fixed" },
];

const CATALOGUE = {
  parts: [
    { id: "accessory.none", slot: "accessory", name: "無配件", rarity: "N", series: null, series_name: null, drop_only: false, blank: true, enabled: true, wishable: false },
    { id: "accessory.monocle", slot: "accessory", name: "單片眼鏡", rarity: "SR", series: "glasses", series_name: "眼鏡系列", drop_only: false, blank: false, enabled: true, wishable: true },
    { id: "background.stars", slot: "background", name: "星點", rarity: "R", series: "sky", series_name: "天空系列", drop_only: false, blank: false, enabled: true, wishable: true },
    { id: "background.aurora", slot: "background", name: "極光", rarity: "SSR", series: "sky", series_name: "天空系列", drop_only: false, blank: false, enabled: true, wishable: true },
  ],
  series: [
    { id: "glasses", name: "眼鏡系列", title: "眼鏡控" },
    { id: "sky", name: "天空系列", title: "摘星的人" },
  ],
};

const DEX = {
  parts: [
    { id: "background.stars", slot: "background", name: "星點", rarity: "R", series: "sky", count: 2, first_at: iso(-4 * DAY) },
    { id: "background.aurora", slot: "background", name: "極光", rarity: "SSR", series: "sky", count: 1, first_at: iso(-2 * DAY) },
  ],
  series: [
    { id: "sky", name: "天空系列", title: "摘星的人", owned: 2, total: 2, complete: true },
    { id: "glasses", name: "眼鏡系列", title: "眼鏡控", owned: 0, total: 1, complete: false },
  ],
  titles: [{ series: "sky", title: "摘星的人", public: true, earned_at: iso(-2 * DAY) }],
  legacy: null,
};

const ODDS = {
  rarities: [
    { rarity: "N", ...chance(70) },
    { rarity: "R", ...chance(22) },
    { rarity: "SR", ...chance(7) },
    { rarity: "SSR", ...chance(1) },
  ],
  pity: { after: 20, rarities: [{ rarity: "SR", ...chance(87.5) }, { rarity: "SSR", ...chance(12.5) }] },
  slots: [
    {
      slot: "background",
      name: "背景",
      parts: [
        { id: "background.stars", name: "星點", rarity: "R", series: "sky", series_name: "天空系列", ...chance(99) },
        { id: "background.aurora", name: "極光", rarity: "SSR", series: "sky", series_name: "天空系列", ...chance(1) },
      ],
      empty: null,
    },
  ],
  price: 30,
  per_day: 5,
};

const GIFTS_MINE = {
  open: true,
  currency: COIN,
  twd_per_coin: 1,
  big_gift_coins: 1000,
  gifts: [
    {
      id: "G-demo",
      item: "一杯熱可可",
      kind: "drink",
      kind_word: "喝的",
      tier: null,
      price: 60,
      twd: 60,
      status: "accepted",
      line: "暖暖的,謝謝你",
      favourite: true,
      answered_by: "her",
      created_at: iso(-DAY),
      expires_at: iso(-DAY + HOUR),
      answer_due: null,
      answered_at: iso(-DAY + HOUR),
    },
  ],
};

const GIFTS_PUBLIC = {
  favourites: [{ id: "P2", item: "一束花", kind: "thing", kind_word: "東西", line: "好香", favourite: true, at: iso(-3 * DAY), from: null }],
  recent: [
    { id: "P1", item: "一杯熱可可", kind: "drink", kind_word: "喝的", line: "暖暖的,謝謝你", favourite: false, at: iso(-DAY), from: DEMO_MEMBER.name },
    { id: "P2", item: "一束花", kind: "thing", kind_word: "東西", line: "好香", favourite: true, at: iso(-3 * DAY), from: null },
  ],
};

const FILES = {
  links: { available: true, scoped: true },
  quota: { used: 1, per_day: 20 },
  items: [
    {
      id: "01JZDEMO000000000000000001",
      filename: "豆豆的畫像.png",
      kind: "image",
      mime: "image/png",
      size: 182_044,
      source: "imagegen",
      made_at: iso(-DAY),
      expires_at: iso(6 * DAY),
      kept: false,
      made_in: "dm",
      visibility: "none",
      link_expires_at: null,
      listen_only: false,
      allowed: ["none", "person", "link"],
    },
  ],
};

const DANMAKU = {
  open: true,
  live: true,
  currency: COIN,
  price: 5,
  max_chars: 30,
  cooldown_s: 20,
  per_day: 20,
  sent_today: 1,
  wait_s: 0,
  balance: WALLET.balance,
  why: null,
};

const KARAOKE = { open: true, admin: false, preparing: false, songs: [], limits: { daily: 3, used: 0, max_minutes: 8 }, tolerance_cents: 50 };

const DEFAULT_SPACES = [
  { id: "S-bay", name: "鯨魚灣" },
  { id: "S-isle", name: "月光島" },
];

/** A handler over the routes above; `undefined` for any other. */
export function memberDemoAnswer(o: DemoOptions = {}) {
  const spaces = (o.spaces ?? DEFAULT_SPACES).map((s, i) => ({ ...s, platform: "discord", external_id: s.id, primary: i === 0, established: i === 0 }));
  let wallet: WalletView = { ...WALLET };
  let slip: IssuedFortune | null = null;
  const spaceOf = (url: URL) => spaces.find((s) => s.id === url.searchParams.get("space")) ?? spaces[0] ?? null;
  return (method: string, url: URL, body: unknown): { status?: number; body?: unknown } | undefined => {
    const path = url.pathname;
    switch (path) {
      case "/api/auth/methods":
        return { body: { token: true, discord: true } };
      case "/api/auth/session":
        return { status: 401, body: { error: "not signed in" } };
      case "/api/public/status":
        return { body: STATUS };
      case "/api/public/songs":
        return { body: SONGS };
      case "/api/public/gifts":
        return { body: GIFTS_PUBLIC };
      case "/api/public/cards/odds":
        return { body: ODDS };
      case "/api/member/session":
        return { body: DEMO_MEMBER };
      case "/api/member/spaces":
        return { body: { spaces, default: spaces[0]?.id ?? null } };
      case "/api/member/me":
        return { body: ME };
      case "/api/member/wallet":
        return { body: wallet };
      case "/api/member/quests":
        return o.quests === false ? undefined : { body: QUESTS };
      case "/api/member/fortune":
        return { body: { fortune: slip, price: 10 } };
      case "/api/member/checkin": {
        const withSlip = (body as { fortune?: boolean } | undefined)?.fortune === true;
        const gained = wallet.checked_in_today ? 0 : 10;
        wallet = { ...wallet, balance: wallet.balance + gained - (withSlip ? 10 : 0), checked_in_today: true, streak: wallet.streak + 1 };
        if (withSlip) slip = SLIP;
        return { body: { gained, streak: wallet.streak, balance: wallet.balance, ...(withSlip ? { fortune: SLIP, fortune_charged: 10 } : {}) } };
      }
      case "/api/member/feed":
        wallet = { ...wallet, balance: wallet.balance - 10 };
        return { body: { accepted: true, eaten: 1, charged: 10, balance: wallet.balance, message: "她吃得很開心" } };
      case "/api/member/board": {
        if (method !== "GET") return { body: { on_board: (body as { on: boolean }).on } };
        const all = url.searchParams.get("scope") === "all";
        const s = all ? null : spaceOf(url);
        return {
          body: {
            space: s,
            entries: [
              { rank: 1, name: "阿貓", spent: 340 },
              { rank: 2, name: DEMO_MEMBER.name, spent: 180 },
              { rank: 3, name: "匿名", spent: 120 },
            ],
          },
        };
      }
      case "/api/member/bounties":
        return {
          body: {
            bounties: [
              { id: "b1", task: "教她一個新的冷笑話", reward: 40, posted_at: iso(-DAY), expires_at: iso(3 * DAY) },
              { id: "b2", task: "推薦她一首下雨天的歌", reward: 25, posted_at: iso(-2 * DAY), expires_at: iso(2 * DAY) },
            ],
          },
        };
      case "/api/member/predictions":
        return { body: PREDICTIONS(spaceOf(url)) };
      case "/api/member/danmaku":
        return { body: DANMAKU };
      case "/api/member/card":
        return {
          body: { latest: CARD, today: 1, per_day: 5, prices: { card: 30, foil: 20 }, balance: wallet.balance, pity: { since: 6, pity: 20, until: 14 } },
        };
      case "/api/member/cards":
        return { body: { cards: LISTED } };
      case "/api/member/cards/catalogue":
        return { body: CATALOGUE };
      case "/api/member/cards/dex":
        return { body: DEX };
      case "/api/member/cards/pity":
        return { body: { since: 6, pity: 20, until: 14 } };
      case "/api/member/cards/wishlist":
        return { body: { parts: [{ id: "accessory.monocle", slot: "accessory", name: "單片眼鏡", rarity: "SR" }], max: 3 } };
      case "/api/member/gifts":
        return { body: GIFTS_MINE };
      case "/api/member/files":
        return { body: FILES };
      case "/api/member/github":
        return { body: { available: true, linked: null } };
      case "/api/member/karaoke":
        return { body: KARAOKE };
      case "/api/member/market/auction":
        return { body: AUCTION };
      case "/api/member/market/lottery":
        return method === "GET" ? { body: LOTTERY } : undefined;
      case "/api/member/market/bids":
        return { body: BIDS };
      case "/api/member/market/tickets":
        return { body: TICKETS };
      default:
        return undefined;
    }
  };
}

/** The live feed's first word: she is in voice, singing, nothing on video. */
export const DEMO_LIVE_HELLO = {
  type: "hello",
  snapshot: {
    presence: { place: "in_voice", game: null },
    activity: null,
    speaking: true,
    emotion: { name: "happy", intensity: 0.6 },
    line: { id: 1, text: "下一首要唱什麼呢", final: true, via: "voice" },
    pats: { recent: 2, open: true },
    video: { on: false, src: null },
  },
};
