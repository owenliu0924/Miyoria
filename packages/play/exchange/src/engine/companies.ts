// The local companies (docs/design/exchange.md §2.1, owner 2026-11-21): the five tied to her, priced
// by the simulator and nudged by the real things they stand for. Every one is made up; nothing here
// is a real company's mark, logo or data. Real stocks and crypto are `real/` instruments instead. Their character is only in
// these numbers: how much they follow the market (`beta`), how much they move on their own each
// round (`sigma`), and how many coins of net buying move them about one percent (`depth`).

export type Sector = "ai" | "staples" | "media" | "resources";

export interface CompanySpec {
  /** The ticker people type: four capital letters. */
  code: string;
  name: string;
  sector: Sector;
  /** One line for the company page. */
  blurb: string;
  /** How strongly the market factor moves it. */
  beta: number;
  /** Its own noise per round, as a log return's standard deviation. */
  sigma: number;
  /** Coins of net buying in one round that move it about `impact` (one percent by default). */
  depth: number;
  /** The first price, in cents (10000 = 100.00). */
  start: number;
}

export const SECTOR_LABEL: Readonly<Record<Sector, string>> = {
  ai: "AI",
  staples: "民生",
  media: "娛樂",
  resources: "資源",
};

export const COMPANIES: readonly CompanySpec[] = [
  {
    code: "DPSK",
    name: "DipSick AI",
    sector: "ai",
    blurb: "她的老家。波動大,消息多",
    beta: 1.3,
    sigma: 0.006,
    depth: 1500,
    start: 10000,
  },
  {
    code: "RICE",
    name: "白飯食品",
    sector: "staples",
    blurb: "穩,大家每天都要吃飯",
    beta: 0.6,
    sigma: 0.003,
    depth: 2000,
    start: 8000,
  },
  {
    code: "WHLE",
    name: "鯨落唱片",
    sector: "media",
    blurb: "跟著新歌起伏",
    beta: 0.9,
    sigma: 0.005,
    depth: 1500,
    start: 6000,
  },
  {
    code: "CUBE",
    name: "方塊礦業",
    sector: "resources",
    blurb: "景氣循環,偶爾出事故",
    beta: 1.1,
    sigma: 0.005,
    depth: 1500,
    start: 5000,
  },
  {
    code: "NAPS",
    name: "打盹床業",
    sector: "staples",
    blurb: "最穩的一家",
    beta: 0.5,
    sigma: 0.0025,
    depth: 2000,
    start: 7000,
  },
];

export const COMPANY_CODES: readonly string[] = COMPANIES.map((c) => c.code);

export function companyOf(code: string): CompanySpec | null {
  return COMPANIES.find((c) => c.code === code) ?? null;
}
