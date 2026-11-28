import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Figure } from "./FigureView";
import { type CueSeen, type HerFigure, nextCue } from "./figure";
import {
  CROSSFADE_MS,
  FIGURE_FACES,
  type FigureHandle,
  type FigureModule,
  faceFor,
  frameFor,
  live2dFigure,
  pickSize,
  stateFor,
  syllableLength,
  TEXT_PAUSE_MS,
  textMouth,
} from "./live2d";
import { roomState } from "./room-fixtures";
import { type AudioLike, RoomVoice } from "./voice";

function fakeHandle() {
  const calls: string[] = [];
  const handle: FigureHandle = {
    setMood: (f) => calls.push(`mood:${f}`),
    setState: (d) => calls.push(`state:${d}`),
    react: (k) => calls.push(`react:${k}`),
    speak: (n) => calls.push(`speak:${n}`),
    lookAt: (x) => calls.push(`look:${x}`),
    resize: () => calls.push("resize"),
    destroy: () => calls.push("destroy"),
  };
  return { handle, calls };
}

const MANIFEST = { version: 1, bundle: "/api/member/room/figure/figure-0123456789abcdef0123.js", sizes: [1024, 2048] };

/** Runs everything queued, the paint wait included. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe("her Live2D face", () => {
  it("shows what she does first, then her line's face, then her mood", () => {
    expect(faceFor(null, "happy")).toBe("neutral");
    expect(faceFor(roomState({ open: false }), "happy")).toBe("neutral");
    expect(faceFor(roomState({ doing: "offline" }), "happy")).toBe("neutral");
    expect(faceFor(roomState({ doing: "singing" }), "angry")).toBe("singing");
    expect(faceFor(roomState({ doing: "working" }), "angry")).toBe("working");
    expect(faceFor(roomState({ doing: "browsing" }), null)).toBe("working");
    expect(faceFor(roomState(), "Smug")).toBe("smug");
    expect(faceFor(roomState(), "shy")).toBe("embarrassed");
    expect(faceFor(roomState(), "joy")).toBe("happy");
    expect(faceFor(roomState({ mood: { word: "生氣", face: "sad" } }), null)).toBe("sad");
    expect(faceFor(roomState({ mood: { word: "生氣", face: null } }), null)).toBe("angry");
    expect(faceFor(roomState({ mood: { word: "得意", face: null } }), "nonsense")).toBe("smug");
    expect(faceFor(roomState({ mood: { word: "平靜", face: null } }), null)).toBe("neutral");
    expect(faceFor(roomState({ mood: null }), null)).toBe("neutral");
  });

  it("thinks with the thinking face, unless what she does shows first", () => {
    expect(faceFor(roomState(), "happy", true)).toBe("thinking");
    expect(faceFor(roomState({ doing: "singing" }), null, true)).toBe("singing");
    expect(faceFor(roomState({ doing: "working" }), null, true)).toBe("working");
    expect(faceFor(roomState({ open: false }), null, true)).toBe("neutral");
    expect(stateFor("idle", true)).toBe("thinking");
    expect(stateFor("in_voice", true)).toBe("thinking");
    expect(stateFor("idle", false)).toBe("idle");
    // Her work's look down wins over the thinking pose.
    expect(stateFor("working", true)).toBe("working");
    expect(stateFor("browsing", true)).toBe("browsing");
    expect(stateFor("singing", true)).toBe("singing");
    expect(stateFor("still", true)).toBe("still");
  });

  it("only ever names a face the Core describes", () => {
    const words = ["開心", "得意", "生氣", "嫌棄", "害羞", "有點難過", "驚訝", "寂寞", "平靜", "不甘心", "感激"];
    for (const word of words) {
      expect(FIGURE_FACES).toContain(faceFor(roomState({ mood: { word, face: null } }), null));
    }
  });

  it("frames her and picks a texture size for the screen", () => {
    expect(frameFor(false)).toEqual({ height: 1.36, top: 0.01 });
    expect(frameFor(true)).toEqual({ height: 1.08, top: 0.01 });
    expect(pickSize([1024, 2048], { figurePx: 1150, memoryGb: null })).toBe(2048);
    expect(pickSize([1024, 2048], { figurePx: 900, memoryGb: 8 })).toBe(1024);
    // A phone at 2x: her figure is about 1600 device pixels tall.
    expect(pickSize([1024, 2048], { figurePx: 1640, memoryGb: null })).toBe(2048);
    expect(pickSize([2048, 1024], { figurePx: 3000, memoryGb: 2 })).toBe(1024);
    expect(pickSize([2048], { figurePx: 500, memoryGb: 2 })).toBe(2048);
    expect(pickSize([512, 1024, 2048], { figurePx: 4000, memoryGb: 16 })).toBe(2048);
    expect(pickSize([1024, 2048, 4096], { figurePx: 2400, memoryGb: 8 })).toBe(4096);
    expect(pickSize([], { figurePx: 2400, memoryGb: 8 })).toBe(0);
  });
});

describe("her Live2D figure on the stage", () => {
  it("stays without her, quietly, when the manifest cannot be read", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const box = document.createElement("div");
    const fig = live2dFigure({
      manifest: "/api/member/room/figure?v=1",
      reduced: () => false,
      level: () => 0,
      afterPaint: (fn) => {
        fn();
        return () => {};
      },
      fetchManifest: async () => {
        throw new Error("404");
      },
    });
    fig.mount(box);
    fig.show("heart");
    // Nothing on the stage while she loads, and nothing once she has failed to.
    expect(box.children.length).toBe(0);
    await flush();
    expect(box.querySelector("canvas")).toBeNull();
    expect(box.querySelector("video")).toBeNull();
    expect(box.children.length).toBe(0);
    expect(box.classList.contains("hr-live")).toBe(false);
    fig.show("sing");
    fig.speaking(true);
    expect(box.children.length).toBe(0);
    fig.dispose();
    debug.mockRestore();
  });

  it("stays without her when the bundle refuses to draw her (no WebGL)", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const box = document.createElement("div");
    const mod: FigureModule = {
      mount: async () => {
        throw new Error("no WebGL");
      },
    };
    const fig = live2dFigure({
      manifest: "/m",
      reduced: () => false,
      level: () => 0,
      afterPaint: (fn) => {
        fn();
        return () => {};
      },
      fetchManifest: async () => MANIFEST,
      importBundle: async () => mod,
    });
    fig.mount(box);
    await flush();
    expect(box.querySelector("canvas")).toBeNull();
    expect(box.querySelector("video")).toBeNull();
    expect(box.classList.contains("hr-live")).toBe(false);
    fig.dispose();
    debug.mockRestore();
  });

  it("waits for the first paint and draws her, with no video ever on the stage", async () => {
    vi.useFakeTimers();
    const { handle, calls } = fakeHandle();
    const imported: string[] = [];
    let mounted: { size: number } | null = null;
    let paint: (() => void) | null = null;
    const box = document.createElement("div");
    let level = 0.5;
    const fig = live2dFigure({
      manifest: "/m",
      reduced: () => false,
      level: () => level,
      afterPaint: (fn) => {
        paint = fn;
        return () => {};
      },
      fetchManifest: async () => MANIFEST,
      importBundle: async (url) => {
        imported.push(url);
        return {
          mount: async (_canvas, o) => {
            mounted = { size: o.size };
            return handle;
          },
        };
      },
    });
    fig.mount(box);
    fig.feel?.("happy", "idle");
    expect(imported).toEqual([]);
    (paint as unknown as () => void)();
    await flush();
    expect(imported).toEqual([MANIFEST.bundle]);
    // jsdom has no layout: a stage of no height wants the smallest set.
    expect(mounted).toEqual({ size: 1024 });
    expect(box.querySelector("canvas.hr-l2d")).not.toBeNull();
    expect(box.classList.contains("hr-live")).toBe(true);
    expect(calls.slice(0, 2)).toEqual(["mood:happy", "state:idle"]);
    fig.feel?.("singing", "singing");
    expect(calls).toContain("mood:singing");
    vi.advanceTimersByTime(CROSSFADE_MS + 200);
    expect(box.querySelector("video")).toBeNull();
    // Her voice's level reaches the mouth while she speaks, and the mouth closes after.
    fig.speaking(true);
    expect(calls).toContain("speak:0.5");
    level = 0;
    fig.speaking(false);
    expect(calls[calls.length - 1]).toBe("speak:0");
    fig.dispose();
    expect(calls).toContain("destroy");
    expect(box.querySelector("canvas")).toBeNull();
    expect(box.querySelector("video")).toBeNull();
  });

  it("never loads the bundle once it is taken away before the paint", async () => {
    const cancel = vi.fn();
    const fetchManifest = vi.fn(async () => MANIFEST);
    const fig = live2dFigure({
      manifest: "/m",
      reduced: () => false,
      level: () => 0,
      afterPaint: () => cancel,
      fetchManifest,
    });
    fig.mount(document.createElement("div"));
    fig.dispose();
    expect(cancel).toHaveBeenCalled();
    expect(fetchManifest).not.toHaveBeenCalled();
  });

  it("shows no figure when the Core serves none, and a figure of the caller's own in tests", () => {
    const { container, rerender } = render(
      <Figure pose="heart" face="neutral" doing="idle" speaking={false} manifest={null} level={() => 0} />,
    );
    expect(container.querySelector(".hr-figure")).not.toBeNull();
    expect(container.querySelector(".hr-figure video")).toBeNull();
    expect(container.querySelector(".hr-figure canvas")).toBeNull();
    const made: string[] = [];
    const make = (): HerFigure => ({
      mount: () => made.push("mount"),
      show: (p) => made.push(`show:${p}`),
      feel: (f, d) => made.push(`feel:${f}:${d}`),
      speaking: () => {},
      dispose: () => made.push("dispose"),
    });
    rerender(
      <Figure pose="sing" face="singing" doing="singing" speaking={false} manifest="/m" level={() => 0} make={make} />,
    );
    expect(made.slice(0, 3)).toEqual(["mount", "show:sing", "feel:singing:singing"]);
    expect(container.querySelector(".hr-figure")?.getAttribute("data-face")).toBe("singing");
  });
});

describe("her reactions", () => {
  it("cues a nod for a new line of the member's and a bounce or a look away for her bond", () => {
    let seen: CueSeen = { heard: null, bond: null, cue: null };
    expect(nextCue(seen, null, null)).toBe(seen);
    seen = nextCue(seen, "c1", null);
    expect(seen.cue).toEqual({ kind: "heard", n: 1 });
    // The same line (the Core's echo of it) is not heard twice.
    expect(nextCue(seen, "c1", null)).toBe(seen);
    seen = nextCue(seen, "c2", null);
    expect(seen.cue).toEqual({ kind: "heard", n: 2 });
    seen = nextCue(seen, "c2", { id: "B1", sign: "plus" });
    expect(seen.cue).toEqual({ kind: "up", n: 3 });
    seen = nextCue(seen, "c2", { id: "B2", sign: "minus" });
    expect(seen.cue).toEqual({ kind: "down", n: 4 });
    // Their line going away (a send that failed) is no cue: the last one stays.
    seen = nextCue(seen, null, { id: "B2", sign: "minus" });
    expect(seen.cue).toEqual({ kind: "down", n: 4 });
  });

  it("moves the text mouth about six times a second, modestly, closing between syllables", () => {
    let total = 0;
    for (let n = 0; n < 600; n++) {
      const length = syllableLength(n);
      expect(length).toBeGreaterThanOrEqual(0.13);
      expect(length).toBeLessThanOrEqual(0.27);
      total += length;
      expect(textMouth(n, 0)).toBe(0);
      expect(textMouth(n, length - 0.001)).toBe(0);
      const peak = textMouth(n, 0.62 * 0.065);
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(0.75);
    }
    const perSecond = 600 / total;
    expect(perSecond).toBeGreaterThan(5);
    expect(perSecond).toBeLessThan(7.5);
  });

  async function drawn(handle: FigureHandle, level: () => number = () => 0) {
    const fig = live2dFigure({
      manifest: "/m",
      reduced: () => false,
      level,
      afterPaint: (fn) => {
        fn();
        return () => {};
      },
      fetchManifest: async () => MANIFEST,
      importBundle: async () => ({ mount: async () => handle }),
    });
    fig.mount(document.createElement("div"));
    await flush();
    return fig;
  }

  const speaks = (calls: readonly string[]) =>
    calls.filter((c) => c.startsWith("speak:")).map((c) => Number(c.slice("speak:".length)));

  it("passes her reactions and her thinking to the figure", async () => {
    const { handle, calls } = fakeHandle();
    const fig = await drawn(handle);
    fig.feel?.("happy", "idle");
    fig.react?.("heard");
    fig.thinking?.(true);
    expect(calls).toContain("react:heard");
    expect(calls[calls.length - 1]).toBe("state:thinking");
    // Her work's look down wins while she thinks.
    fig.feel?.("working", "working");
    expect(calls[calls.length - 1]).toBe("state:working");
    fig.feel?.("neutral", "idle");
    expect(calls[calls.length - 1]).toBe("state:thinking");
    fig.thinking?.(false);
    expect(calls[calls.length - 1]).toBe("state:idle");
    fig.react?.("up");
    fig.react?.("down");
    expect(calls.filter((c) => c.startsWith("react:"))).toEqual(["react:heard", "react:up", "react:down"]);
    fig.dispose();
  });

  it("does not trip over a bundle from before her reactions", async () => {
    const { handle, calls } = fakeHandle();
    const { react: _gone, ...old } = handle;
    const fig = await drawn(old);
    expect(() => fig.react?.("heard")).not.toThrow();
    expect(() => fig.thinking?.(true)).not.toThrow();
    expect(calls).toContain("state:thinking");
    fig.dispose();
  });

  it("moves her mouth with the text while it comes in, and lets her voice win", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
    const { handle, calls } = fakeHandle();
    let level = 0.9;
    const fig = await drawn(handle, () => level);
    fig.mouthing?.("你");
    vi.advanceTimersByTime(600);
    fig.mouthing?.("你好");
    vi.advanceTimersByTime(600);
    const moving = speaks(calls);
    expect(moving.length).toBeGreaterThan(30);
    expect(Math.max(...moving)).toBeGreaterThan(0.3);
    expect(Math.max(...moving)).toBeLessThanOrEqual(0.75);
    // It closes between syllables too.
    expect(moving.filter((v) => v === 0).length).toBeGreaterThan(5);

    // Punctuation closes it for a moment.
    calls.length = 0;
    fig.mouthing?.("你好,");
    vi.advanceTimersByTime(TEXT_PAUSE_MS - 40);
    expect(speaks(calls).every((v) => v === 0)).toBe(true);
    vi.advanceTimersByTime(400);
    expect(Math.max(...speaks(calls))).toBeGreaterThan(0);

    // Her voice playing wins over the text.
    calls.length = 0;
    fig.speaking(true);
    vi.advanceTimersByTime(300);
    expect(speaks(calls).every((v) => v === 0.9)).toBe(true);
    level = 0;
    fig.speaking(false);
    calls.length = 0;
    vi.advanceTimersByTime(600);
    expect(Math.max(...speaks(calls))).toBeGreaterThan(0);

    // The line is whole: the mouth closes and stays closed.
    fig.mouthing?.(null);
    expect(calls[calls.length - 1]).toBe("speak:0");
    calls.length = 0;
    vi.advanceTimersByTime(500);
    expect(speaks(calls)).toEqual([]);
    fig.dispose();
  });

  it("plays a new cue once, never the one it started with, and passes thinking and the text on", () => {
    const made: string[] = [];
    const make = (): HerFigure => ({
      mount: () => {},
      show: () => {},
      speaking: () => {},
      thinking: (on) => made.push(`thinking:${on}`),
      mouthing: (t) => made.push(`mouthing:${t}`),
      react: (k) => made.push(`react:${k}`),
      dispose: () => {},
    });
    const props = { pose: "heart", face: "neutral", doing: "idle", speaking: false, manifest: "/m", level: () => 0, make } as const;
    const { rerender } = render(<Figure {...props} cue={{ kind: "up", n: 3 }} />);
    expect(made).not.toContain("react:up");
    rerender(<Figure {...props} cue={{ kind: "heard", n: 4 }} thinking />);
    expect(made.filter((m) => m.startsWith("react:"))).toEqual(["react:heard"]);
    expect(made).toContain("thinking:true");
    rerender(<Figure {...props} cue={{ kind: "heard", n: 4 }} revealing="你好" />);
    expect(made.filter((m) => m.startsWith("react:"))).toEqual(["react:heard"]);
    expect(made).toContain("thinking:false");
    expect(made).toContain("mouthing:你好");
    rerender(<Figure {...props} cue={{ kind: "heard", n: 5 }} revealing={null} />);
    expect(made.filter((m) => m.startsWith("react:"))).toEqual(["react:heard", "react:heard"]);
    expect(made[made.length - 2]).toBe("mouthing:null");
  });
});

describe("her voice's level", () => {
  it("reads the line's loudness at the playing moment, and nothing when nothing plays", async () => {
    let time = 0;
    let ended: (() => void) | null = null;
    const audio = (): AudioLike => {
      const a: AudioLike = {
        src: "",
        get currentTime() {
          return time;
        },
        onended: null,
        onerror: null,
        play: async () => {
          ended = () => a.onended?.();
        },
        pause: () => {},
      };
      return a;
    };
    const voice = new RoomVoice({
      fetch: async () => new Blob(["wav"]),
      tab: "t",
      channel: null,
      audio,
      objectUrl: { create: () => "blob:x", revoke: () => {} },
      envelope: async () => ({ rate: 10, values: Float32Array.from([0, 0.5, 1, 0.25]) }),
    });
    voice.setAvailable(true);
    expect(voice.level()).toBe(0);
    await act(async () => {
      await voice.play({ id: "l1", voice: true });
    });
    await flush();
    time = 0.15;
    expect(voice.level()).toBe(0.5);
    time = 0.25;
    expect(voice.level()).toBe(1);
    time = 9;
    expect(voice.level()).toBe(0);
    act(() => (ended as unknown as () => void)());
    time = 0.15;
    expect(voice.level()).toBe(0);
    voice.dispose();
  });
});
