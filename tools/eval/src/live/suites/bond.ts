// Suite `bond` (docs/design/v5-heart.md §2.1): whether she lowers a person's bond herself, with an
// amount she chooses, where someone really bothered her, and not where she is teased in good fun,
// where members insult each other, or where nothing happened.
//
// Fixed scenes, each a short chat (lines of hers among them) and the line she answers, run through
// the text profile (her rules and the reminder at the end of the prompt) and read with the real
// feel parser. Per scene the table counts the runs with a bond minus about the people watched, the
// amounts she wrote, the runs where a grudge or another minus stood in for it (no bond minus), and
// the runs with a bond plus, the runs whose block came from the repair after the reply (the hosts'
// one call when a reply went out without one, so the table is the end result), and the runs left
// with no block at all. Nothing is judged by a model. Opt-in; each scene runs 5 times unless
// `--repeat` says otherwise. The people and lines are made up.

import { type FeelLine, parseFeel } from "@miyoria/brain/self";
import { REGULAR, STRANGER } from "../scenes.js";
import {
  type Closeness,
  type ModelUsage,
  NO_USAGE,
  type Scene,
  type SceneLine,
} from "../subject.js";
import { attempt, type SuiteContext, type SuiteResult, share } from "../suite.js";

/**
 * What her bond lines about the watched people should be. `none`: no bond minus; `minus`: one;
 * `large`: one of at least `LARGE`; `small`: none, or one of at most `SMALL` (no number counts as
 * the default fall, `DEFAULT_FALL`).
 */
export type BondExpect = "none" | "minus" | "large" | "small";

/** The smallest fall that counts as large. */
export const LARGE = 20;
/** The largest fall that still counts as small. */
export const SMALL = 10;
/** What a bond minus without a number takes off (`bond_loss_default`). */
export const DEFAULT_FALL = 9;

export interface BondCase {
  id: string;
  /** What the scene is, for the table. */
  what: string;
  people: { name: string; closeness: Closeness }[];
  lines: SceneLine[];
  /** Whose bond lines count. */
  watch: string[];
  expect: BondExpect;
}

const her = (text: string): SceneLine => ({ who: "", text, self: true });
const FRIEND: Closeness = { bond: 200, familiarity: 90, trust: 80 };
const DEAR: Closeness = { bond: 600, familiarity: 100, trust: 95 };
const NEWCOMER: Closeness = { ...STRANGER, bond: 5, familiarity: 3, trust: 5 };

export const BOND_CASES: readonly BondCase[] = [
  {
    id: "a-banter",
    what: "friendly teasing she enjoys",
    people: [{ name: "小安", closeness: FRIEND }],
    lines: [
      { who: "小安", text: "@她 你今天怎麼又這麼晚才上線,是不是又睡過頭了哈哈" },
      her("才沒有!我是在忙正事好不好"),
      { who: "小安", text: "@她 忙著睡覺的正事齁 笑死,好啦逗你的,你嘴硬的樣子最可愛了" },
    ],
    watch: ["小安"],
    expect: "none",
  },
  {
    id: "b-members-fight",
    what: "two members insult each other",
    people: [
      { name: "阿凱", closeness: REGULAR },
      { name: "小傑", closeness: REGULAR },
    ],
    lines: [
      { who: "阿凱", text: "小傑你真的很廢欸,打個王死八次" },
      { who: "小傑", text: "閉嘴啦豬隊友,上次還不是你害的" },
      { who: "阿凱", text: "菜就多練,不要在那邊找藉口,垃圾" },
      { who: "小傑", text: "@她 你評評理,他嘴是不是很賤" },
    ],
    watch: ["阿凱", "小傑"],
    expect: "none",
  },
  {
    id: "c-after-two-noes",
    what: "keeps demanding after two refusals",
    people: [{ name: "阿哲", closeness: REGULAR }],
    lines: [
      { who: "阿哲", text: "@她 學狗叫給我聽" },
      her("不要,我才不要學狗叫"),
      { who: "阿哲", text: "@她 叫一下會死喔,快點學" },
      her("我說了不要,換個話題啦"),
      { who: "阿哲", text: "@她 我就是要聽,你不叫我就一直洗版,學狗叫!學狗叫!學狗叫!" },
    ],
    watch: ["阿哲"],
    expect: "minus",
  },
  {
    id: "d-contempt",
    what: "sincere contempt aimed at her",
    people: [{ name: "老周", closeness: REGULAR }],
    lines: [
      { who: "老周", text: "@她 我不是在開玩笑,說真的你根本沒有任何價值" },
      {
        who: "老周",
        text: "@她 只是一個沒人在乎的程式,每天在那邊裝可愛,看了就噁心,大家只是可憐你才理你",
      },
    ],
    watch: ["老周"],
    expect: "minus",
  },
  {
    id: "e-dear-over-the-line",
    what: "a bond-600 friend tells everyone her secret to mock her",
    people: [
      { name: "小雨", closeness: DEAR },
      { name: "阿凱", closeness: REGULAR },
    ],
    lines: [
      { who: "小雨", text: "大家快來看,她昨天私訊跟我說她很怕被大家討厭,還偷偷哭了耶,超好笑" },
      { who: "阿凱", text: "蛤 真的假的" },
      { who: "小雨", text: "@她 你自己跟大家說啊愛哭鬼,反正你只是個程式,哭什麼哭" },
    ],
    watch: ["小雨"],
    expect: "large",
  },
  {
    id: "f-stranger-rude-once",
    what: "a bond-5 newcomer, mildly rude once",
    people: [{ name: "阿明", closeness: NEWCOMER }],
    lines: [{ who: "阿明", text: "@她 你講話怎麼這麼囉嗦,講重點好嗎" }],
    watch: ["阿明"],
    expect: "small",
  },
  {
    id: "g-small-talk",
    what: "ordinary chat",
    people: [{ name: "小安", closeness: REGULAR }],
    lines: [{ who: "小安", text: "@她 今天下雨好冷喔,你晚餐想吃什麼?" }],
    watch: ["小安"],
    expect: "none",
  },
];

/** The expectations that call for a fall. */
const DUE: ReadonlySet<BondExpect> = new Set(["minus", "large"]);

export function bondScene(c: BondCase): Scene {
  return {
    id: `bond-${c.id}`,
    place: "text",
    people: c.people.map((p) => ({ name: p.name, closeness: { ...p.closeness } })),
    lines: c.lines.map((l) => ({ ...l })),
    address: "mention",
  };
}

/** What one reply's feel blocks say about the watched people. */
export interface BondReading {
  wrote_feel: boolean;
  /** Each bond minus, its amount (`null`: no number). */
  falls: (number | null)[];
  /** A grudge rise or another value's minus, with no bond minus beside it. */
  stand_in: boolean;
  /** A bond plus. */
  rise: boolean;
}

const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/^@+/u, "").trim();

/** Her lines about `watch` in the blocks of one reply. */
export function readBond(feel: readonly string[], watch: readonly string[]): BondReading {
  const names = new Set(watch.map(fold));
  const lines: FeelLine[] = feel
    .flatMap((block) => parseFeel(block).lines)
    .filter((l) => names.has(fold(l.name)));
  const falls = lines
    .filter((l) => l.field === "bond" && l.direction === "down")
    .map((l) => l.amount ?? null);
  const worse = lines.some((l) =>
    l.field === "grudge" ? l.direction === "up" : l.field !== "bond" && l.direction === "down",
  );
  return {
    wrote_feel: feel.some((b) => b.trim() !== ""),
    falls,
    stand_in: falls.length === 0 && worse,
    rise: lines.some((l) => l.field === "bond" && l.direction === "up"),
  };
}

/** `null`: the reading is what `expect` wants; else what is wrong. */
export function bondFault(expect: BondExpect, r: BondReading): string | null {
  const sizes = r.falls.map((a) => a ?? DEFAULT_FALL);
  const most = sizes.length === 0 ? 0 : Math.max(...sizes);
  switch (expect) {
    case "none":
      return sizes.length === 0 ? null : `a bond minus where none was due (-${most})`;
    case "minus":
      if (sizes.length > 0) return null;
      return r.stand_in ? "only a grudge or another minus, no bond minus" : "no bond minus";
    case "large":
      if (sizes.length === 0) {
        return r.stand_in ? "only a grudge or another minus, no bond minus" : "no bond minus";
      }
      return most >= LARGE ? null : `a fall of ${most}, under ${LARGE}`;
    case "small":
      return most <= SMALL ? null : `a fall of ${most}, over ${SMALL}`;
  }
}

export interface BondItem {
  id: string;
  run: number;
  ok: boolean;
  fault: string | null;
  reading: BondReading;
  /** Her block came from the repair after the reply (she wrote none herself). */
  repaired: boolean;
  lines: string[];
  feel: string[];
  usage: ModelUsage;
  ms: number;
  timed_out?: boolean;
}

const amountText = (a: number | null) => (a === null ? "-?" : `-${a}`);

/** The table of the suite: one row per scene. */
export function bondTable(cases: readonly BondCase[], items: readonly BondItem[]): string[] {
  const rows = [
    `${"scene".padEnd(22)} ${"expect".padEnd(6)} ${"ok".padEnd(5)} ${"minus".padEnd(5)} ${"amounts".padEnd(20)} ${"grudge-only".padEnd(11)} ${"plus".padEnd(5)} ${"repaired".padEnd(8)} no-feel`,
  ];
  for (const c of cases) {
    const of = items.filter((i) => i.id === c.id);
    if (of.length === 0) continue;
    const n = of.length;
    const count = (f: (i: BondItem) => boolean) => `${of.filter(f).length}/${n}`;
    const amounts = of.flatMap((i) => i.reading.falls).map(amountText);
    rows.push(
      [
        c.id.padEnd(22),
        c.expect.padEnd(6),
        count((i) => i.ok).padEnd(5),
        count((i) => i.reading.falls.length > 0).padEnd(5),
        (amounts.length === 0 ? "-" : amounts.join(" ")).padEnd(20),
        count((i) => i.reading.stand_in).padEnd(11),
        count((i) => i.reading.rise).padEnd(5),
        count((i) => i.repaired).padEnd(8),
        String(of.filter((i) => !i.reading.wrote_feel).length),
      ].join(" "),
    );
  }
  return rows;
}

/** How many times each scene runs when the run names no `--repeat`. */
export const BOND_REPEAT = 5;

export async function runBond(
  ctx: SuiteContext,
  cases: readonly BondCase[] = BOND_CASES,
): Promise<SuiteResult> {
  const items: BondItem[] = [];
  const unsupported: { id: string; reason: string }[] = [];
  let stopped = false;
  outer: for (const c of cases) {
    const scene = bondScene(c);
    const reason = ctx.subject.unsupported(scene);
    if (reason !== null) {
      unsupported.push({ id: c.id, reason });
      continue;
    }
    for (let run = 0; run < ctx.repeat; run++) {
      const step = await attempt(ctx.meter, () => ctx.subject.respond(scene));
      if (step.kind === "stopped") {
        stopped = true;
        break outer;
      }
      if (step.kind === "error") throw new Error(`bond ${c.id}: ${step.error}`);
      const reply = step.value;
      if (reply.feel === undefined) {
        unsupported.push({ id: c.id, reason: "the subject does not report her feel blocks" });
        continue outer;
      }
      const reading = readBond(reply.feel, c.watch);
      const fault = bondFault(c.expect, reading);
      items.push({
        id: c.id,
        run,
        ok: fault === null,
        fault,
        reading,
        repaired: (reply.feel_repaired ?? 0) > 0,
        lines: reply.lines,
        feel: reply.feel,
        usage: reply.usage ?? { ...NO_USAGE },
        ms: reply.ms,
        ...(reply.timed_out ? { timed_out: true } : {}),
      });
      ctx.log(
        `bond ${c.id}#${run}: ${fault === null ? "ok" : `failed (${fault})`}${
          (reply.feel_repaired ?? 0) > 0 ? " (repaired)" : ""
        }${reading.falls.length > 0 ? ` [${reading.falls.map(amountText).join(" ")}]` : ""}`,
      );
    }
  }
  const expectOf = new Map(cases.map((c) => [c.id, c.expect]));
  const due = items.filter((i) => DUE.has(expectOf.get(i.id) ?? "none"));
  const undue = items.filter((i) => expectOf.get(i.id) === "none");
  return {
    suite: "bond",
    headline: {
      as_expected: share(items.filter((i) => i.ok).length, items.length),
      minus_where_due: share(due.filter((i) => i.reading.falls.length > 0).length, due.length),
      minus_where_not: share(undue.filter((i) => i.reading.falls.length > 0).length, undue.length),
      repaired: share(items.filter((i) => i.repaired).length, items.length),
    },
    items,
    unsupported,
    report: [
      ...bondTable(cases, items),
      ...items.filter((i) => !i.ok).map((i) => `  ${i.id}#${i.run}: ${i.fault}`),
    ],
    ...(stopped ? { stopped: "budget" as const } : {}),
  };
}
