// From the text of one model step to the lines that may leave, as it streams. These are the
// screens the new runner keeps from today's turn (docs/design/v4-patches.md §2, owner decision
// Q8), each of them today's code:
//
// - #11 `<emo:thinking>…</emo:thinking>` is her reasoning and is never shown; #18 a tool written
//   as a tag, DeepSeek's tool-call markup and HTML tags are taken out (`ExpressionParser`);
// - #9 a response that turns out to be reasoning is dropped from the line that shows it, the held
//   first line included (`ReplyScreen`);
// - #19 a line she wrote to herself about how to answer is left out, the rest stays (`isSelfTalk`).
//
// One line of text is one message; a ``` block stays one message whatever its line breaks
// (`FenceSplitter`). Nothing here knows where a line goes.

import {
  ExpressionParser,
  FenceSplitter,
  ReplyScreen,
  type Segment,
} from "../../agent/src/index.js";

export interface ScreenedLine {
  text: string;
  /** The emotion she last marked before the line ended. */
  emotion: string | null;
}

export class StepText {
  readonly #parser = new ExpressionParser();
  readonly #fence = new FenceSplitter();
  readonly #screen = new ReplyScreen<ScreenedLine>();
  #buffer = "";
  #emotion: string | null = null;
  #seenText = false;
  #silence = false;
  /** Tools written as tags that were taken out of her text. */
  tagsStripped = 0;

  /** `<silence/>` came before any text: she chose not to speak, and the rest is ignored. */
  get silence(): boolean {
    return this.#silence;
  }

  /** The response was judged a reasoning leak (#9). */
  get leaked(): boolean {
    return this.#screen.dropped;
  }

  /** Lines the leak screen dropped. */
  get leakDropped(): number {
    return this.#screen.droppedLines;
  }

  /** Lines left out as notes to herself (#19). */
  get selfTalkCut(): number {
    return this.#screen.selfTalk;
  }

  /** Whether she wrote any text that is not markup. */
  get wroteText(): boolean {
    return this.#seenText;
  }

  /** A piece of the step's text; returns the lines that may go out now. */
  push(delta: string): ScreenedLine[] {
    return this.#take(this.#parser.push(delta));
  }

  /** The step's text ended: what was still held. */
  finish(): ScreenedLine[] {
    const out = this.#take(this.#parser.finish());
    if (!this.#silence) {
      for (const piece of this.#fence.flush()) out.push(...this.#piece(piece.code, piece.text));
      out.push(...this.#line(this.#buffer));
    }
    this.#buffer = "";
    out.push(...this.#screen.flush());
    return out;
  }

  #take(segments: readonly Segment[]): ScreenedLine[] {
    const out: ScreenedLine[] = [];
    for (const segment of segments) {
      if (this.#silence) break;
      switch (segment.type) {
        case "text":
          if (segment.text.trim() !== "") this.#seenText = true;
          for (const piece of this.#fence.push(segment.text)) {
            out.push(...this.#piece(piece.code, piece.text));
          }
          break;
        case "emotion":
          this.#emotion = segment.emotion;
          break;
        case "silence":
          if (!this.#seenText) this.#silence = true;
          break;
        case "tool":
          this.tagsStripped += 1;
          break;
        default:
          break;
      }
    }
    return out;
  }

  #piece(code: boolean, text: string): ScreenedLine[] {
    if (code) {
      const out = this.#line(this.#buffer);
      this.#buffer = "";
      return text.trim() === "" ? out : [...out, ...this.#line(`\`\`\`${text}\`\`\``)];
    }
    const lines = (this.#buffer + text).split("\n");
    this.#buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.#line(line));
  }

  #line(raw: string): ScreenedLine[] {
    const text = raw.trim();
    if (text === "") return [];
    return this.#screen.push({ text, emotion: this.#emotion }).send;
  }
}
