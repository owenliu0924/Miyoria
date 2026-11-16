// What the text path on the new runner keeps of the old one (docs/design/v5-brain.md B4).

import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import type { ChatRequest } from "@miyoria/llm/llm";
import {
  type Attachment,
  type Attitude,
  AuthorizerKey,
  type ContextKey,
  type DecisionTrace,
  Events,
  type FileOutcome,
  type FileReader,
  FileReaderKey,
  type FileRequest,
  type FloorBudget,
  type FloorClaimKind,
  type FloorHold,
  FloorKey,
  type GateDecisionPayload,
  type InterruptLevel,
  SocialSignalsKey,
  type TurnOutcomeRecord,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../../agent/src/index.js";
import { serialiseMessages } from "../../self/src/index.js";
import {
  account,
  calls,
  channel,
  dm,
  line,
  mention,
  Rig,
  says,
  stopRigs,
  until,
} from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");
const DM_AMY = dm("dm-amy");
const outcomes = (rig: Rig) => rig.of<TurnOutcomeRecord>(Events.AgentTurnOutcome.type);
const toolResults = (rig: Rig, request: number) =>
  (rig.model.requests[request]?.messages ?? [])
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content));

function known(who: string, familiarity: number): Attitude {
  return {
    person: `p-${who}` as Attitude["person"],
    affinity: 0,
    trust: 0,
    familiarity,
    blocked: false,
    label: "朋友",
    call_name: null,
    display_name: who,
  };
}

/** A Floor that records what it is asked; `ambient` is refused while `refusing` is set. */
class FakeFloor {
  readonly calls: string[] = [];
  refusing: string | null = null;

  hold(turn: string, context: ContextKey, kind: FloorClaimKind): void {
    this.calls.push(`hold ${turn} ${context.channel} ${kind}`);
  }
  turnEnded(turn: string): void {
    this.calls.push(`ended ${turn}`);
  }
  release(turn: string): void {
    this.calls.push(`release ${turn}`);
  }
  releaseContext(): void {}
  holder(): FloorHold | null {
    return null;
  }
  interruptLevel(): InterruptLevel {
    return "queue";
  }
  refuses(kind: FloorClaimKind): string | null {
    return kind === "ambient" ? this.refusing : null;
  }
  budget(): FloorBudget {
    return {
      window_mins: 10,
      used: 0,
      allowed: 10,
      human_lines: 0,
      unanswered: 0,
      waiting_for_response: false,
      performing: false,
    };
  }
}

describe("the Floor", () => {
  it("is held once for the whole run, not per line, and freed when the run ends", async () => {
    const floor = new FakeFloor();
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", FloorKey, floor),
    });
    rig.model.push(says("第一句\n第二句"));
    rig.say(mention(C1, "amy", "@她 說兩句"));
    await until(() => outcomes(rig).length === 1, 3_000, "the run");
    expect(rig.sink.texts()).toEqual(["第一句", "第二句"]);
    const turn = outcomes(rig)[0]?.turn;
    expect(floor.calls).toEqual([`hold ${turn} c1 addressed`, `ended ${turn}`]);
  });

  it("refuses a glance the way it refused ambient talk, before any model call", async () => {
    const floor = new FakeFloor();
    floor.refusing = "這 10 分鐘你自己講了 5 句,額度用完了";
    const rig = await Rig.create({
      mode: "lively",
      provide: (sup) => sup.services.provide("app", FloorKey, floor),
    });
    rig.say(line(C1, "amy", "今天好冷"));
    await until(() => outcomes(rig).length === 1, 3_000, "the refused glance");
    expect(rig.model.requests).toHaveLength(0);
    expect(outcomes(rig)[0]).toMatchObject({ reason: "ambient", outcome: { type: "silence" } });
    const decision = rig.of<DecisionTrace>(Events.AgentDecision.type).at(-1);
    expect(decision?.respond).toBe(false);
    expect(decision?.reasons.at(-1)).toBe(`floor: ${floor.refusing}`);
    expect(floor.calls).toEqual([]);
  });

  it("is freed when the run is cut", async () => {
    const floor = new FakeFloor();
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", FloorKey, floor),
    });
    rig.model.push({ events: says("慢慢想"), delay: 400 }, says("好"));
    rig.say(mention(C1, "amy", "@她 幫我想"));
    await until(() => rig.model.requests.length === 1, 3_000, "the first run");
    rig.say(line(C1, "amy", "要跟海有關的那種名字"));
    await until(() => outcomes(rig).length === 2, 3_000, "both runs");
    const [cut, next] = outcomes(rig);
    expect(cut?.outcome.type).toBe("cancelled");
    expect(floor.calls).toEqual([
      `hold ${cut?.turn} c1 addressed`,
      `ended ${cut?.turn}`,
      `hold ${next?.turn} c1 addressed`,
      `ended ${next?.turn}`,
    ]);
  });
});

// ---- images and files ---------------------------------------------------------------------------

function image(id: string, name = `${id}.png`): Attachment {
  return {
    id,
    url: `https://cdn.discordapp.com/attachments/1/${name}?sig=1`,
    filename: name,
    content_type: "image/png",
    size: 4,
  };
}

function file(id: string, name: string): Attachment {
  return {
    id,
    url: `https://cdn.discordapp.com/attachments/1/${name}`,
    filename: name,
    content_type: "text/plain",
    size: 20,
  };
}

/** Answers every download with a tiny png; counts them. */
function fakeFetch(): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    urls.push(url);
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { "content-type": "image/png" },
    });
  };
  return Object.assign(fetch, { urls });
}

/** The parts of the request's messages, each as `role: text-or-[image]`. */
function partsOf(request: ChatRequest | undefined): string[] {
  return (request?.messages ?? []).flatMap((m) =>
    typeof m.content === "string"
      ? [`${m.role}: ${m.content}`]
      : m.content.map((p) => `${m.role}: ${p.type === "text" ? p.text : `[image ${p.alt}]`}`),
  );
}

/** The index of the first message that carries an image part. */
function firstImage(request: ChatRequest | undefined): number {
  return (request?.messages ?? []).findIndex(
    (m) => typeof m.content !== "string" && m.content.some((p) => p.type === "image_url"),
  );
}

class FakeReader implements FileReader {
  readonly requests: FileRequest[] = [];
  constructor(readonly outcome: (r: FileRequest) => FileOutcome) {}
  supports(name: string): boolean {
    return name.endsWith(".txt");
  }
  async read(request: FileRequest): Promise<FileOutcome> {
    this.requests.push(request);
    return this.outcome(request);
  }
}

const allowAll = { allows: () => true, allowsSubject: () => true };

describe("images", () => {
  it("shows the run's images after the transcript, labelled; the transcript keeps a reference", async () => {
    const fetch = fakeFetch();
    const rig = await Rig.create({ mode: "mention-only", fetchImage: fetch });
    rig.model.push(says("看到了"), says("也看到了"));
    rig.say({ ...line(C1, "amy", "先傳一張"), attachments: [image("e1", "earlier.png")] });
    rig.say({ ...mention(C1, "amy", "@她 看這兩張"), attachments: [image("n1", "now.png")] });
    await until(() => rig.sink.texts().length === 1, 3_000, "the first answer");
    const first = rig.model.requests[0];
    const parts = partsOf(first);
    const at = parts.indexOf("user: (amy 這則訊息附的圖片 now.png)");
    expect(at).toBeGreaterThan(-1);
    expect(parts[at + 1]).toBe("user: [image [圖片: now.png]]");
    expect(parts[at + 2]).toMatch(
      /^user: \(amy \d+ 秒前另外傳的圖片 earlier\.png,不是這則訊息附的\)$/,
    );
    // After the transcript (the line that woke her), before `<now>`.
    const history = (first?.messages ?? []).findIndex(
      (m) => typeof m.content === "string" && m.content.includes("amy: @她 看這兩張"),
    );
    expect(firstImage(first)).toBeGreaterThan(history);
    expect(first?.messages.at(-1)?.role).toBe("system");
    // The transcript keeps no image data.
    const entry = rig
      .entries(C1)
      .find((e) => e.message_id !== null && e.content.includes("看這兩張"));
    expect(entry?.content).toContain("[圖片: now.png]");
    expect(entry?.images).toEqual([{ ref: "n1", alt: null }]);
    expect(JSON.stringify(rig.entries(C1))).not.toContain("data:image");

    // A reply to a line with an image: that image, labelled as the replied-to one's.
    const parent = { ...line(C1, "bob", "我的貓"), attachments: [image("p1", "cat.png")] };
    rig.say(parent);
    rig.say({
      ...mention(C1, "amy", "@她 你看他的貓"),
      reply_to: parent.id,
      referenced: { author: account("bob"), author_name: "bob", text: "我的貓" },
    });
    await until(() => rig.sink.texts().length === 2, 3_000, "the second answer");
    expect(partsOf(rig.model.requests[1])).toContain(
      "user: (被回覆的那則訊息裡 bob 傳的圖片 cat.png)",
    );
    expect(fetch.urls).toHaveLength(3);
  });

  it("keeps the prefix of the next run: images sit after the transcript", async () => {
    const rig = await Rig.create({ fetchImage: fakeFetch() });
    rig.model.push(says("好可愛"), says("對啊"));
    rig.say({ ...line(DM_AMY, "amy", "看"), attachments: [image("x1", "dog.png")] });
    await until(() => rig.sink.texts().length === 1, 3_000, "the first answer");
    await until(() => outcomes(rig).length === 1, 3_000, "the first run's end");
    rig.say(line(DM_AMY, "amy", "牠叫小白"));
    await until(() => rig.sink.texts().length === 2, 3_000, "the second answer");
    const [one, two] = rig.model.requests;
    const cut = firstImage(one);
    expect(cut).toBeGreaterThan(0);
    expect(serialiseMessages(two?.messages ?? []).slice(0, cut)).toEqual(
      serialiseMessages(one?.messages ?? []).slice(0, cut),
    );
    // Sent a moment ago by the same person: shown again, as such, after the transcript.
    expect(firstImage(two)).toBeGreaterThan(cut);
    expect(partsOf(two).join("\n")).toMatch(/amy \d+ 秒前另外傳的圖片 dog\.png/);
  });

  it("downloads nothing when the chat model takes no images", async () => {
    const fetch = fakeFetch();
    const rig = await Rig.create({ fetchImage: fetch, images: false });
    rig.model.push(says("嗯"));
    rig.say({ ...line(DM_AMY, "amy", "看"), attachments: [image("x1", "dog.png")] });
    await until(() => rig.sink.texts().length === 1, 3_000, "the answer");
    expect(fetch.urls).toEqual([]);
    expect(firstImage(rig.model.requests[0])).toBe(-1);
    expect(partsOf(rig.model.requests[0]).join("\n")).toContain("[圖片: dog.png]");
  });
});

describe("files", () => {
  it("reads the run's files in the sandbox and gives them to this run only", async () => {
    const reader = new FakeReader((r) => ({
      status: "read",
      text: `intro\n<data source="file" title="${r.name}">內容在這裡</data>`,
      chars: 5,
      truncated: false,
    }));
    const rig = await Rig.create({
      provide: (sup) => {
        sup.services.provide("app", FileReaderKey, reader);
        sup.services.provide("app", AuthorizerKey, allowAll);
      },
    });
    rig.model.push(says("看完了"), says("記得"));
    rig.say({ ...line(DM_AMY, "amy", "幫我看"), attachments: [file("f1", "notes.txt")] });
    await until(() => rig.sink.texts().length === 1, 3_000, "the answer");
    const parts = partsOf(rig.model.requests[0]);
    const read = parts.find((p) => p.includes("(amy 傳的檔案 notes.txt)"));
    expect(read).toContain("內容在這裡");
    // Block 6: after the line, never in the transcript.
    expect(parts.indexOf(read as string)).toBeGreaterThan(
      parts.findIndex((p) => p.includes("amy: 幫我看")),
    );
    expect(JSON.stringify(rig.entries(DM_AMY))).not.toContain("內容在這裡");
    expect(reader.requests.map((r) => r.name)).toEqual(["notes.txt"]);
    rig.say(line(DM_AMY, "amy", "那剛剛的檔案呢"));
    await until(() => rig.sink.texts().length === 2, 3_000, "the next answer");
    expect(partsOf(rig.model.requests[1]).join("\n")).not.toContain("內容在這裡");
  });

  it("says why when the sandbox cannot open it", async () => {
    const reader = new FakeReader(() => ({
      status: "declined",
      code: "sandbox",
      reason: "我現在沒辦法安全地打開檔案",
    }));
    const rig = await Rig.create({
      provide: (sup) => {
        sup.services.provide("app", FileReaderKey, reader);
        sup.services.provide("app", AuthorizerKey, allowAll);
      },
    });
    rig.model.push(says("打不開耶"));
    rig.say({ ...line(DM_AMY, "amy", "幫我看"), attachments: [file("f1", "notes.txt")] });
    await until(() => rig.sink.texts().length === 1, 3_000, "the answer");
    expect(partsOf(rig.model.requests[0])).toContain(
      "user: (amy 傳了檔案 notes.txt,我沒有讀它:我現在沒辦法安全地打開檔案)",
    );
  });
});

describe("a DM through `say`", () => {
  it("is refused and points to message_dm, whose gate holds a person's opt-out", async () => {
    const OWEN = account("1001");
    const ownDm: ContextKey = dm("dm-1001");
    let registry: ActuatorRegistry | null = null;
    const rig = await Rig.create({
      provide: (sup, tools) => {
        registry = new ActuatorRegistry({
          services: sup.services,
          tools,
          publish: sup.bus.publisher("actions"),
        });
        sup.services.provide("app", ActuatorRegistryKey, registry);
        sup.services.provide("app", SocialSignalsKey, {
          attitude: (a) => (a.id === "1001" ? known("1001", 50) : null),
        });
      },
    });
    if (registry === null) throw new Error("no registry");
    await (registry as ActuatorRegistry).privacy.set(OWEN, { dm: false });
    // She knows the DM: 1001 wrote to her before.
    rig.model.push(says("嗨"));
    rig.say(line(ownDm, "1001", "在嗎"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the DM answer");

    rig.model.push(
      calls("say", { place: "私訊:1001", text: "偷偷跟你說" }),
      calls("message_dm", { to: "1001", text: "偷偷跟你說" }, "call-dm"),
      says("他不收私訊"),
    );
    rig.say(mention(C1, "amy", "@她 去私訊 1001"));
    await until(() => rig.sink.texts().length === 2, 3_000, "her answer");
    // Nothing went to the DM: only her two lines in the places she was spoken to.
    expect(rig.sink.sent()).toEqual([
      ["dm-1001", "嗨"],
      ["c1", "他不收私訊"],
    ]);
    const [viaSay] = toolResults(rig, 2);
    expect(viaSay).toContain("私訊不能用 say");
    expect(viaSay).toContain("message_dm");
    const decisions = rig.of<GateDecisionPayload>(Events.GateDecision.type);
    expect(decisions.find((d) => d.capability === "message.dm")).toMatchObject({
      allowed: false,
      stage: "consent",
    });
  });
});
