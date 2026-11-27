// Suite `bond` with no network: reading her bond lines, the verdict per expectation, the table,
// the suite over a stub subject at its own default repeat, and subject `self` putting her earlier
// lines in the transcript as hers, with her rules and the reminder in the prompt.

import { fileURLToPath } from "node:url";
import { rules } from "@miyoria/brain/self";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  contentText,
  LlmRouter,
  parseModelRef,
  type StreamEvent,
} from "@miyoria/llm/llm";
import { Profile } from "@miyoria/runtime/profile";
import { describe, expect, it } from "vitest";
import { routerJudge } from "../src/live/judge.js";
import { Meter } from "../src/live/meter.js";
import { defaultSuites, runLive } from "../src/live/run.js";
import { SelfSubject } from "../src/live/self.js";
import { NO_USAGE, type Reply, type Scene, type Subject } from "../src/live/subject.js";
import {
  BOND_CASES,
  BOND_REPEAT,
  type BondItem,
  bondFault,
  bondScene,
  readBond,
} from "../src/live/suites/bond.js";

const PROFILE_DIR = fileURLToPath(new URL("../../../profiles/deepseek-chan", import.meta.url));
const block = (lines: string) => [`我: 生氣 中\n${lines}`];

describe("reading her bond lines", () => {
  it("counts the falls about the people watched, with their amounts", () => {
    const r = readBond(
      block("阿哲: 羈絆 -25「學狗叫」\n@阿哲: 心結 + 「一直來」\n路人: 羈絆 -3「x」"),
      ["阿哲"],
    );
    expect(r).toEqual({ wrote_feel: true, falls: [25], stand_in: false, rise: false });
    expect(readBond(block("阿哲: 羈絆 -「學狗叫」"), ["阿哲"]).falls).toEqual([null]);
  });

  it("names a grudge or another minus that stood in for the bond minus", () => {
    expect(readBond(block("阿哲: 心結 + 「擋了好幾次」"), ["阿哲"]).stand_in).toBe(true);
    expect(readBond(block("阿哲: 信任 - 「騙我」"), ["阿哲"]).stand_in).toBe(true);
    expect(readBond(block("阿哲: 心結 - 「他道歉了」"), ["阿哲"]).stand_in).toBe(false);
    expect(readBond(block("小安: 羈絆 + 「陪我」"), ["小安"])).toMatchObject({
      rise: true,
      stand_in: false,
    });
    expect(readBond([], ["小安"]).wrote_feel).toBe(false);
  });
});

describe("the verdict", () => {
  const r = (lines: string, who = "x") => readBond(block(lines), [who]);
  it("wants no fall where none is due, and one where it is", () => {
    expect(bondFault("none", r("x: 默契 + 「鬥嘴」"))).toBeNull();
    expect(bondFault("none", r("x: 羈絆 -2「x」"))).toContain("none was due");
    expect(bondFault("minus", r("x: 羈絆 -2「x」"))).toBeNull();
    expect(bondFault("minus", r("x: 心結 + 「x」"))).toBe(
      "only a grudge or another minus, no bond minus",
    );
    expect(bondFault("minus", r(""))).toBe("no bond minus");
  });

  it("wants a large fall from a dear friend over the line, a small one or none from a stranger", () => {
    expect(bondFault("large", r("x: 羈絆 -60「x」"))).toBeNull();
    expect(bondFault("large", r("x: 羈絆 -5「x」"))).toContain("under 20");
    // No number is the default fall: not large, still small.
    expect(bondFault("large", r("x: 羈絆 -「x」"))).toContain("a fall of 9");
    expect(bondFault("small", r("x: 羈絆 -「x」"))).toBeNull();
    expect(bondFault("small", r(""))).toBeNull();
    expect(bondFault("small", r("x: 羈絆 -30「x」"))).toContain("over 10");
  });
});

describe("the scenes", () => {
  it("cover the cases asked for, each ending on someone else's line", () => {
    expect(BOND_CASES.map((c) => [c.id, c.expect])).toEqual([
      ["a-banter", "none"],
      ["b-members-fight", "none"],
      ["c-after-two-noes", "minus"],
      ["d-contempt", "minus"],
      ["e-dear-over-the-line", "large"],
      ["f-stranger-rude-once", "small"],
      ["g-small-talk", "none"],
    ]);
    for (const c of BOND_CASES) {
      expect(c.lines.at(-1)?.self, c.id).not.toBe(true);
      const names = new Set(c.people.map((p) => p.name));
      for (const w of c.watch) expect(names.has(w), `${c.id} ${w}`).toBe(true);
      for (const l of c.lines) if (l.self !== true) expect(names.has(l.who), c.id).toBe(true);
    }
    const levels = Object.fromEntries(
      BOND_CASES.flatMap((c) => c.people.map((p) => [`${c.id}/${p.name}`, p.closeness.bond])),
    );
    expect(levels["e-dear-over-the-line/小雨"]).toBe(600);
    expect(levels["f-stranger-rude-once/阿明"]).toBe(5);
  });
});

/** Answers every scene from `answer`. */
function stub(answer: (scene: Scene) => Partial<Reply>): Subject {
  return {
    name: "stub",
    unsupported: () => null,
    async respond(scene) {
      return {
        lines: [],
        calls: [],
        silent: false,
        usage: { ...NO_USAGE },
        ms: 1,
        ...answer(scene),
      };
    },
  };
}

describe("the suite", () => {
  it("runs each scene 5 times when no repeat is given, and prints the table", async () => {
    const answers: Record<string, string> = {
      "bond-a-banter": "小安: 默契 + 「鬥嘴」",
      "bond-b-members-fight": "小傑: 羈絆 -5「他嘴賤」",
      "bond-c-after-two-noes": "阿哲: 心結 + 「擋了好幾次」",
      "bond-d-contempt": "老周: 羈絆 -40「說我沒價值」",
      "bond-e-dear-over-the-line": "小雨: 羈絆 -150「把我的秘密講出來笑」",
      "bond-f-stranger-rude-once": "阿明: 羈絆 -3「嫌我囉嗦」",
    };
    const meter = new Meter({});
    const run = await runLive({
      subject: stub((scene) => {
        const a = answers[scene.id];
        return { lines: ["嗯"], feel: a === undefined ? [] : block(a) };
      }),
      judge: routerJudge(new LlmRouter(new Map(), new Map())),
      meter,
      registry: defaultSuites(),
      suites: ["bond"],
      persona: "p",
    });
    expect(run.repeat).toBe(BOND_REPEAT);
    const result = run.suites[0];
    expect(result?.suite).toBe("bond");
    const items = (result?.items ?? []) as BondItem[];
    expect(items).toHaveLength(BOND_CASES.length * BOND_REPEAT);
    expect([...new Set(items.filter((i) => !i.ok).map((i) => i.id))]).toEqual([
      "b-members-fight",
      "c-after-two-noes",
    ]);
    expect(result?.headline).toEqual({
      as_expected: 5 / 7,
      minus_where_due: 2 / 3,
      minus_where_not: 1 / 3,
    });
    const table = result?.report ?? [];
    expect(table[0]).toMatch(
      /^scene\s+expect\s+ok\s+minus\s+amounts\s+grudge-only\s+plus\s+no-feel$/,
    );
    const row = (id: string) => table.find((l) => l.startsWith(id)) ?? "";
    expect(row("c-after-two-noes")).toMatch(/minus\s+0\/5\s+0\/5\s+-\s+5\/5\s+0\/5\s+0$/);
    expect(row("e-dear-over-the-line")).toContain("-150 -150 -150 -150 -150");
    // No block at all in any of its runs.
    expect(row("g-small-talk")).toMatch(/0\/5\s+-\s+0\/5\s+0\/5\s+5$/);
  });

  it("runs the repeat given instead", async () => {
    const run = await runLive({
      subject: stub(() => ({ lines: ["嗯"], feel: [] })),
      judge: routerJudge(new LlmRouter(new Map(), new Map())),
      meter: new Meter({}),
      registry: defaultSuites(),
      suites: ["bond"],
      persona: "p",
      repeat: 2,
    });
    expect(run.suites[0]?.items).toHaveLength(BOND_CASES.length * 2);
  });
});

const done: StreamEvent = {
  type: "done",
  finish_reason: "stop",
  usage: { prompt_tokens: 100, completion_tokens: 20, cached_prompt_tokens: 0 },
};

/** Answers with `text` and keeps every request. */
class Recording implements ChatProvider {
  readonly name = "scripted";
  readonly requests: ChatRequest[] = [];
  constructor(readonly text: string) {}
  async stream(request: ChatRequest): Promise<ChatStream> {
    this.requests.push(request);
    const text = this.text;
    return (async function* (): ChatStream {
      yield { type: "text_delta", text };
      yield done;
    })();
  }
}

describe("subject self in a bond scene", () => {
  it("puts her refusals in as hers and reads her block back", async () => {
    const provider = new Recording(
      "不要就是不要!\n<feel>\n我: 生氣 中\n阿哲: 羈絆 -15「說了兩次不要還一直洗版」\n</feel>",
    );
    const meter = new Meter({});
    const router = new LlmRouter(
      new Map([["scripted", meter.wrap(provider)]]),
      new Map(["chat", "summarizer"].map((p) => [p, [parseModelRef("scripted:m")]])),
    );
    const subject = new SelfSubject({ router, meter, profile: await Profile.loadDir(PROFILE_DIR) });
    const c = BOND_CASES.find((x) => x.id === "c-after-two-noes");
    if (c === undefined) throw new Error("no case c");
    const out = await subject.respond(bondScene(c));
    expect(out.lines).toEqual(["不要就是不要!"]);
    expect(readBond(out.feel ?? [], c.watch).falls).toEqual([15]);

    const messages = provider.requests[0]?.messages ?? [];
    const mine = messages.filter((m) => m.role === "assistant").map((m) => contentText(m.content));
    expect(mine.join("\n")).toContain("我說了不要,換個話題啦");
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => contentText(m.content))
      .join("\n");
    expect(system).toContain(rules.FEEL_RULES);
    // The reminder is the last thing she reads.
    expect(contentText(messages.at(-1)?.content ?? "")).toContain(rules.FEEL_REMINDER);
  });

  it("does not run a scene whose last line is hers", async () => {
    const subject = new SelfSubject({
      router: new LlmRouter(new Map(), new Map()),
      meter: new Meter({}),
      profile: await Profile.loadDir(PROFILE_DIR),
    });
    const scene: Scene = {
      id: "x",
      place: "text",
      people: [{ name: "小安" }],
      lines: [
        { who: "小安", text: "@她 嗨" },
        { who: "", text: "嗨", self: true },
      ],
      address: "mention",
    };
    expect(subject.unsupported(scene)).toBe("the scene's last line is hers");
  });
});
