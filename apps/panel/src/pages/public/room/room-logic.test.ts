import type { RoomEvent } from "@miyoria/contracts/api";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/http";
import { admit, kindOfFile, readyToSend, tooBig } from "./attach-limits";
import { poseFor } from "./figure";
import { SwipeTracker, WheelUp } from "./gestures";
import { isRoomPath } from "./path";
import type { RoomApi } from "./room-api";
import { dispositionName } from "./room-api";
import { roomState } from "./room-fixtures";
import { hasMore, initialModel, lastHerLine, type RoomAction, type RoomModel, reduce, shownLine } from "./room-store";
import { followRoom, REFUSED_WAIT_MS, RETRY_MS } from "./room-stream";
import { capsuleHint, doingOf, problemOf } from "./room-text";
import { type ChannelLike, RoomVoice, voiceKey } from "./voice";

const MB = 1024 * 1024;

const run = (actions: RoomAction[], from: RoomModel = initialModel()) => actions.reduce(reduce, from);
const ev = (event: RoomEvent): RoomAction => ({ type: "event", event });
const line = (id: string, turn: string | null, text = id): RoomEvent => ({
  kind: "line",
  id,
  at: "2026-11-28T12:00:00Z",
  turn,
  text,
  files: [],
  voice: false,
});

describe("the room's reducer", () => {
  it("steps through her reply one line at a time", () => {
    let m = run([ev({ kind: "thinking", turn: "t1" })]);
    expect(m.turn?.phase).toBe("thinking");
    expect(shownLine(m.turn)).toBeNull();
    m = run([ev(line("a", "t1")), ev({ kind: "typing" }), ev(line("b", "t1"))], m);
    expect(shownLine(m.turn)?.text).toBe("a");
    expect(hasMore(m.turn)).toBe(true);
    m = reduce(m, { type: "advance" });
    expect(shownLine(m.turn)?.text).toBe("b");
    expect(hasMore(m.turn)).toBe(false);
    // Nothing past the last step.
    expect(reduce(m, { type: "advance" })).toBe(m);
    m = reduce(m, ev({ kind: "done", turn: "t1" }));
    expect(m.turn?.phase).toBe("done");
    expect(m.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("starts a new turn for her next reply, and keeps lines with no turn", () => {
    let m = run([ev({ kind: "thinking", turn: "t1" }), ev(line("a", "t1")), ev({ kind: "done", turn: "t1" })]);
    m = reduce(m, ev({ kind: "thinking", turn: "t2" }));
    expect(m.turn?.id).toBe("t2");
    expect(shownLine(m.turn)).toBeNull();
    // A reminder after the turn: its own, already done.
    m = run([ev(line("c", "t2")), ev({ kind: "done", turn: "t2" }), ev(line("r", null))], m);
    expect(m.turn).toMatchObject({ id: null, phase: "done" });
    expect(shownLine(m.turn)?.id).toBe("r");
  });

  it("knows its own send again when the stream echoes it, and shows lines from other tabs", () => {
    let m = reduce(initialModel(), { type: "send", client_id: "mine-0001", text: "你好", files: [], at: "2026-11-28T12:00:00Z" });
    expect(m.you).toMatchObject({ text: "你好", status: "sending" });
    m = reduce(m, ev({ kind: "you", id: "L1", at: "2026-11-28T12:00:01Z", text: "你好", files: [], client_id: "mine-0001" }));
    expect(m.pending).toEqual([]);
    expect(m.you).toMatchObject({ id: "L1", status: "sent" });
    // The answer to the send, after the echo: no second backlog line.
    m = reduce(m, { type: "sent", client_id: "mine-0001", result: { id: "L1", at: "2026-11-28T12:00:01Z", heard: "ok", notice: null } });
    expect(m.entries.filter((e) => e.id === "L1")).toHaveLength(1);
    // Another tab of theirs.
    m = reduce(m, ev({ kind: "you", id: "L2", at: "2026-11-28T12:00:02Z", text: "另一頁", files: [], client_id: "other-tab" }));
    expect(m.you?.text).toBe("另一頁");
    // A late echo of this tab's older send does not take the stage back.
    m = reduce(m, { type: "send", client_id: "mine-0002", text: "第三句", files: [], at: "2026-11-28T12:00:03Z" });
    m = reduce(m, { type: "sent", client_id: "mine-0002", result: { id: "L3", at: "2026-11-28T12:00:03Z", heard: "ok", notice: null } });
    m = reduce(m, ev({ kind: "you", id: "L1", at: "2026-11-28T12:00:01Z", text: "你好", files: [], client_id: "mine-0001" }));
    expect(m.you?.text).toBe("第三句");
  });

  it("puts a send's answer in the backlog when the stream is down, and says moderation's line", () => {
    let m = reduce(initialModel(), { type: "send", client_id: "c1-aaaaaa", text: "洗版", files: [], at: "2026-11-28T12:00:00Z" });
    m = reduce(m, { type: "sent", client_id: "c1-aaaaaa", result: { id: "L9", at: "2026-11-28T12:00:00Z", heard: "held", notice: "你說得有點快,她先聽著" } });
    expect(m.entries).toEqual([expect.objectContaining({ id: "L9", who: "you", text: "洗版" })]);
    expect(m.notice).toEqual({ text: "你說得有點快,她先聽著", tone: "quiet" });
  });

  it("takes a failed send off the stage with its reason", () => {
    let m = reduce(initialModel(), { type: "send", client_id: "c1-aaaaaa", text: "嗨", files: [], at: "2026-11-28T12:00:00Z" });
    m = reduce(m, { type: "failed", client_id: "c1-aaaaaa", message: "她現在不在" });
    expect(m.you).toBeNull();
    expect(m.pending).toEqual([]);
    expect(m.notice).toEqual({ text: "她現在不在", tone: "error" });
  });

  it("merges the first backlog page with lines the stream brought first, and prepends older pages", () => {
    let m = run([ev(line("live", "t1"))]);
    m = reduce(m, {
      type: "backlog",
      mode: "first",
      page: { entries: [{ type: "line", id: "old", at: "x", who: "you", text: "早", files: [] }], older: "c1" },
    });
    expect(m.entries.map((e) => e.id)).toEqual(["old", "live"]);
    m = reduce(m, {
      type: "backlog",
      mode: "older",
      page: { entries: [{ type: "line", id: "older", at: "x", who: "her", text: "更早", files: [] }, m.entries[0] as never], older: null },
    });
    expect(m.entries.map((e) => e.id)).toEqual(["older", "old", "live"]);
    expect(m.older).toBeNull();
    // A reset replaces it all.
    m = reduce(m, { type: "backlog", mode: "reset", page: { entries: [], older: null } });
    expect(m.entries).toEqual([]);
  });

  it("keeps her bond change as a direction and her quote, and a mark in the backlog", () => {
    const m = reduce(initialModel(), ev({ kind: "bond", id: "B1", at: "x", turn: "t1", sign: "minus", quote: "說了不要還一直鬧" }));
    expect(m.bond).toEqual({ id: "B1", sign: "minus", quote: "說了不要還一直鬧" });
    expect(m.entries[0]).toMatchObject({ type: "mark", sign: "minus" });
  });

  it("a hello after a reconnect ends a turn the room no longer has", () => {
    let m = run([ev({ kind: "thinking", turn: "t1" })]);
    m = reduce(m, ev({ kind: "hello", state: roomState(), turn: null }));
    expect(m.turn?.phase).toBe("done");
    expect(m.link).toBe("open");
    m = reduce(m, ev({ kind: "hello", state: roomState(), turn: { id: "t2", phase: "speaking" } }));
    expect(m.turn).toMatchObject({ id: "t2", phase: "speaking" });
  });

  it("after a reset, shows her newest reply the stream missed instead of the old one", () => {
    // Her reply came while the stream was down (a Core restart): only the reset's backlog has it.
    let m = run([ev({ kind: "thinking", turn: "t1" }), ev(line("old", "t1", "舊的")), ev({ kind: "done", turn: "t1" })]);
    m = reduce(m, ev({ kind: "hello", state: roomState(), turn: null }));
    const page = {
      entries: [
        { type: "line" as const, id: "old", at: "x", who: "her" as const, text: "舊的", files: [] },
        { type: "line" as const, id: "y", at: "x", who: "you" as const, text: "我回來了", files: [] },
        { type: "line" as const, id: "new", at: "x", who: "her" as const, text: "新的", files: [] },
      ],
      older: null,
    };
    m = reduce(m, { type: "backlog", mode: "reset", page });
    expect(m.turn).toBeNull();
    expect(lastHerLine(m.entries)?.text).toBe("新的");
    // A turn still going on keeps the stage.
    let going = run([ev({ kind: "thinking", turn: "t2" }), ev(line("a", "t2"))]);
    going = reduce(going, { type: "backlog", mode: "reset", page });
    expect(going.turn?.id).toBe("t2");
  });

  it("rests on her newest line when nothing goes on, unless the member spoke last", () => {
    expect(lastHerLine([{ type: "line", id: "h", at: "x", who: "her", text: "嗯", files: [] }])?.text).toBe("嗯");
    expect(
      lastHerLine([
        { type: "line", id: "h", at: "x", who: "her", text: "嗯", files: [] },
        { type: "line", id: "y", at: "x", who: "you", text: "欸", files: [] },
      ]),
    ).toBeNull();
  });
});

/** A `RoomApi` whose `follow` is driven by the test. */
function streamApi() {
  const calls: Array<{ lastEventId: string | null; emit: (e: RoomEvent, id: string | null) => void; end: (error?: unknown) => void }> = [];
  const api = {
    follow: ({ lastEventId, signal, onEvent }: Parameters<RoomApi["follow"]>[0]) =>
      new Promise<void>((resolve, reject) => {
        const end = (error?: unknown) => (error ? reject(error) : resolve());
        signal.addEventListener("abort", () => resolve(), { once: true });
        calls.push({ lastEventId, emit: onEvent, end });
      }),
  } as unknown as RoomApi;
  return { api, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("following the stream", () => {
  it("reconnects with a growing wait and resumes from the last event id", async () => {
    const { api, calls } = streamApi();
    const waits: number[] = [];
    const links: string[] = [];
    const events: RoomEvent[] = [];
    const stop = followRoom(api, {
      onEvent: (e) => events.push(e),
      onLink: (l) => links.push(l),
      sleep: async (ms) => {
        waits.push(ms);
      },
      watch: () => ({ seen() {}, stop() {} }),
    });
    await flush();
    expect(calls[0]?.lastEventId).toBeNull();
    calls[0]?.emit({ kind: "hello", state: roomState(), turn: null }, null);
    calls[0]?.emit({ kind: "ping" }, "run-1");
    calls[0]?.emit({ kind: "typing" }, "run-2");
    expect(events.map((e) => e.kind)).toEqual(["hello", "typing"]);
    calls[0]?.end();
    await flush();
    await flush();
    expect(calls[1]?.lastEventId).toBe("run-2");
    calls[1]?.end(new ApiError("network", 0, "/x", "down"));
    await flush();
    await flush();
    expect(calls[2]?.lastEventId).toBe("run-2");
    expect(waits.slice(0, 2)).toEqual([RETRY_MS[0], RETRY_MS[1]]);
    expect(links).toContain("open");
    expect(links).toContain("retrying");
    stop();
  });

  it("waits long after a refusal (logged out, closed, not there)", async () => {
    const { api, calls } = streamApi();
    const waits: number[] = [];
    const stop = followRoom(api, {
      onEvent: () => {},
      onLink: () => {},
      sleep: async (ms) => {
        waits.push(ms);
      },
      watch: () => ({ seen() {}, stop() {} }),
    });
    await flush();
    calls[0]?.end(new ApiError("http", 403, "/x", "她的房間現在沒有對你開放"));
    await flush();
    await flush();
    expect(waits[0]).toBe(REFUSED_WAIT_MS);
    stop();
  });

  it("drops a silent stream and comes back at once after the page slept", async () => {
    const { api, calls } = streamApi();
    let dead: ((why: "silent" | "asleep") => void) | null = null;
    const sleep = vi.fn(async () => {});
    const stop = followRoom(api, {
      onEvent: () => {},
      onLink: () => {},
      sleep,
      watch: (d) => {
        dead = d;
        return { seen() {}, stop() {} };
      },
    });
    await flush();
    (dead as unknown as (why: "asleep") => void)("asleep");
    await flush();
    await flush();
    expect(calls).toHaveLength(2);
    expect(sleep).not.toHaveBeenCalled();
    stop();
  });

  it("stops for good when told to", async () => {
    const { api, calls } = streamApi();
    const stop = followRoom(api, { onEvent: () => {}, onLink: () => {}, watch: () => ({ seen() {}, stop() {} }) });
    await flush();
    stop();
    await flush();
    expect(calls).toHaveLength(1);
  });
});

describe("the backlog's gestures", () => {
  it("a swipe up opens, a short drag or a sideways one does not, a press without moving is a tap", () => {
    const up = new SwipeTracker(-1);
    up.down(100, 700, 1);
    expect(up.move(100, 695, 1)).toBe(0);
    expect(up.move(100, 620, 1)).toBe(-80);
    expect(up.up(100, 620, 1)).toBe("swipe");

    up.down(100, 700, 1);
    up.move(100, 660, 1);
    expect(up.up(100, 660, 1)).toBeNull();

    up.down(100, 700, 1);
    up.move(100, 600, 1);
    expect(up.up(300, 600, 1)).toBeNull();

    up.down(100, 700, 1);
    expect(up.up(102, 701, 1)).toBe("tap");

    // Another finger, or the browser taking the pointer.
    up.down(100, 700, 1);
    expect(up.move(100, 500, 2)).toBeNull();
    up.move(100, 500, 1);
    expect(up.up(100, 500, 1, true)).toBeNull();
  });

  it("a swipe down closes", () => {
    const down = new SwipeTracker(1);
    down.down(50, 100, 3);
    down.move(50, 180, 3);
    expect(down.up(50, 180, 3)).toBe("swipe");
    down.down(50, 100, 3);
    down.move(50, 20, 3);
    expect(down.up(50, 20, 3)).toBeNull();
  });

  it("wheel up adds up to opening; down starts again", () => {
    const w = new WheelUp();
    expect(w.push(-40)).toBe(false);
    expect(w.push(10)).toBe(false);
    expect(w.push(-40)).toBe(false);
    expect(w.push(-40)).toBe(true);
  });
});

describe("attachment limits", () => {
  const limits = roomState().limits;
  const f = (name: string, size: number, type = "") => ({ name, size, type });

  it("takes pictures up to the image limit and other files up to the file limit", () => {
    const { take, refused } = admit(0, [f("a.png", 4 * MB, "image/png"), f("b.png", 6 * MB, "image/png"), f("c.pdf", 7 * MB)], limits);
    expect(take.map((x) => x.name)).toEqual(["a.png", "c.pdf"]);
    expect(refused).toBe(tooBig(limits));
    expect(refused).toBe("檔案太大了(圖片最多 5 MB,其他最多 8 MB)");
  });

  it("stops at the most files a line may carry, and refuses empty files", () => {
    const { take, refused } = admit(3, [f("a.txt", 10), f("b.txt", 10)], limits);
    expect(take).toHaveLength(1);
    expect(refused).toBe("一句最多附 4 個檔案");
    expect(admit(0, [f("e.txt", 0)], limits).refused).toBe("這個檔案是空的");
  });

  it("tells a picture by its type, or its name when the type is missing", () => {
    expect(kindOfFile(f("x.webp", 1, "image/webp"))).toBe("image");
    expect(kindOfFile(f("x.JPG", 1))).toBe("image");
    expect(kindOfFile(f("x.svg", 1, "image/svg+xml"))).toBe("file");
  });

  it("holds the send while files go up, and when the words are too long", () => {
    const up = { key: "k", name: "a", size: 1, kind: "file" as const, preview: null, progress: 1, error: null };
    expect(readyToSend("", [], 10)).toBe("empty");
    expect(readyToSend("", [{ ...up, upload: null }], 10)).toBe("uploading");
    expect(readyToSend("", [{ ...up, upload: null, error: "x" }], 10)).toBe("failed");
    expect(readyToSend("", [{ ...up, upload: { id: "up_x", name: "a", size: 1, kind: "file", expires_at: "" } }], 10)).toBe("ok");
    expect(readyToSend("12345678901", [], 10)).toBe("long");
  });
});

describe("her figure", () => {
  it("is still while she is away, sings while singing, and follows her face", () => {
    expect(poseFor(null, null)).toBe("still");
    expect(poseFor(roomState({ doing: "offline" }), "happy")).toBe("still");
    expect(poseFor(roomState({ open: false }), "happy")).toBe("still");
    expect(poseFor(roomState({ doing: "singing" }), "angry")).toBe("sing");
    expect(poseFor(roomState(), "Angry")).toBe("finger");
    expect(poseFor(roomState(), "shy")).toBe("chest");
    expect(poseFor(roomState({ mood: { word: "平靜", face: null } }), null)).toBe("heart");
    expect(poseFor(roomState({ doing: "working", mood: null }), null)).toBe("glasses");
  });
});

describe("the room's words", () => {
  it("never promises she will answer briefly, and says when she cannot answer now", () => {
    expect(capsuleHint(roomState())).toBe("跟她說點什麼");
    expect(capsuleHint(roomState({ doing: "singing", detail: "晴天" }))).toBe("跟她說點什麼");
    expect(capsuleHint(roomState({ paused: true }))).toBe("她現在暫停中,你說的她會記得");
    const until = new Date(2026, 10, 28, 21, 5).toISOString();
    expect(capsuleHint(roomState({ quota: { capped: "hour", until } }))).toBe("她晚點才能回你(21:05)");
  });

  it("says what she is doing, with the way to her live page only when she is on it", () => {
    expect(doingOf(roomState({ doing: "singing", detail: "晴天", watch: true }), null, "/watch")).toEqual({
      text: "在唱〈晴天〉",
      link: { label: "去聽", href: "/watch" },
      singing: true,
    });
    expect(doingOf(roomState({ doing: "singing", detail: "晴天" }), null, "/watch")?.link).toBeNull();
    expect(doingOf(roomState({ doing: "working" }), "查資料", "/watch")?.text).toBe("在幫你查資料");
    expect(doingOf(roomState(), null, "/watch")).toBeNull();
    expect(doingOf(roomState({ paused: true }), null, "/watch")?.text).toBe("她現在暫停中");
  });

  it("uses the Core's fixed words for a refusal, and its own for no connection", () => {
    expect(problemOf(new ApiError("http", 429, "/x", "你說得太快了,等一下再說"))).toBe("你說得太快了,等一下再說");
    expect(problemOf(new ApiError("network", 0, "/x", "Failed to fetch"))).toBe("連不上她的房間,沒有送出");
    expect(problemOf(new ApiError("not_provided", 404, "/x", "no such endpoint"))).toBe("她的房間現在沒有開");
  });

  it("reads a download's name", () => {
    expect(dispositionName(`attachment; filename="a.txt"; filename*=UTF-8''%E8%8F%9C%E5%96%AE.txt`, "f")).toBe("菜單.txt");
    expect(dispositionName(`attachment; filename="a.txt"`, "f")).toBe("a.txt");
    expect(dispositionName(null, "f")).toBe("f");
  });

  it("knows the room's address", () => {
    expect(isRoomPath("/her")).toBe(true);
    expect(isRoomPath("/her/?room-demo")).toBe(true);
    expect(isRoomPath("/here")).toBe(false);
  });
});

class FakeChannel implements ChannelLike {
  static all: FakeChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeChannel.all.push(this);
  }
  postMessage(message: unknown) {
    for (const c of FakeChannel.all) if (c !== this) c.onmessage?.({ data: message } as MessageEvent);
  }
  close() {
    FakeChannel.all = FakeChannel.all.filter((c) => c !== this);
  }
}

function fakeAudio() {
  const made: Array<{ src: string; playing: boolean; end: () => void }> = [];
  const audio = () => {
    const a = {
      src: "",
      playing: false,
      onended: null as (() => void) | null,
      onerror: null as (() => void) | null,
      play: async () => {
        a.playing = true;
      },
      pause: () => {
        a.playing = false;
      },
      end: () => a.onended?.(),
    };
    made.push(a);
    return a;
  };
  return { made, audio };
}

describe("her voice", () => {
  const urls = { create: () => "blob:x", revoke: () => {} };

  it("plays only what the Core offers, only when on, and only in the tab last used", async () => {
    FakeChannel.all = [];
    const fetch = vi.fn(async () => new Blob());
    const a = fakeAudio();
    const one = new RoomVoice({ fetch, tab: "one", channel: new FakeChannel(), audio: a.audio, objectUrl: urls });
    const two = new RoomVoice({ fetch, tab: "two", channel: new FakeChannel(), audio: a.audio, objectUrl: urls });
    one.setAvailable(true);
    two.setAvailable(true);

    await one.play({ id: "L1", voice: false });
    expect(fetch).not.toHaveBeenCalled();

    two.choose();
    expect(one.snapshot.chosen).toBe(false);
    await one.play({ id: "L1", voice: true });
    expect(fetch).not.toHaveBeenCalled();
    await two.play({ id: "L1", voice: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(two.snapshot.speaking).toBe("L1");
    a.made[0]?.end();
    expect(two.snapshot.speaking).toBeNull();

    // Back to the first tab: the second one stops.
    await two.play({ id: "L2", voice: true });
    one.choose();
    expect(two.snapshot.chosen).toBe(false);
    expect(two.snapshot.speaking).toBeNull();

    one.toggle();
    expect(one.snapshot.on).toBe(false);
    await one.play({ id: "L3", voice: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    one.toggle();
    expect(one.snapshot.on).toBe(true);
    one.dispose();
    two.dispose();
  });

  it("a line that cannot be fetched says why on the key, until the room's state says otherwise", async () => {
    const v = new RoomVoice({
      fetch: async () => {
        throw new ApiError("http", 429, "/v", "這小時聽太多了");
      },
      tab: "t",
      channel: null,
      audio: fakeAudio().audio,
      objectUrl: urls,
      problem: problemOf,
    });
    v.setAvailable(true);
    await v.play({ id: "L1", voice: true });
    expect(voiceKey({ available: true, reason: null }, v.snapshot)).toMatchObject({ usable: true, reason: "這小時聽太多了" });
    v.setAvailable(false);
    expect(voiceKey({ available: false, reason: "聲音借給唱歌了,唱完就好" }, v.snapshot)).toEqual({
      usable: false,
      pressed: false,
      reason: "聲音借給唱歌了,唱完就好",
      label: "她的聲音",
    });
    v.dispose();
  });
});
