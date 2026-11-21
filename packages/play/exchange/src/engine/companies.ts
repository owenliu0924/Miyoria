// The eight listed companies (docs/design/exchange.md §2.1). Every one is made up: the names are
// parodies, and nothing here is a real company's mark, logo or data. Their character is only in
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
    code: "CLSD",
    name: "ClosedAI",
    sector: "ai",
    blurb: "波動大,董事會常出事",
    beta: 1.3,
    sigma: 0.006,
    depth: 1500,
    start: 12000,
  },
  {
    code: "GOGL",
    name: "Goggle",
    sector: "ai",
    blurb: "大型股,比較穩,常收掉產品",
    beta: 1.0,
    sigma: 0.004,
    depth: 2500,
    start: 15000,
  },
  {
    code: "NVDY",
    name: "Envydia",
    sector: "ai",
    blurb: "漲最兇也跌最兇",
    beta: 1.5,
    sigma: 0.007,
    depth: 1500,
    start: 20000,
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
