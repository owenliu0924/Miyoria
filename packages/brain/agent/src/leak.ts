// A reply that is her reasoning, not her words. A model with thinking switched off can still
// think out loud in the visible answer: planning the tone, the length, the emotion tag, drafting
// the reply ("可以說：「…」"), re-checking a calculation. Streamed line by line, each of those
// lines would reach the chat as a message (2026-11-09: 23 messages in one turn).
//
// This is the net at the send boundary, not the fix of the cause (the model and its thinking
// switch, docs/design/backlog.md): lines that talk about the reply itself are recognised, and
// once a response has done so, the rest of it is dropped.
//
// Dropping a response is costly (she says nothing, or the fixed line of someone left waiting
// goes out), so one line is condemned only on evidence that never shows up in her ordinary
// talk: the prompt's vocabulary for planning a reply, its tags with their attributes, a span of
// her prompt verbatim (`PromptEcho`). Everyday words that a plan also uses (「人設是」「分析:」
// 「我要回答」) count only as a hint, and only two hints in a row condemn a response. A line that
// speaks to someone (`你`) is not a plan of the reply. Inline code is never judged (``` blocks
// never reach the screen as words: `ReplyScreen.push` with `code`).

/** The score of a line that alone condemns the response. */
const LEAK = 2;

const EMOTIONS = "neutral|happy|smug|annoyed|angry|embarrassed|sad|surprised|thinking";

/** Lines that plan the reply or recite the prompt: one of these is enough. */
const STRONG: readonly RegExp[] = [
  /情緒標記|情緒標籤|表情標記/,
  // A draft of the reply opens the line; 「你可以說:「…」」 is advice to someone.
  /^(?:那|所以|或者|或是)?(?:可以|我可以|大概|不如|先)(?:說|回|這樣說|這樣回)[:：]\s*[「『"]/,
  new RegExp(`(?:用|選|標)\\s*(?:${EMOTIONS})\\s*(?:吧|比較|好了|就好)`, "i"),
  /<\/?(?:think|thinking|reasoning)>/i,
  // Tags only her prompt has: with the attributes the prompt gives them, or names no chat uses.
  /<\s*\/?\s*(?:reply_to|style_note)(?=[\s/>]|$)/i,
  /<\s*(?:data|examples?|person|turn|chat|reply|now)\s+[a-z_]+\s*=\s*["']/i,
  /⟦\/?資料|(?:source|title)="[^"]*"\s*\/?>|這回合想用顏文字的話/,
  /^(?:要回的訊息|style_note|reply_to)[:：]/i,
  /(?:現在)?(?:情緒|語氣)方面[:：]/,
];

/** Plans of the reply that read as advice when said to someone: strong unless they speak to them. */
const STRONG_UNLESS_ADDRESSED: readonly RegExp[] = [
  /回覆要(?:短|簡短|精簡)|回覆控制在|一兩句到三句|兩三句就好/,
  /(?:語氣|口吻|表現|反應)要(?:傲嬌|別扭|短|收|帶)/,
];

/**
 * The character's setting (「人設是」「官方設定說」) is an ordinary topic; next to how the reply
 * should come out (its tone, an emotion tag's name) it is her prompt being consulted.
 */
const SETTING = /設定說|人設(?:是|說|上)|角色設定/;
const SETTING_PLAN = new RegExp(`語氣|口吻|回覆|表現(?:是|要|成)|\\b(?:${EMOTIONS})\\b|<emo`, "i");

/**
 * Lines that think aloud or label a step of reasoning: a hint. Two in a row are a leak; one is
 * her words (「等一下」「分析:」「我應該先說聲抱歉」 all are, often). Never when it speaks to someone.
 */
const WEAK: readonly RegExp[] = [
  /^(?:等一下|等等|不對|慢著|啊不對|嗯，讓我|讓我(?:想|算|確認|看看))/,
  /我(?:得|要|再|先)(?:驗算|確認|檢查|算一下|重算)/,
  /(?:驗算|驗證)[:：]/,
  /^(?:所以|那麼|因此).{0,20}(?:對的|正確|沒錯)[。.]?$/,
  /^參考資料[:：]/,
];

/**
 * A step of reasoning labelled (「分析:」「思考:」) or a plan of what to say first is her words when
 * someone asked for an analysis (「分析:A 便宜但要等」, 「我應該先說結論」). It is a hint only when it
 * speaks of the person she answers in the third person: 「分析:使用者在問座標」, 「我應該先回答他」.
 */
const PLAN_STEP: readonly RegExp[] = [
  /^(?:思考|推理|分析|草稿|Reasoning|Thinking)[:：]/i,
  /我(?:該|應該|要)先?(?:驗收|回覆|回答|接著說|說)/,
];
const ABOUT_THE_REPLY = /使用者|用戶|\buser\b|[他她](?!們)/i;

/**
 * A tag of the prompt's structure on its own, no attributes (`<now>`, `</data>`, `<chat>`). In a
 * sentence it is a word like any other (「HTML 沒有 <example> 這個標籤」).
 */
const BARE_TAGS = /<\s*\/?\s*(?:data|turn|now|examples?|chat|reply|person)\s*\/?\s*>/gi;
/** A line in a pair of them (not her reply's): `<chat>星野: 請你吃白飯</chat>`. */
const WRAPPED = /^<\s*(data|turn|now|examples?|chat|person)\s*>.*<\s*\/\s*\1\s*>$/i;
/** Her reply wrapped the way the prompt's examples wrap theirs: the words are hers. */
const REPLY_OPEN = /^<\s*reply\s*>\s*/i;
const REPLY_CLOSE = /\s*<\s*\/\s*reply\s*>$/i;

/** Inline code: never judged. */
const INLINE_CODE = /(`+)[^`\n]*?\1/g;
/** What is quoted is not what she says to herself. */
const QUOTED = /「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"/g;
const ADDRESSES = /你|妳|您|大家/;

/** The verdict on one line. */
export interface LineVerdict {
  /** 0 her words, 1 a hint (two in a row are a leak), 2 a leak. */
  score: number;
  /**
   * What may go out of the line: `null` when the line is left out on its own (a prompt tag on
   * its own line), whatever the rest of the response is.
   */
  text: string | null;
}

/**
 * Spans of her prompt's rules, to recognise them recited. Any run of `SPAN` characters
 * (whitespace left out) a line shares with them is a recital: her words never repeat that much
 * of an instruction by chance. Quoted text (「名字: 內容」, sample lines) is left out: she may well
 * say it. Give it instructions only, not the persona she may quote introducing herself.
 */
export class PromptEcho {
  static readonly SPAN = 24;
  readonly #spans = new Set<string>();

  constructor(prompt: string) {
    const flat = squeeze(prompt.replace(QUOTED, "\n"));
    for (let i = 0; i + PromptEcho.SPAN <= flat.length; i++) {
      this.#spans.add(flat.slice(i, i + PromptEcho.SPAN));
    }
  }

  /** Whether `line` repeats a span of the prompt. */
  has(line: string): boolean {
    const flat = squeeze(line);
    for (let i = 0; i + PromptEcho.SPAN <= flat.length; i++) {
      if (this.#spans.has(flat.slice(i, i + PromptEcho.SPAN))) return true;
    }
    return false;
  }
}

function squeeze(text: string): string {
  return text.replace(/\s+/g, "");
}

const echoes = new Map<string, PromptEcho>();
/** Prompts whose echo is kept: one per profile that speaks, and some room. */
const MAX_ECHOES = 4;

/** The `PromptEcho` of `prompt`, kept: the runs of a profile share theirs. */
export function promptEcho(prompt: string): PromptEcho {
  const kept = echoes.get(prompt);
  if (kept !== undefined) return kept;
  if (echoes.size >= MAX_ECHOES) echoes.clear();
  const echo = new PromptEcho(prompt);
  echoes.set(prompt, echo);
  return echo;
}

/** Whether `text` (quotes left out) speaks to someone. */
function addresses(text: string): boolean {
  return ADDRESSES.test(text.replace(QUOTED, ""));
}

/** Judges one line of a reply on its own (see the top of the file). */
export function judgeLine(line: string, echo: PromptEcho | null = null): LineVerdict {
  const raw = line.trim();
  const text = raw.replace(INLINE_CODE, " ").trim();
  if (text === "") return { score: 0, text: raw };
  if (STRONG.some((r) => r.test(text))) return { score: LEAK, text: raw };
  const toSomeone = addresses(text);
  if (!toSomeone && STRONG_UNLESS_ADDRESSED.some((r) => r.test(text))) {
    return { score: LEAK, text: raw };
  }
  if (SETTING.test(text) && SETTING_PLAN.test(text)) return { score: LEAK, text: raw };
  if (echo?.has(text)) return { score: LEAK, text: raw };
  // The prompt's structure echoed (its tags alone, a line of an example's chat in its tags):
  // the line goes, the rest of the response may be hers.
  if (text.replace(BARE_TAGS, "").trim() === "" || WRAPPED.test(text)) {
    return { score: 1, text: null };
  }
  const words = raw.replace(REPLY_OPEN, "").replace(REPLY_CLOSE, "");
  if (!toSomeone && WEAK.some((r) => r.test(text))) return { score: 1, text: words };
  if (!toSomeone && PLAN_STEP.some((r) => r.test(text)) && ABOUT_THE_REPLY.test(text)) {
    return { score: 1, text: words };
  }
  return { score: 0, text: words };
}

/** 0 for her words, 1 for a hint of reasoning, 2 for a line that plans the reply. */
export function reasoningScore(line: string, echo: PromptEcho | null = null): number {
  return judgeLine(line, echo).score;
}

/** Whether one line alone is reasoning. */
export function looksLikeReasoning(line: string, echo: PromptEcho | null = null): boolean {
  return reasoningScore(line, echo) >= LEAK;
}

/**
 * Lines she writes to herself about the person she answers, in the third person, with an
 * instruction to herself (2026-11-08: 「莎露朵在問我上面訊息寫什麼,直接念給她聽就好。」). Only
 * that line is dropped: the reply around it is hers. A line that speaks to someone (`你`) is never
 * one of these.
 */
const SELF_TALK: readonly RegExp[] = [
  /(?:在問我|是在問|想問我|要我|叫我|請我).{0,40}(?:就好|就行|就可以了?|就對了|即可)[。.!！]?$/,
  /^(?:那|那就|所以)?我?(?:直接|先|就)(?:回|回覆|念|唸|告訴|貼|說給|講給|念給|唸給)(?:他|她).{0,20}(?:就好|就行|就可以了?|即可|吧)[。.!！]?$/,
];

/** Whether `line` is a note to herself about how to answer (see `SELF_TALK`). */
export function isSelfTalk(line: string): boolean {
  const text = line.trim();
  if (text === "" || text.includes("你")) return false;
  return SELF_TALK.some((r) => r.test(text));
}

/**
 * Judges the lines of one reply in order. A line that plans the reply, or two hints in a row,
 * make the response a leak: that line and every later one are dropped.
 */
export class ReasoningGuard {
  readonly #echo: PromptEcho | null;
  /** The last line judged was a hint. */
  #hinted = false;
  #leaking = false;

  constructor(echo: PromptEcho | null = null) {
    this.#echo = echo;
  }

  get leaking(): boolean {
    return this.#leaking;
  }

  /** Something of hers that is not judged came between (a ``` block): hints are no longer in a row. */
  interrupt(): void {
    this.#hinted = false;
  }

  /** `true` when `line` must not be sent. */
  drops(line: string): boolean {
    return this.judge(line).text === null;
  }

  /** The verdict on the next line: `text` `null` when it must not be sent. */
  judge(line: string): LineVerdict {
    if (this.#leaking) return { score: LEAK, text: null };
    const verdict = judgeLine(line, this.#echo);
    if (verdict.score >= LEAK || (verdict.score > 0 && this.#hinted)) this.#leaking = true;
    this.#hinted = verdict.score > 0;
    return this.#leaking ? { score: LEAK, text: null } : verdict;
  }
}

/**
 * Lines on their way to the chat: the first one waits for the second (or the end of the reply),
 * so a leak that starts with an innocent line takes that line with it.
 *
 * Off (`[modules.agent.corrections] leak_screen = false`) every line goes out as it comes: no
 * first line waits and nothing is dropped. A note to herself (`isSelfTalk`) is a correction of
 * its own (`self_talk`): it is left out, line by line, whether the leak screen is on or not.
 */
export class ReplyScreen<T extends { text: string }> {
  readonly #guard: ReasoningGuard;
  readonly #on: boolean;
  readonly #selfTalk: boolean;
  #first: T | null = null;
  #started = false;
  /** Set once the response was judged a leak. */
  dropped = false;
  /** Lines this screen dropped (the held first line it took back included). */
  droppedLines = 0;
  /** Notes to herself left out of the reply (`isSelfTalk`). */
  selfTalk = 0;

  constructor(on = true, selfTalk = true, echo: PromptEcho | null = null) {
    this.#on = on;
    this.#selfTalk = selfTalk;
    this.#guard = new ReasoningGuard(echo);
  }

  /**
   * What may be sent now; `retracted` is set when it took the held first line back. A ``` block
   * (`code`) is never judged: it goes out in its place, unless the response was already a leak.
   */
  push(item: T, code = false): { send: T[]; retracted: boolean } {
    if (code) {
      if (!this.#on) return { send: [item], retracted: false };
      if (this.dropped) {
        this.droppedLines += 1;
        return { send: [], retracted: false };
      }
      this.#guard.interrupt();
      return this.#release(item);
    }
    if (this.#selfTalk && !this.dropped && isSelfTalk(item.text)) {
      this.selfTalk += 1;
      return { send: [], retracted: false };
    }
    if (!this.#on) return { send: [item], retracted: false };
    const verdict = this.#guard.judge(item.text);
    if (this.#guard.leaking) {
      const retracted = this.#first !== null;
      this.#first = null;
      this.dropped = true;
      this.droppedLines += retracted ? 2 : 1;
      return { send: [], retracted };
    }
    if (verdict.text === null) {
      this.droppedLines += 1;
      return { send: [], retracted: false };
    }
    return this.#release(verdict.text === item.text ? item : { ...item, text: verdict.text });
  }

  #release(item: T): { send: T[]; retracted: boolean } {
    if (!this.#started) {
      this.#started = true;
      this.#first = item;
      return { send: [], retracted: false };
    }
    const held = this.#first;
    this.#first = null;
    return { send: held === null ? [item] : [held, item], retracted: false };
  }

  /** The reply ended: a first line still waiting goes out. */
  flush(): T[] {
    const held = this.#first;
    this.#first = null;
    return held === null ? [] : [held];
  }
}
