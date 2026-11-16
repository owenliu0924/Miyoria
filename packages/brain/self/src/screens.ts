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
//
// Spoken (`unit: "sentence"`, the voice profile), the text is cut into sentences as it streams
// (`SentenceSplitter`), so each can be said while the rest is written, and each sentence is judged
// on its own (#10, today's `Speech`): one that is reasoning or a note to herself is not said, the
// others are; nothing is held back waiting for the next. Links and ``` blocks are never read out:
// each comes as a line of its own (`asideLine`), for the outlet to put in writing.

import {
  ExpressionParser,
  FenceSplitter,
  isSelfTalk,
  isSpeakable,
  LinkSplitter,
  looksLikeReasoning,
  ReplyScreen,
  type Segment,
  SentenceSplitter,
} from "../../agent/src/index.js";

export interface ScreenedLine {
  text: string;
  /** The emotion she last marked before the line ended. */
  emotion: string | null;
}

/** What one line of her text is: a message (text), or a sentence that is said (voice). */
export type TextUnit = "line" | "sentence";

/** A line of spoken text that is not said: a link or a ``` block (`unit: "sentence"`). */
export function asideLine(text: string): boolean {
  const t = text.trim();
  return (t.startsWith("```") && t.endsWith("```")) || /^https?:\/\/\S+$/.test(t);
}

export class StepText {
  readonly #parser = new ExpressionParser();
  readonly #fence = new FenceSplitter();
  readonly #screen = new ReplyScreen<ScreenedLine>();
  readonly #sentences: boolean;
  readonly #splitter = new SentenceSplitter();
  readonly #links = new LinkSplitter();
  #buffer = "";
  #emotion: string | null = null;
  #seenText = false;
  #silence = false;
  /** Sentences left out, spoken (`unit: "sentence"`). */
  #leakSentences = 0;
  #selfTalkSentences = 0;
  /** Tools written as tags that were taken out of her text. */
  tagsStripped = 0;

  constructor(unit: TextUnit = "line") {
    this.#sentences = unit === "sentence";
  }

  /** `<silence/>` came before any text: she chose not to speak, and the rest is ignored. */
  get silence(): boolean {
    return this.#silence;
  }

  /** The response was judged a reasoning leak (#9), or one of its sentences was (#10). */
  get leaked(): boolean {
    return this.#sentences ? this.#leakSentences > 0 : this.#screen.dropped;
  }

  /** Lines (sentences, spoken) the leak screen dropped. */
  get leakDropped(): number {
    return this.#sentences ? this.#leakSentences : this.#screen.droppedLines;
  }

  /** Lines (sentences, spoken) left out as notes to herself (#19). */
  get selfTalkCut(): number {
    return this.#sentences ? this.#selfTalkSentences : this.#screen.selfTalk;
  }

  /** Whether she wrote any text that is not markup. */
  get wroteText(): boolean {
    return this.#seenText;
  }

  /** A piece of the step's text; returns the lines that may go out now. */
  push(delta: string): ScreenedLine[] {
    return this.#take(this.#parser.push(delta));
  }

  /**
   * What she wrote so far is complete (her tool calls begin): a finished sentence still held for
   * the end marks that might follow goes out now (spoken; a line waits for its line break).
   */
  settle(): ScreenedLine[] {
    if (!this.#sentences || this.#silence) return [];
    const done = this.#splitter.flushComplete();
    return done === null ? [] : this.#sentence(done);
  }

  /** The step's text ended: what was still held. */
  finish(): ScreenedLine[] {
    const out = this.#take(this.#parser.finish());
    if (!this.#silence) {
      for (const piece of this.#fence.flush()) out.push(...this.#piece(piece.code, piece.text));
      if (this.#sentences) {
        for (const part of this.#links.flush()) out.push(...this.#spoken(part.code, part.text));
        const rest = this.#splitter.flush();
        if (rest !== null) out.push(...this.#sentence(rest));
      } else {
        out.push(...this.#line(this.#buffer));
      }
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
          // Spoken, a finished sentence still held is said with the emotion it was written under.
          if (this.#sentences) {
            const done = this.#splitter.flushComplete();
            if (done !== null) out.push(...this.#sentence(done));
          }
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
    if (this.#sentences) {
      if (code) return text.trim() === "" ? [] : this.#aside(`\`\`\`${text}\`\`\``);
      return this.#links.push(text).flatMap((part) => this.#spoken(part.code, part.text));
    }
    if (code) {
      const out = this.#line(this.#buffer);
      this.#buffer = "";
      return text.trim() === "" ? out : [...out, ...this.#line(`\`\`\`${text}\`\`\``)];
    }
    const lines = (this.#buffer + text).split("\n");
    this.#buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.#line(line));
  }

  /** Spoken text outside code blocks: a link aside, the rest cut into sentences. */
  #spoken(link: boolean, text: string): ScreenedLine[] {
    if (link) return this.#aside(text);
    return this.#splitter.push(text).flatMap((s) => this.#sentence(s));
  }

  /** A link or a code block on its own, after the words written before it. */
  #aside(text: string): ScreenedLine[] {
    const t = text.trim();
    if (t === "") return [];
    const before = this.#splitter.flush();
    return [...(before === null ? [] : this.#sentence(before)), { text: t, emotion: this.#emotion }];
  }

  /** One spoken sentence, judged alone: reasoning (#10) and notes to herself (#19) are not said. */
  #sentence(raw: string): ScreenedLine[] {
    const text = raw.trim();
    if (!isSpeakable(text)) return [];
    if (isSelfTalk(text)) {
      this.#selfTalkSentences += 1;
      return [];
    }
    if (looksLikeReasoning(text)) {
      this.#leakSentences += 1;
      return [];
    }
    return [{ text, emotion: this.#emotion }];
  }

  #line(raw: string): ScreenedLine[] {
    const text = raw.trim();
    if (text === "") return [];
    return this.#screen.push({ text, emotion: this.#emotion }).send;
  }
}
