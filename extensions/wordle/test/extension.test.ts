import { PassThrough } from "node:stream";
import { type InitializeResult, RpcPeer, runExtension } from "@miyoria/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import extension, { BOARD_TOPIC, loadDictionary } from "../src/index.js";

const context = (channel: string) => ({ platform: "discord", scope: null, channel, kind: "text" });
const toolContext = (channel: string) => ({
  turn: "01J00000000000000000000000",
  context: context(channel),
  account: { platform: "discord", id: "42" },
  message: { context: context(channel), id: "m1" },
  priority: "normal",
});

let shutdown: (() => Promise<void>) | undefined;
afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  vi.restoreAllMocks();
});

async function start(config: Record<string, unknown> = {}) {
  const published: Array<{ type: string; data: { board: Record<string, unknown> | null } }> = [];
  const hostToExt = new PassThrough();
  const extToHost = new PassThrough();
  const runtime = runExtension(extension, {
    input: hostToExt,
    output: extToHost,
    exit: () => {},
    timeoutMs: 2000,
  });
  const peer = new RpcPeer({
    input: extToHost,
    output: hostToExt,
    timeoutMs: 3000,
    onRequest: (method, params) => {
      if (method === "events.publish") published.push(params as (typeof published)[number]);
      return {};
    },
    onNotification: () => {},
  });
  shutdown = () => runtime.shutdown();
  const init = await peer.request<InitializeResult>("initialize", {
    protocol: 2,
    host: { name: "miyoria", version: "0.1.0" },
    extension: { id: "miyoria.wordle", version: "0.1.0", dir: "/ext", game: null },
    config,
    permissions: { events: [], tools: true, commands: false, network: [], input: [] },
  });
  const call = async (name: string, args: unknown, channel = "c1") =>
    (
      await peer.request<{ content: string }>("tools.call", {
        name,
        args,
        context: toolContext(channel),
      })
    ).content;
  return { init, call, published };
}

describe("word lists", () => {
  it("has the answers inside the allowed guesses", () => {
    const d = loadDictionary();
    expect(d.answers.length).toBeGreaterThan(2000);
    expect(d.allowed.size).toBeGreaterThan(12000);
    expect(d.answers.every((w) => d.allowed.has(w))).toBe(true);
  });
});

describe("extension", () => {
  it("plays a game per channel", async () => {
    const { init, call } = await start();
    expect(init.contributions.tools.map((t) => t.name)).toEqual([
      "wordle.start",
      "wordle.guess",
      "wordle.status",
      "wordle.give_up",
    ]);

    expect(await call("wordle.guess", { word: "slate" })).toContain("先用 wordle.start");
    vi.spyOn(Math, "random").mockReturnValue(0); // the first answer: "aback"
    expect(await call("wordle.start", {})).toContain("新的一局");
    expect(await call("wordle.start", {})).toContain("已經有一局");
    expect(await call("wordle.guess", { word: "zzzzz" })).toContain("失敗");

    const first = await call("wordle.guess", { word: "slate" });
    expect(first).toContain("⬛⬛🟩⬛⬛ SLATE");
    expect(first).toContain("剩 5 次");

    // another channel has its own game
    expect(await call("wordle.status", {}, "c2")).toContain("還沒開局");

    expect(await call("wordle.guess", { word: "aback" })).toContain("答對了");
    expect(await call("wordle.give_up", {})).toContain("沒有正在玩");
    expect(await call("wordle.start", {})).toContain("新的一局");
    expect(await call("wordle.give_up", {})).toMatch(/答案是 [A-Z]{5}/);
  });

  it("puts the board on the stream after every change, the answer only at the end", async () => {
    const { call, published } = await start();
    vi.spyOn(Math, "random").mockReturnValue(0); // "aback"
    const slate = { word: "SLATE", marks: ["absent", "absent", "correct", "absent", "absent"] };
    await call("wordle.start", {});
    await call("wordle.guess", { word: "zzzzz" }); // refused, but typed on screen
    await call("wordle.guess", { word: "slate" });
    await call("wordle.give_up", {});
    await call("wordle.guess", { word: "crane" }); // the game is over: nothing new
    expect(published.map((p) => p.type)).toEqual(Array(4).fill(BOARD_TOPIC));
    const base = { max_guesses: 6, state: "playing", answer: null };
    expect(published.map((p) => p.data.board)).toEqual([
      { ...base, rows: [], attempts: 0, rejected: null },
      { ...base, rows: [], attempts: 1, rejected: "ZZZZZ" },
      { ...base, rows: [slate], attempts: 2, rejected: null },
      { ...base, rows: [slate], attempts: 2, rejected: null, state: "gave_up", answer: "ABACK" },
    ]);
  });

  it("keeps the board off the stream when show_on_stream is false", async () => {
    const { call, published } = await start({ show_on_stream: false });
    await call("wordle.start", {});
    expect(published).toEqual([]);
  });
});
