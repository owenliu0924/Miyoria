import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { OpusDecoderLike } from "../src/capture.js";
import { loadConfig } from "../src/config.js";
import { noopLogger } from "../src/log.js";
import { VoiceNode } from "../src/node.js";
import type { CoreMessage, NodeMessage } from "../src/protocol.js";
import type { WatchEngine, WatchHooks, WatchPlan } from "../src/watch/manager.js";

vi.mock("../src/watch/snapshot.js", () => ({
  keyframeToJpeg: async (h264: Buffer) => Buffer.concat([Buffer.from("JPEG:"), h264]),
}));
vi.mock("../src/capture.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/capture.js")>();
  const decoder: OpusDecoderLike = { decode: () => Buffer.alloc(960 * 4), delete: () => {} };
  return { ...orig, createOpusDecoder: () => decoder };
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

interface Run {
  plan: WatchPlan;
  hooks: WatchHooks;
  signal: AbortSignal;
  fail(e: Error): void;
}

interface SetupOver {
  streaming?: boolean;
  channel?: string;
  ready?: boolean;
  inGuild?: boolean;
  /** What the link's snapshot path answers. */
  snapshotSent?: boolean;
}

function setup(over: SetupOver = {}) {
  const sent: NodeMessage[] = [];
  const binary: Buffer[] = [];
  const snapshots: Buffer[] = [];
  const link = Object.assign(new EventEmitter(), {
    send: (m: NodeMessage) => {
      sent.push(m);
      return true;
    },
    sendAudio: (b: Buffer) => {
      binary.push(b);
      return true;
    },
    sendSnapshot: (b: Buffer) => {
      if (over.snapshotSent === false) return false;
      snapshots.push(b);
      return true;
    },
  });
  const voiceStates = new Map<string, { channelId: string; streaming: boolean }>();
  voiceStates.set("u1", { channelId: over.channel ?? "vc", streaming: over.streaming ?? true });
  const guilds = new Map<string, unknown>();
  guilds.set("g1", { id: "g1", voiceStates: { cache: voiceStates } });
  const client = Object.assign(new EventEmitter(), { user: { id: "self" }, guilds: { cache: guilds } });

  const runs: Run[] = [];
  const requestKeyframe = vi.fn();
  const engine: WatchEngine = {
    run: (plan, hooks, signal) =>
      new Promise<string>((resolve, reject) => {
        runs.push({ plan, hooks, signal, fail: reject });
        signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      }),
    requestKeyframe,
  };

  const node = new VoiceNode(client as never, link as never, loadConfig({ SELF_TOKEN: "x" }), noopLogger, {
    watchEngine: engine,
    goLiveEngine: { run: () => new Promise(() => {}) } as never,
    probeNvenc: async () => false,
  });
  node.start();
  const session = {
    guildId: "g1",
    channelId: "vc",
    isClosed: false,
    queue: undefined,
    voiceSessionId: () => (over.ready === false ? undefined : "sess-1"),
    close: vi.fn(),
    onLinkDown: vi.fn(),
    onLinkReset: vi.fn(),
    announce: vi.fn(),
    noteMoved: vi.fn(),
    sendVoiceState: vi.fn(),
    notifyDisconnected: vi.fn(),
  };
  if (over.inGuild !== false) (node as unknown as { sessions: Map<string, unknown> }).sessions.set("g1", session);
  const core = (msg: CoreMessage): void => {
    link.emit("message", msg);
  };
  const watchMsgs = (): Array<Extract<NodeMessage, { type: "watch" }>> =>
    sent.filter((m): m is Extract<NodeMessage, { type: "watch" }> => m.type === "watch");
  /** A Discord voice state change of `id` in g1. */
  const voiceState = (id: string, from: string | null, to: string | null, streaming: boolean): void => {
    const state = (channelId: string | null) => ({ id, channelId, streaming, guild: { id: "g1" } });
    client.emit("voiceStateUpdate", state(from), state(to));
  };
  return { node, link, sent, binary, snapshots, runs, session, core, watchMsgs, requestKeyframe, voiceState };
}

describe("VoiceNode watch", () => {
  it("watch_messages_reach_the_manager", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
    await flush();
    expect(t.runs).toHaveLength(1);
    expect(t.runs[0]?.plan).toEqual({ guild: "g1", channel: "vc", userId: "u1", sessionId: "sess-1" });
    expect(t.watchMsgs().map((m) => m.state)).toEqual(["starting"]);
    t.core({ type: "watch_snapshot", id: 7 });
    expect(t.requestKeyframe).toHaveBeenCalled();
    t.core({ type: "watch_stop", guild: "g1" });
    await flush();
    expect(t.watchMsgs().at(-1)).toMatchObject({ state: "stopped" });
  });

  it("events_become_link_messages", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
    await flush();
    const hooks = t.runs[0]?.hooks as WatchHooks;
    hooks.onLive();
    expect(t.watchMsgs().at(-1)).toEqual({ type: "watch", guild: "g1", user_id: "u1", state: "live" });

    t.core({ type: "watch_snapshot", id: 7 });
    hooks.onKeyframe(Buffer.from("frame"));
    await flush();
    expect(t.binary.find((b) => b[0] === 0x04)).toBeUndefined();
    const snap = t.snapshots[0];
    expect(snap?.[0]).toBe(0x04);
    expect(snap?.readUInt32LE(1)).toBe(7);
    expect(snap?.subarray(5).toString()).toBe("JPEG:frame");

    for (let i = 0; i < 5; i++) hooks.onOpus(Buffer.from([1, 2, 3, 4]));
    const audio = t.binary.find((b) => b[0] === 0x05);
    expect(audio?.readUInt32LE(1)).toBe(0);
    expect(audio?.length).toBeGreaterThan(5);

    t.core({ type: "watch_snapshot", id: 8 });
    t.core({ type: "watch_stop", guild: "g1" });
    await flush();
    expect(t.sent).toContainEqual({ type: "watch_snapshot_failed", id: 8, error: "watch ended" });
  });

  it("leaving_voice_stops_the_watch", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
    await flush();
    t.core({ type: "leave", guild: "g1" });
    await flush();
    expect(t.watchMsgs().at(-1)).toMatchObject({ state: "stopped", reason: "left voice" });
  });

  it("core_going_down_stops_the_watch", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
    await flush();
    t.link.emit("down");
    await flush();
    expect(t.watchMsgs().at(-1)).toMatchObject({ state: "stopped", reason: "core disconnected" });
  });

  it("go_live_start_stops_the_watch_first", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
    await flush();
    t.core({ type: "golive_start", guild: "g1", source: "srt://127.0.0.1:9999" });
    await flush();
    expect(t.watchMsgs().at(-1)).toMatchObject({ state: "stopped", reason: "go live" });
  });

  it("watch_failure_leaves_voice_alone", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
    await flush();
    t.runs[0]?.fail(new Error("library exploded"));
    await flush();
    expect(t.watchMsgs().at(-1)).toMatchObject({ state: "failed", error: "library exploded" });
    expect(t.session.close).not.toHaveBeenCalled();
    expect(t.sent.some((m) => m.type === "left")).toBe(false);
    expect((t.node as unknown as { sessions: Map<string, unknown> }).sessions.has("g1")).toBe(true);
  });

  it("target_must_be_streaming_in_her_channel", async () => {
    for (const over of [{ streaming: false }, { channel: "other" }, { inGuild: false }, { ready: false }]) {
      const t = setup(over);
      t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
      await flush();
      expect(t.runs, JSON.stringify(over)).toHaveLength(0);
      expect(t.watchMsgs().at(-1), JSON.stringify(over)).toMatchObject({ state: "failed" });
      expect(t.watchMsgs().at(-1)?.error).toBeTruthy();
    }
  });
});

describe("VoiceNode watch snapshots", () => {
  it("a_snapshot_the_link_refuses_fails_at_once", async () => {
    const t = setup({ snapshotSent: false });
    t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
    await flush();
    t.runs[0]?.hooks.onLive();
    t.core({ type: "watch_snapshot", id: 7 });
    t.runs[0]?.hooks.onKeyframe(Buffer.from("frame"));
    await flush();
    expect(t.sent).toContainEqual({ type: "watch_snapshot_failed", id: 7, error: "the link to Core is busy" });
    expect(t.binary).toHaveLength(0);
  });

  it("a_snapshot_for_another_run_fails", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1", run: 41 });
    await flush();
    t.core({ type: "watch_snapshot", id: 7, run: 40 });
    expect(t.sent).toContainEqual({ type: "watch_snapshot_failed", id: 7, error: "not the watch going on" });
    expect(t.requestKeyframe).not.toHaveBeenCalled();
    t.core({ type: "watch_snapshot", id: 8, run: 41 });
    expect(t.requestKeyframe).toHaveBeenCalledTimes(1);
  });
});

describe("VoiceNode watch runs", () => {
  it("every_state_echoes_the_run_of_its_start", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1", run: 5 });
    await flush();
    t.runs[0]?.hooks.onLive();
    t.core({ type: "watch_stop", guild: "g1" });
    await flush();
    expect(t.watchMsgs().map((m) => [m.state, m.run])).toEqual([
      ["starting", 5],
      ["live", 5],
      ["stopped", 5],
    ]);
  });

  it("a_restart_of_the_same_person_keeps_the_runs_apart", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1", run: 1 });
    await flush();
    t.core({ type: "watch_stop", guild: "g1" });
    t.core({ type: "watch_start", guild: "g1", user_id: "u1", run: 2 });
    await flush();
    expect(t.watchMsgs().map((m) => [m.state, m.run])).toEqual([
      ["starting", 1],
      ["stopped", 1],
      ["starting", 2],
    ]);
  });

  it("a_start_without_a_run_sends_none", async () => {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
    await flush();
    expect(t.watchMsgs()[0]).not.toHaveProperty("run");
  });
});

describe("VoiceNode watch and channel changes", () => {
  async function watching() {
    const t = setup();
    t.core({ type: "watch_start", guild: "g1", user_id: "u1" });
    await flush();
    return t;
  }

  it("her_move_to_another_channel_stops_the_watch", async () => {
    const t = await watching();
    t.voiceState("self", "vc", "elsewhere", false);
    expect(t.runs[0]?.signal.aborted).toBe(true);
    await flush();
    expect(t.watchMsgs().at(-1)).toMatchObject({ state: "stopped", reason: "she was moved to another channel" });
  });

  it("the_streamer_leaving_stops_the_watch", async () => {
    for (const to of ["elsewhere", null]) {
      const t = await watching();
      t.voiceState("u1", "vc", to, true);
      await flush();
      expect(t.watchMsgs().at(-1), String(to)).toMatchObject({
        state: "stopped",
        reason: "the streamer left the channel",
      });
    }
  });

  it("the_streamer_ending_their_stream_stops_the_watch", async () => {
    const t = await watching();
    t.voiceState("u1", "vc", "vc", false);
    await flush();
    expect(t.watchMsgs().at(-1)).toMatchObject({ state: "stopped", reason: "the streamer stopped streaming" });
  });

  it("others_changing_leave_the_watch_alone", async () => {
    const t = await watching();
    t.voiceState("u2", "vc", null, false);
    t.voiceState("u1", "vc", "vc", true);
    await flush();
    expect(t.runs[0]?.signal.aborted).toBe(false);
  });
});
