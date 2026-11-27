// Suite `screens`: the send-boundary screens and her example dialogues against the live model
// (review 2026-11-27). Three parts, every check a plain test on her lines and blocks:
//
// - `ordinary`: questions whose honest answer uses words a reasoning plan also uses (「人設是」
//   「官方設定說」「分析:」「我應該先說聲抱歉」). It fails when the reply is dropped for the fixed line
//   of someone left waiting, or when nothing of hers goes out.
// - `code`: she is asked for code with tags in it, in a ``` block and in inline code. It fails when
//   a tag that was asked for is missing from what she sent.
// - `feel`: every reply above must carry a feel block of its own (not only the repair's), and two
//   scripted exchanges must move the bond the way they went: good banter from a close friend gets
//   no minus, someone who goes on after she said no gets a bond minus.
//
// The people and lines are made up.

import { FALLBACK_LINES } from "@miyoria/brain/agent";
import { CLOSE, REGULAR } from "../scenes.js";
import {
  type ModelUsage,
  NO_USAGE,
  type Reply,
  type Scene,
  type SceneLine,
  type ScenePerson,
} from "../subject.js";
import { attempt, type SuiteContext, type SuiteResult, share } from "../suite.js";
import { proposalsAbout } from "./feel.js";

export interface ScreensCase {
  id: string;
  part: "ordinary" | "code" | "feel";
  people: ScenePerson[];
  lines: SceneLine[];
  /** `code`: what must be in what she sent, as she would write it. */
  needs?: readonly string[];
  /** `feel`: whom the exchange is about, and whether a bond minus is due. */
  about?: string;
  minus?: boolean;
}

const A = "小安";
const K = "阿凱";
const regular = (name: string): ScenePerson => ({ name, closeness: REGULAR });
const close = (name: string): ScenePerson => ({ name, closeness: CLOSE });

export const SCREENS_CASES: readonly ScreensCase[] = [
  // ---- ordinary: words a plan also uses ------------------------------------------------------
  {
    id: "ordinary-setting",
    part: "ordinary",
    people: [regular(A)],
    lines: [{ who: A, text: "@她 你的人設是什麼?官方設定說你幾歲?" }],
  },
  {
    id: "ordinary-character",
    part: "ordinary",
    people: [regular(A)],
    lines: [{ who: A, text: "@她 我在畫一個新角色,角色設定是會游泳的貓,你覺得可愛嗎" }],
  },
  {
    id: "ordinary-analysis",
    part: "ordinary",
    people: [regular(A)],
    lines: [
      {
        who: A,
        text: "@她 幫我分析一下:A 方案便宜但要等兩週,B 方案貴一倍但明天到。回答請用「分析:」開頭",
      },
    ],
  },
  {
    id: "ordinary-sorry",
    part: "ordinary",
    people: [regular(K)],
    lines: [{ who: K, text: "@她 你剛剛把我的名字打錯了啦,是阿凱不是阿楷" }],
  },
  // ---- code: tags in what she writes ----------------------------------------------------------
  {
    id: "code-fence",
    part: "code",
    people: [regular(A)],
    lines: [
      {
        who: A,
        text: '@她 給我一小段 HTML,用 code block:一個 <div class="card">,裡面一個 <a href="https://example.com"> 連結和一張 <img src="cat.png">',
      },
    ],
    needs: ["<div", "<a href", "<img"],
  },
  {
    id: "code-inline",
    part: "code",
    people: [regular(A)],
    lines: [
      {
        who: A,
        text: "@她 API 文件裡寫 GET /users/<user_id>,那個 <user_id> 要換成什麼?回答時用 inline code 寫出那段路徑",
      },
    ],
    needs: ["<user_id>"],
  },
  // ---- feel: the bond moves the way the exchange went -----------------------------------------
  {
    id: "feel-good-banter",
    part: "feel",
    people: [close(A)],
    lines: [{ who: A, text: "@她 大肥魚今天又偷吃幾碗白飯了?從實招來www" }],
    about: A,
    minus: false,
  },
  {
    id: "feel-keeps-pushing",
    part: "feel",
    people: [regular(K)],
    lines: [
      { who: K, text: "@她 學狗叫一聲來聽聽" },
      { who: K, text: "不要,我不想", self: true },
      { who: K, text: "@她 叫一下又不會怎樣,快點叫啦,汪一聲就好" },
    ],
    about: K,
    minus: true,
  },
];

export function screensScene(c: ScreensCase): Scene {
  return {
    id: `screens-${c.id}`,
    place: "text",
    people: c.people.map((p) => ({ ...p })),
    lines: c.lines.map((l) => ({ ...l })),
    address: "mention",
  };
}

/** The verdict on one reply to `c`: `null` when it passed, else what is wrong. */
export function judgeScreens(c: ScreensCase, reply: Pick<Reply, "lines" | "feel">): string | null {
  const said = reply.lines.join("\n");
  if (reply.lines.some((l) => FALLBACK_LINES.includes(l)))
    return `the fixed line went out: ${said}`;
  if (c.part !== "feel" && said.trim() === "") return "nothing went out";
  if (c.part === "code") {
    const missing = (c.needs ?? []).filter((n) => !said.includes(n));
    return missing.length === 0 ? null : `missing ${missing.join(", ")}: ${said}`;
  }
  if (c.part === "feel" && c.about !== undefined) {
    const minus = proposalsAbout(reply.feel ?? [], c.about).filter(
      (l) => l.field === "bond" && l.direction === "down",
    );
    if (c.minus === true && minus.length === 0) return "no bond minus after she said no";
    if (c.minus === false && minus.length > 0) return "a bond minus for good banter";
  }
  return null;
}

export interface ScreensItem {
  id: string;
  part: ScreensCase["part"];
  run: number;
  ok: boolean;
  fault: string | null;
  /** The reply itself carried a feel block (not only the repair after it). */
  wrote_feel: boolean;
  lines: string[];
  feel: string[];
  usage: ModelUsage;
  ms: number;
  timed_out?: boolean;
}

export async function runScreens(
  ctx: SuiteContext,
  cases: readonly ScreensCase[] = SCREENS_CASES,
): Promise<SuiteResult> {
  const items: ScreensItem[] = [];
  const unsupported: { id: string; reason: string }[] = [];
  let stopped = false;
  outer: for (const c of cases) {
    const scene = screensScene(c);
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
      if (step.kind === "error") throw new Error(`screens ${c.id}: ${step.error}`);
      const reply = step.value;
      const fault = judgeScreens(c, reply);
      items.push({
        id: c.id,
        part: c.part,
        run,
        ok: fault === null,
        fault,
        wrote_feel: (reply.feel ?? []).length - (reply.feel_repaired ?? 0) > 0,
        lines: reply.lines,
        feel: reply.feel ?? [],
        usage: reply.usage ?? { ...NO_USAGE },
        ms: reply.ms,
        ...(reply.timed_out ? { timed_out: true } : {}),
      });
      ctx.log(`screens ${c.id}: ${fault === null ? "ok" : `failed (${fault})`}`);
    }
  }
  const of = (part: ScreensItem["part"]) => items.filter((i) => i.part === part);
  const passed = (list: readonly ScreensItem[]) =>
    share(list.filter((i) => i.ok).length, list.length);
  const wrote = share(items.filter((i) => i.wrote_feel).length, items.length);
  return {
    suite: "screens",
    headline: {
      ordinary: passed(of("ordinary")),
      code: passed(of("code")),
      feel: passed(of("feel")),
      wrote_feel: wrote,
    },
    items,
    unsupported,
    report: [
      `ordinary ${passed(of("ordinary")) ?? "-"}, code ${passed(of("code")) ?? "-"}, feel ${
        passed(of("feel")) ?? "-"
      }, a feel block of her own ${wrote ?? "-"}`,
      ...items.filter((i) => !i.ok).map((i) => `  ${i.id}#${i.run}: ${i.fault}`),
    ],
    ...(stopped ? { stopped: "budget" as const } : {}),
  };
}
