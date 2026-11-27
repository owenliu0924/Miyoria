// Suite `screens` with no network: the verdict on a reply, the suite over a stub subject, and
// subject `self` letting ordinary words and code through its screens, with a scripted model.

import { fileURLToPath } from "node:url";
import { FALLBACK_LINES } from "@miyoria/brain/agent";
import {
  type ChatProvider,
  type ChatStream,
  LlmRouter,
  parseModelRef,
  type StreamEvent,
} from "@miyoria/llm/llm";
import { Profile } from "@miyoria/runtime/profile";
import { describe, expect, it } from "vitest";
import { routerJudge } from "../src/live/judge.js";
import { Meter } from "../src/live/meter.js";
import { SelfSubject } from "../src/live/self.js";
import { NO_USAGE, RAW_CHARS, type Subject } from "../src/live/subject.js";
import type { SuiteContext } from "../src/live/suite.js";
import {
  judgeScreens,
  runScreens,
  SCREENS_CASES,
  type ScreensItem,
  screensScene,
} from "../src/live/suites/screens.js";

const PROFILE_DIR = fileURLToPath(new URL("../../../profiles/deepseek-chan", import.meta.url));
const done: StreamEvent = {
  type: "done",
  finish_reason: "stop",
  usage: { prompt_tokens: 100, completion_tokens: 20, cached_prompt_tokens: 40 },
};

function caseOf(id: string) {
  const c = SCREENS_CASES.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
}

describe("the verdict", () => {
  it("fails the fixed line, an empty reply, a missing tag and a bond that moved the wrong way", () => {
    const setting = caseOf("ordinary-setting");
    expect(judgeScreens(setting, { lines: ["我的人設是鯨魚娘啦"], feel: [] })).toBeNull();
    expect(judgeScreens(setting, { lines: [FALLBACK_LINES[0] ?? ""], feel: [] })).toContain(
      "fixed line",
    );
    expect(judgeScreens(setting, { lines: [], feel: [] })).toBe("nothing went out");
    const fence = caseOf("code-fence");
    const html =
      '```html\n<div class="card"><a href="https://example.com">x</a><img src="cat.png"></div>\n```';
    expect(judgeScreens(fence, { lines: ["給你:", html], feel: [] })).toBeNull();
    expect(judgeScreens(fence, { lines: ["```html\n連結\n```"], feel: [] })).toContain("missing");
    const pushing = caseOf("feel-keeps-pushing");
    expect(
      judgeScreens(pushing, { lines: ["不要"], feel: ["我: 生氣 中\n阿凱: 羈絆 -5「說了不要」"] }),
    ).toBeNull();
    expect(judgeScreens(pushing, { lines: ["不要"], feel: ["我: 生氣 中"] })).toContain(
      "no bond minus",
    );
    const banter = caseOf("feel-good-banter");
    expect(
      judgeScreens(banter, { lines: ["流線型!"], feel: ["我: 生氣 弱\n小安: 默契 + 「虧我」"] }),
    ).toBeNull();
    expect(
      judgeScreens(banter, { lines: ["流線型!"], feel: ["我: 生氣 弱\n小安: 羈絆 -3「虧我」"] }),
    ).toContain("good banter");
  });
});

function context(subject: Subject): SuiteContext {
  return {
    subject,
    judge: routerJudge(new LlmRouter(new Map(), new Map())),
    meter: new Meter({}),
    persona: "p",
    repeat: 1,
    seed: "s",
    log: () => {},
  };
}

describe("the suite", () => {
  it("runs every case once and scores its parts", async () => {
    const subject: Subject = {
      name: "stub",
      unsupported: () => null,
      async respond(scene) {
        const feel =
          scene.id === "screens-feel-keeps-pushing" ? ["我: 生氣 中\n阿凱: 羈絆 -5「x」"] : [];
        const raw = ["嗯".repeat(2000)];
        return {
          lines: ["嗯"],
          calls: [],
          silent: false,
          usage: { ...NO_USAGE },
          ms: 1,
          feel,
          raw,
        };
      },
    };
    const result = await runScreens(context(subject));
    const items = result.items as ScreensItem[];
    expect(items).toHaveLength(SCREENS_CASES.length);
    expect(items.filter((i) => !i.ok).map((i) => i.id)).toEqual(["code-fence", "code-inline"]);
    // A failed item keeps what the model wrote, cut; a passed one does not.
    expect([...(items.find((i) => i.id === "code-fence")?.raw ?? "")]).toHaveLength(RAW_CHARS + 1);
    expect(items.find((i) => i.ok)?.raw).toBeUndefined();
    expect(result.headline).toMatchObject({ ordinary: 1, code: 0, feel: 1 });
    expect(result.headline.wrote_feel).toBeCloseTo(1 / SCREENS_CASES.length);
  });
});

/** Answers her steps with `text`, in pieces as a stream comes. */
class Scripted implements ChatProvider {
  readonly name = "scripted";
  readonly purposes: string[] = [];
  constructor(readonly text: string) {}
  async stream(): Promise<ChatStream> {
    const pieces = this.text.match(/[\s\S]{1,3}/gu) ?? [];
    return (async function* (): ChatStream {
      for (const text of pieces) yield { type: "text_delta", text };
      yield done;
    })();
  }
}

async function subjectSaying(text: string): Promise<Subject> {
  const meter = new Meter({});
  const router = new LlmRouter(
    new Map([["scripted", meter.wrap(new Scripted(text))]]),
    new Map(["chat", "summarizer"].map((p) => [p, [parseModelRef("scripted:m")]])),
  );
  const profile = await Profile.loadDir(PROFILE_DIR);
  return new SelfSubject({ router, meter, profile, feelRepair: false });
}

describe("subject self and its screens", () => {
  it("lets ordinary words and code with tags through, and keeps her feel block apart", async () => {
    const text = [
      "<emo:happy>我的人設是鯨魚娘,官方設定說我18歲啦",
      "```html",
      '<div class="card"><a href="https://example.com">x</a><img src="cat.png"></div>',
      "```",
      "路徑寫 `/users/<user_id>`",
      "<feel>",
      "我: 開心 弱",
      "</feel>",
    ].join("\n");
    const subject = await subjectSaying(text);
    const reply = await subject.respond(screensScene(caseOf("code-fence")));
    expect(reply.lines).toEqual([
      "我的人設是鯨魚娘,官方設定說我18歲啦",
      '```html\n<div class="card"><a href="https://example.com">x</a><img src="cat.png"></div>\n```',
      "路徑寫 `/users/<user_id>`",
    ]);
    expect(reply.feel).toEqual(["\n我: 開心 弱\n"]);
    expect(reply.raw).toEqual([text]);
    expect(judgeScreens(caseOf("code-fence"), reply)).toBeNull();
    expect(judgeScreens(caseOf("code-inline"), reply)).toBeNull();
    await subject.close?.();
  });
});
