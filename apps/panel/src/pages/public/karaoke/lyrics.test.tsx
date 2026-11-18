// The lyrics of reference.json version 2 under the lane: pieces lit as they are sung, readings
// above them, 「聽寫」 on heard lyrics, the mark on a line that did not match, what this browser
// keeps (the reading shown, the key of each song), and a version 1 reference read the same way.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  karaokeBackingName,
  karaokeReferenceV2,
  shiftKaraokeReference,
  type WorkersKaraokeLineV2,
  type WorkersKaraokeLyricsV2,
  type WorkersKaraokePiece,
  type WorkersKaraokeReferenceV1,
} from "@miyoria/contracts/workers/karaoke";
import {
  isDoubtful,
  keyLabel,
  lineProgress,
  loadKey,
  loadReading,
  pieceProgress,
  readingLabel,
  readingModes,
  rubyOf,
  saveKey,
  saveReading,
} from "./lyric-text";
import { Lyrics } from "./Lyrics";

const piece = (text: string, start: number | null, end: number | null, over: Partial<WorkersKaraokePiece> = {}) => ({
  text,
  sung: text.trim() !== "",
  start,
  end,
  reading: null,
  roman: null,
  ...over,
});

const line = (over: Partial<WorkersKaraokeLineV2> = {}): WorkersKaraokeLineV2 => ({
  start: 1,
  end: 4,
  text: "私は歌う",
  status: "matched",
  source: "found",
  similarity: 1,
  heard: "私は歌う",
  aligned: true,
  pieces: [
    piece("私", 1, 2, { reading: "わたし", roman: "watashi" }),
    piece("は", 2, 2.5, { roman: "wa" }),
    piece(" ", null, null),
    piece("歌う", 2.5, 3.5, { reading: "うたう", roman: "utau" }),
  ],
  edited: false,
  ...over,
});

const lyrics = (lines: WorkersKaraokeLineV2[], over: Partial<WorkersKaraokeLyricsV2> = {}): WorkersKaraokeLyricsV2 => ({
  provider: "lrclib",
  source: "found",
  language: "ja",
  timing: "char",
  check: null,
  lines,
  ...over,
});

function memory(): () => Pick<Storage, "getItem" | "setItem"> {
  const m = new Map<string, string>();
  const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  return () => s;
}

describe("the lyrics' logic", () => {
  it("lights each piece by its own time, and a space as the piece before it", () => {
    const l = line();
    expect(pieceProgress(l.pieces?.[0] as WorkersKaraokePiece, 1.5)).toBe(0.5);
    expect(pieceProgress(l.pieces?.[2] as WorkersKaraokePiece, 1.5)).toBeNull();
    expect(lineProgress(l, 0.5)).toEqual([0, 0, 0, 0]);
    expect(lineProgress(l, 2.25)).toEqual([1, 0.5, 0, 0]);
    expect(lineProgress(l, 3)).toEqual([1, 1, 1, 0.5]);
    expect(lineProgress(l, 9)).toEqual([1, 1, 1, 1]);
    expect(lineProgress(line({ aligned: false }), 2)).toBeNull();
    expect(lineProgress(line({ pieces: null }), 2)).toBeNull();
  });

  it("offers the readings the pieces carry, named for the language", () => {
    expect(readingModes(lyrics([line()]))).toEqual(["reading", "roman"]);
    expect(readingModes(lyrics([line({ pieces: null })]))).toEqual([]);
    expect(readingModes(null)).toEqual([]);
    expect(readingLabel("reading", "ja")).toBe("假名");
    expect(readingLabel("reading", "zh")).toBe("拼音");
    expect(readingLabel("roman", "ja")).toBe("羅馬字");
    const p = line().pieces?.[0] as WorkersKaraokePiece;
    expect([rubyOf(p, "off"), rubyOf(p, "reading"), rubyOf(p, "roman")]).toEqual([null, "わたし", "watashi"]);
  });

  it("marks only looked-up lines that did not match", () => {
    expect(isDoubtful(line({ status: "uncertain" }))).toBe(true);
    expect(isDoubtful(line({ status: "failed" }))).toBe(true);
    expect(isDoubtful(line({ status: "matched" }))).toBe(false);
    expect(isDoubtful(line({ status: "unchecked" }))).toBe(false);
    expect(isDoubtful(line({ status: "uncertain", source: "heard" }))).toBe(false);
  });

  it("keeps the reading and each song's key in this browser", () => {
    const s = memory();
    expect(loadReading(s)).toBe("off");
    saveReading("roman", s);
    expect(loadReading(s)).toBe("roman");
    expect(loadKey("song", 6, s)).toBe(0);
    saveKey("song", -3, s);
    expect(loadKey("song", 6, s)).toBe(-3);
    s().setItem("miyoria.karaoke.key:song", "9");
    expect(loadKey("song", 6, s)).toBe(0);
    const broken = () => ({
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadReading(broken)).toBe("off");
    expect(() => saveKey("x", 1, broken)).not.toThrow();
    expect([keyLabel(0), keyLabel(2), keyLabel(-3)]).toEqual(["原調", "+2", "−3"]);
  });

  it("reads a version 1 reference as version 2, and moves a reference to another key", () => {
    const v1: WorkersKaraokeReferenceV1 = {
      format: "miyoria.karaoke.reference",
      version: 1,
      id: "k",
      title: "t",
      artist: null,
      duration_s: 2,
      backing: "karaoke.m4a",
      pitch: { hz: 50, start: 0, midi: [60, null, 61.5] },
      notes: [{ start: 0, end: 1, midi: 60, source: "pitch", line: null, char: null }],
      lyrics: {
        provider: "lrclib",
        timing: "line",
        lines: [{ start: 0, end: 2, text: "la", check: "unchecked", confidence: null, chars: null }],
      },
      quality: { ok: true, reason: null, voiced_ratio: 0.6, notes: 1, lead_split: true },
      made: { pitch: "rmvpe", notes: "pitch-runs-1", lyrics: "line" },
    };
    const v2 = karaokeReferenceV2(v1);
    expect(v2.version).toBe(2);
    expect(v2.lyrics?.source).toBe("found");
    expect(v2.lyrics?.lines[0]).toMatchObject({ status: "unchecked", aligned: false, pieces: null });
    const up = shiftKaraokeReference(v2, 3);
    expect(up.pitch.midi).toEqual([63, null, 64.5]);
    expect(up.notes[0]?.midi).toBe(63);
    expect(shiftKaraokeReference(v2, 0)).toBe(v2);
    expect([karaokeBackingName(0), karaokeBackingName(3), karaokeBackingName(-6)]).toEqual([
      "karaoke.m4a",
      "karaoke.k+3.m4a",
      "karaoke.k-6.m4a",
    ]);
  });
});

describe("the lyrics on screen", () => {
  it("lights the line being sung and shows the next one", () => {
    const next = line({ start: 4, end: 7, text: "次", pieces: [piece("次", 4, 5)] });
    const { container } = render(
      <Lyrics lyrics={lyrics([line(), next])} now={2.25} loaded mode="off" onMode={() => {}} />,
    );
    const lit = [...container.querySelectorAll("[data-lit]")].map((el) => el.getAttribute("data-lit"));
    // 私 sung, は half way, 歌う not yet; the next line is not lit.
    expect(lit).toEqual(["all", "part", "none", "none"]);
    expect(screen.getByText("次")).toBeInTheDocument();
    expect(container.querySelector("rt")).toBeNull();
  });

  it("shows readings above the words when asked, and the choice goes back", async () => {
    let chosen = "";
    const { container } = render(
      <Lyrics lyrics={lyrics([line()])} now={1} loaded mode="reading" onMode={(m) => void (chosen = m)} />,
    );
    expect([...container.querySelectorAll("rt")].map((r) => r.textContent)).toEqual(["わたし", "うたう"]);
    await userEvent.click(screen.getByRole("radio", { name: "羅馬字" }));
    expect(chosen).toBe("roman");
    expect(screen.getByRole("radio", { name: "假名" })).toHaveAttribute("aria-checked", "true");
  });

  it("says heard lyrics are 聽寫, and marks a line that did not match", () => {
    const doubtful = line({ status: "uncertain", aligned: false, start: 0 });
    render(
      <Lyrics
        lyrics={lyrics([{ ...doubtful, source: "heard" }], { source: "heard" })}
        now={0.5}
        loaded
        mode="off"
        onMode={() => {}}
      />,
    );
    expect(screen.getByText("聽寫")).toBeInTheDocument();
    // Heard lines are all unsure: the badge says so, the line gets no mark of its own.
    expect(screen.queryByTitle("這一行和聽到的不太一樣")).toBeNull();
    render(<Lyrics lyrics={lyrics([doubtful])} now={0.5} loaded mode="off" onMode={() => {}} />);
    expect(screen.getByTitle("這一行和聽到的不太一樣")).toHaveTextContent("私は 歌う");
  });

  it("says so when there are no lyrics", () => {
    render(<Lyrics lyrics={null} now={0} loaded mode="off" onMode={() => {}} />);
    expect(screen.getByText("沒有找到歌詞")).toBeInTheDocument();
  });
});
