import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Figure } from "./FigureView";
import type { HerFigure } from "./figure";
import {
  CROSSFADE_MS,
  FIGURE_FACES,
  type FigureHandle,
  type FigureModule,
  faceFor,
  frameFor,
  live2dFigure,
  pickSize,
} from "./live2d";
import { roomState } from "./room-fixtures";
import { type AudioLike, RoomVoice } from "./voice";

function fakeLoops() {
  const calls: string[] = [];
  const loops: HerFigure = {
    mount: (into) => {
      calls.push("mount");
      into.appendChild(document.createElement("video"));
    },
    show: (pose) => calls.push(`show:${pose}`),
    speaking: () => {},
    dispose: () => calls.push("dispose"),
  };
  return { loops, calls };
}

function fakeHandle() {
  const calls: string[] = [];
  const handle: FigureHandle = {
    setMood: (f) => calls.push(`mood:${f}`),
    setState: (d) => calls.push(`state:${d}`),
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

  it("only ever names a face the Core describes", () => {
    const words = ["開心", "得意", "生氣", "嫌棄", "害羞", "有點難過", "驚訝", "寂寞", "平靜", "不甘心", "感激"];
    for (const word of words) {
      expect(FIGURE_FACES).toContain(faceFor(roomState({ mood: { word, face: null } }), null));
    }
  });

  it("frames her as the loops do and picks a texture size for the screen", () => {
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
  it("keeps the loops, quietly, when the manifest cannot be read", async () => {
    const { loops, calls } = fakeLoops();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const box = document.createElement("div");
    const fig = live2dFigure({
      manifest: "/api/member/room/figure?v=1",
      reduced: () => false,
      level: () => 0,
      loops: () => loops,
      afterPaint: (fn) => {
        fn();
        return () => {};
      },
      fetchManifest: async () => {
        throw new Error("404");
      },
    });
    fig.mount(box);
    await flush();
    expect(box.querySelector("canvas")).toBeNull();
    expect(box.querySelector("video")).not.toBeNull();
    expect(box.classList.contains("hr-live")).toBe(false);
    fig.show("sing");
    expect(calls).toEqual(["mount", "show:sing"]);
    fig.dispose();
    expect(calls).toContain("dispose");
    debug.mockRestore();
  });

  it("keeps the loops when the bundle refuses to draw her (no WebGL)", async () => {
    const { loops, calls } = fakeLoops();
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
      loops: () => loops,
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
    expect(calls).not.toContain("dispose");
    fig.dispose();
    debug.mockRestore();
  });

  it("waits for the first paint, draws her over the loops, then lets the loops go", async () => {
    vi.useFakeTimers();
    const { loops, calls: loopCalls } = fakeLoops();
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
      loops: () => loops,
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
    expect(loopCalls).not.toContain("dispose");
    vi.advanceTimersByTime(CROSSFADE_MS + 200);
    expect(loopCalls).toContain("dispose");
    // Her voice's level reaches the mouth while she speaks, and the mouth closes after.
    fig.speaking(true);
    expect(calls).toContain("speak:0.5");
    level = 0;
    fig.speaking(false);
    expect(calls[calls.length - 1]).toBe("speak:0");
    fig.dispose();
    expect(calls).toContain("destroy");
    expect(box.querySelector("canvas")).toBeNull();
    expect(loopCalls.filter((c) => c === "dispose")).toHaveLength(1);
  });

  it("never loads the bundle once it is taken away before the paint", async () => {
    const { loops } = fakeLoops();
    const cancel = vi.fn();
    const fetchManifest = vi.fn(async () => MANIFEST);
    const fig = live2dFigure({
      manifest: "/m",
      reduced: () => false,
      level: () => 0,
      loops: () => loops,
      afterPaint: () => cancel,
      fetchManifest,
    });
    fig.mount(document.createElement("div"));
    fig.dispose();
    expect(cancel).toHaveBeenCalled();
    expect(fetchManifest).not.toHaveBeenCalled();
  });

  it("uses the loops when the Core serves no figure, and a figure of the caller's own in tests", () => {
    const { container, rerender } = render(
      <Figure pose="heart" face="neutral" doing="idle" speaking={false} manifest={null} level={() => 0} />,
    );
    expect(container.querySelector(".hr-figure video")).not.toBeNull();
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
