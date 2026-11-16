// Her Wordle game: the extension's `ext.miyoria.wordle.board` becomes a `wordle` message for the
// overlay; the hub keeps a game in progress for clients that connect later, not a finished one.

import { type Envelope, Events, eventEnvelope } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  Forwarder,
  OverlayHub,
  parseCoreMessage,
  parseWordle,
  WORDLE_TOPIC,
} from "../src/index.js";

const row = { word: "SLATE", marks: ["absent", "absent", "correct", "absent", "absent"] };
const playing = { rows: [row], max_guesses: 6, state: "playing", answer: null };
const won = {
  rows: [row, { ...row, word: "CRANE", marks: Array(5).fill("correct") }],
  max_guesses: 6,
  state: "won",
  answer: "CRANE",
};

const ev = (data: unknown): Envelope =>
  eventEnvelope("ext.miyoria.wordle", Events.ExtensionEvent, data as never, { type: WORDLE_TOPIC });

describe("wordle", () => {
  it("round-trips on the link and is bounded", () => {
    for (const board of [playing, won, null]) {
      const msg = { type: "wordle", board };
      expect(parseCoreMessage(msg)).toStrictEqual(msg);
    }
    for (const board of [
      { ...playing, rows: [{ ...row, word: "slate" }] },
      { ...playing, rows: [{ ...row, marks: ["absent"] }] },
      { ...playing, max_guesses: 13 },
      { ...playing, state: "done" },
      { ...playing, rows: Array(13).fill(row) },
    ]) {
      expect(() => parseCoreMessage({ type: "wordle", board }), JSON.stringify(board)).toThrow();
    }
  });

  it("reads the extension's payload, and refuses a board that contradicts itself", () => {
    expect(parseWordle({ board: playing })).toStrictEqual(playing);
    expect(parseWordle({ board: null })).toBeNull();
    expect(parseWordle({})).toBeUndefined();
    expect(parseWordle("nope")).toBeUndefined();
    // An answer before the end, none after it, more rows than guesses allowed.
    expect(parseWordle({ board: { ...playing, answer: "CRANE" } })).toBeUndefined();
    expect(parseWordle({ board: { ...won, answer: null } })).toBeUndefined();
    expect(parseWordle({ board: { ...won, max_guesses: 1 } })).toBeUndefined();
  });

  it("the forwarder turns the board event into a wordle message and drops junk", () => {
    const f = new Forwarder(false);
    expect(f.onEvent(ev({ board: playing }))).toStrictEqual([{ type: "wordle", board: playing }]);
    expect(f.onEvent(ev({ board: null }))).toStrictEqual([{ type: "wordle", board: null }]);
    expect(f.onEvent(ev({ board: { ...playing, state: "?" } }))).toEqual([]);
  });

  it("the hub sends every board and replays only the game in progress", () => {
    const hub = new OverlayHub();
    const seen: unknown[] = [];
    hub.listen((t) => seen.push(JSON.parse(t)));
    hub.wordle(playing as never);
    expect(seen).toEqual([{ type: "wordle", board: playing }]);
    expect(hub.initial().map((t) => JSON.parse(t))).toContainEqual({
      type: "wordle",
      board: playing,
    });
    hub.wordle(won as never);
    expect(hub.initial().some((t) => t.includes('"wordle"'))).toBe(false);
    hub.wordle(playing as never);
    hub.wordle(null);
    expect(hub.initial().some((t) => t.includes('"wordle"'))).toBe(false);
  });
});
