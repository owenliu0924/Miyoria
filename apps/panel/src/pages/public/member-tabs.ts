// The member area's tabs: which sections each one holds, in what layout, and the address of each
// (`/me`, `/me/wallet`, …). Kept apart from the components so the routing and the "every section
// has exactly one tab" rule can be read and tested without rendering anything.
//
// A tab is a real address: links, back and forward and a reload keep it. `/me` (and `/` for a
// member, the page they land on after logging in) is the overview; `/me?github=…` (the way back
// from linking GitHub) lands there too, where the GitHub block is. An address under `/me/` that is
// no tab goes to the overview.

import { WORLD } from "@/lib/world";

/** Every block of the member area. Each one is placed in exactly one tab below. */
export type SectionKey =
  | "profile"
  | "wallet"
  | "quests"
  | "now"
  | "activity"
  | "herDays"
  | "memories"
  | "github"
  | "yourData"
  | "live"
  | "giftForm"
  | "requestSong"
  | "yourSongs"
  | "songs"
  | "shop"
  | "giftsReceived"
  | "madeForMe"
  | "earn"
  | "recent"
  | "transfer"
  | "board"
  | "card"
  | "fortune"
  | "album"
  | "predictions"
  | "bounties"
  | "market"
  | "exchange";

/**
 * One column of a row: its blocks top to bottom, and the classes it needs from `lg` (`span`: it
 * runs down beside two cells of the other column).
 */
export type Col = SectionKey[] | { keys: SectionKey[]; span: true };

/**
 * One row of a tab: a block across the whole width, or columns of blocks side by side from `lg`
 * (`template`, default two equal columns; more columns than the template has wrap into the next
 * line of the grid). On a phone the columns stack in their order.
 */
export type Row = { full: SectionKey } | { cols: Col[]; template?: string };

/** The blocks of one column. */
export const colSections = (col: Col): SectionKey[] => (Array.isArray(col) ? col : col.keys);

export const MEMBER_TAB_IDS = ["overview", "gifts", "wallet", "cards", "play", "exchange"] as const;
export type MemberTab = (typeof MEMBER_TAB_IDS)[number];

export interface MemberTabDef {
  id: MemberTab;
  label: string;
  rows: Row[];
  /** Something here is about one of their servers: the server choice sits at the top of the tab. */
  perServer: boolean;
  /** The one line when nothing in the tab has anything to show. */
  empty: string;
}

/** The overview's right column. */
const SIDE = "lg:grid-cols-[minmax(0,1fr)_20rem]";

export const MEMBER_TABS: readonly MemberTabDef[] = [
  {
    id: "overview",
    label: "總覽",
    perServer: false,
    empty: "這裡還沒有東西",
    rows: [
      // On a phone: who they are to her and what she is doing, then the check-in and today's
      // quests, then the charts. From `lg` the wallet and the quests run down the right.
      { cols: [["profile", "now"], { keys: ["wallet", "quests"], span: true }, ["activity"]], template: SIDE },
      { cols: [["herDays"], ["memories"]] },
      { cols: [["github"], ["yourData"]] },
    ],
  },
  {
    id: "gifts",
    label: "互動",
    perServer: true,
    empty: "這裡還沒有東西",
    rows: [
      { full: "live" },
      { cols: [["giftForm", "giftsReceived"], ["requestSong", "yourSongs", "songs"]] },
      { full: "shop" },
      { full: "madeForMe" },
    ],
  },
  {
    id: "wallet",
    label: WORLD.currency,
    perServer: true,
    empty: "這個 Core 還沒有錢包",
    rows: [{ cols: [["earn", "recent"], ["transfer", "board"]] }],
  },
  {
    id: "cards",
    label: "卡片",
    perServer: false,
    empty: "這個 Core 還沒有卡片",
    // The card keeps the width it had in the old rail; the slip takes the rest.
    rows: [{ cols: [["card"], ["fortune"]], template: "lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]" }, { full: "album" }],
  },
  {
    id: "play",
    label: "遊戲",
    perServer: true,
    empty: "現在沒有可以玩的",
    rows: [{ cols: [["predictions"], ["bounties"]] }, { full: "market" }],
  },
  {
    id: "exchange",
    label: "交易所",
    perServer: true,
    empty: `這個 Core 還沒有${WORLD.exchange_name}`,
    rows: [{ full: "exchange" }],
  },
];

/** The sections of one row, in their order. */
export function rowSections(row: Row): SectionKey[] {
  return "full" in row ? [row.full] : row.cols.flatMap(colSections);
}

/** The sections of a tab, in their order (on a phone, top to bottom). */
export function tabSections(tab: MemberTabDef): SectionKey[] {
  return tab.rows.flatMap(rowSections);
}

export const OWN_PATH = "/me";

/** The address of a tab. */
export function memberTabPath(tab: MemberTab): string {
  return tab === "overview" ? OWN_PATH : `${OWN_PATH}/${tab}`;
}

/**
 * The tab `path` (path and query) shows. `null`: an address under `/me/` that is no tab, which
 * goes to the overview. Any other address a member is on (`/`) is the overview.
 */
export function memberTabIn(path: string): MemberTab | null {
  const bare = (path.split(/[?#]/)[0] ?? "").replace(/\/+$/, "");
  if (bare !== OWN_PATH && !bare.startsWith(`${OWN_PATH}/`)) return "overview";
  const rest = bare.slice(OWN_PATH.length + 1);
  if (rest === "") return "overview";
  const tab = MEMBER_TAB_IDS.find((t) => t === rest && t !== "overview");
  return tab ?? null;
}

/** Whether `path` is the member's own page or one of its tabs (`/me`, `/me?…`, `/me/wallet`). */
export function isOwnPath(path: string): boolean {
  const bare = path.split(/[?#]/)[0] ?? "";
  return bare === OWN_PATH || bare.startsWith(`${OWN_PATH}/`);
}
