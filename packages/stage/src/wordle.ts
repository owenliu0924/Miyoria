// Her Wordle game on the overlay. The `miyoria.wordle` extension publishes the board of the game
// she plays (`ext.miyoria.wordle.board`, `{board}`) after every change; Core passes it to the
// Stage as a `wordle` message and the Stage to the overlay, which draws the grid.

import { StageLinkWordleBoardSchema, type WordleBoard } from "@miyoria/contracts/stage-link";
import { isJsonObject, type JsonValue } from "@miyoria/types";

export type { WordleBoard };

/** Topic of the board (`{board: WordleBoard | null}`). */
export const WORDLE_TOPIC = "ext.miyoria.wordle.board";

/**
 * The board an `ext.miyoria.wordle.board` payload carries: the board, `null` (take it away), or
 * `undefined` when the payload is anything else.
 */
export function parseWordle(payload: JsonValue): WordleBoard | null | undefined {
  if (!isJsonObject(payload) || !("board" in payload)) return undefined;
  if (payload.board === null) return null;
  const parsed = StageLinkWordleBoardSchema.safeParse(payload.board);
  if (!parsed.success) return undefined;
  const board = parsed.data;
  // A board with more guesses than it allows, or an answer before the end, is not one.
  if (board.rows.length > board.max_guesses) return undefined;
  if ((board.state === "playing") !== (board.answer === null)) return undefined;
  return board;
}
