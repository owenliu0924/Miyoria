// Prompt pieces (the compiler in compiler.ts puts them together), ordered for provider prefix
// caching: the fixed system part (persona core, speaking style, rules, output format) first,
// then the conversation history (which only grows at the end), then the per-turn data and her
// own state.
//
// Authority (docs/design/v2-architecture.md §3.5): system messages carry only what is hers or
// the system's: persona, rules, time and place, and her own state (mood, what she is doing, her
// policy, goals, limits, notices; `# 你自己的狀態`), which she follows. Everything derived from
// other people (who is present and how she sees them, recalled memories, the game summary,
// initiative hints that may quote game chat, every contributor section, the example dialogues)
// goes into user-role data messages, each part in a `<data source="…" title="…"> … </data>` block with
// the delimiters escaped inside (`dataBlock`); only those blocks are untrusted.
// Display names and message text in the history are neutralized (`safeName`, `neutralize`),
// and so are the transcript's markers: quoted reply parents, `(回覆 X)` tags, stickers / embeds
// / attachments noted inline and image labels.

import {
  assistantMessage,
  type ChatMessage,
  type ChatRole,
  type ContentPart,
  systemMessage,
  userMessage,
} from "@miyoria/llm/llm";
import {
  type AccountRef,
  CHAT_DM,
  CHAT_START,
  type ContextKey,
  neutralize,
  safeName,
  sameAccount,
} from "@miyoria/types";
import { toTraditional } from "./script.js";
import type { HistoryEntry } from "./session.js";
import { charCount, utf8Len } from "./util.js";

/**
 * The voice rule when she is heard in another language than she writes (`VoiceSink.speaksIn`):
 * each sentence carries its spoken line, written first so it can go to TTS right away.
 */
export function speaksRule(language: string): string {
  const name = languageName(language);
  return [
    `- 你的聲音是用${name}念出來的,字幕和紀錄顯示你寫的中文。`,
    `每一句先寫 <voice>…</voice>,裡面是這句要念的${name},寫完馬上接同一句的中文,意思一樣。`,
    `中文那句一定要寫(不要只寫 <voice>),<voice> 裡只放念得出來的${name},`,
    `遊戲用語和專有名詞也寫成${name}的說法;<emo:…> 寫在 <voice> 前面。例如:${spokenExample(language)}`,
  ].join("");
}

/** `Japanese` (the setting) as the prompt says it: a Chinese sentence with no English word in it. */
export function languageName(language: string): string {
  const known: readonly [RegExp, string][] = [
    [/japanese|日/i, "日文"],
    [/english|英/i, "英文"],
    [/korean|韓/i, "韓文"],
    [/cantonese|粵/i, "粵語"],
  ];
  return known.find(([re]) => re.test(language))?.[1] ?? language;
}

/**
 * Lines in the spoken format, for `language`; `short`: only the first, a bare exclamation that
 * fits any moment (the tail's: 「じゃあ一緒に行こう!」 there was a sentence she could say back to
 * a question it does not answer).
 */
function spokenExample(language: string, short = false): string {
  if (!/japanese|日/i.test(language)) {
    return `<voice>(這句的${languageName(language)})</voice>欸,真的嗎?`;
  }
  const first = "<voice>えっ、本当に?</voice>欸,真的嗎?";
  return short ? first : `${first}<voice>じゃあ一緒に行こう!</voice>那一起去吧!`;
}

/**
 * `speaksRule` once more at the end of the prompt: it sits far above the history, where her
 * own lines show only their subtitles, and half her replies went without `<voice>`. With the
 * example again: the example dialogues before the history are plain text, and a format shown is
 * followed better than one only named.
 */
export function speaksReminder(language: string): string {
  return `- 這回合是用說的:每一句都先寫 <voice>…</voice>(${languageName(language)}),再接同一句的中文,一句都不能漏。歷史訊息和範例對話只有中文,那個格式不要照抄,要像這樣:${spokenExample(language, true)}`;
}

/** Data block titles. */
export const PRESENT_TITLE = "在場的人";
export const FEELING_TITLE = "你現在這份心情的由來";
export const VOICE_PRESENT_TITLE = "語音頻道裡的人";
export const INITIATIVE_TITLE = "你想聊的事";
export const INTENT_TITLE = "你的打算";

/** Appended to her speech that was cut off. */
export const INTERRUPTED = "(被打斷)";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

/** What she decided to do (her own words, which may echo other people: data). */
export interface IntentData {
  capability: string;
  /** What the capability does, in words. */
  summary: string | null;
  /** The result of the action she already took; `null` when she only wants to talk. */
  done: string | null;
  why: string;
  opening: string | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** The two lines every prompt of hers has: the time and where she is. */
export function whenAndWhere(ctx: ContextKey, now: Date, utcOffsetMinutes: number): string {
  const local = new Date(now.getTime() + utcOffsetMinutes * 60_000);
  const weekday = WEEKDAYS[(local.getUTCDay() + 6) % 7];
  const time =
    `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())} ` +
    `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}(星期${weekday})`;
  const place =
    ctx.kind === "dm"
      ? "私訊"
      : ctx.kind === "voice"
        ? `語音頻道 ${ctx.channel}`
        : ctx.kind === "thread"
          ? `討論串 ${ctx.channel}`
          : `頻道 ${ctx.channel}`;
  return `- 時間:${time}\n- 地點:${ctx.platform} 的${place}`;
}

/** Her intent as the body of the `你的打算` data block. */
export function intentBody(intent: IntentData): string {
  const lines: string[] = [];
  if (intent.done !== null) {
    lines.push(`你已經做了:${intent.summary ?? intent.capability}(結果:${intent.done})`);
  } else if (intent.capability !== CHAT_START && intent.capability !== CHAT_DM) {
    lines.push(`你想做:${intent.summary ?? intent.capability}`);
  }
  if (intent.why.trim() !== "") lines.push(`為什麼:${intent.why.trim()}`);
  if (intent.opening !== null && intent.opening.trim() !== "") {
    lines.push(`你想怎麼開口:${intent.opening.trim()}`);
  }
  return lines.join("\n");
}

/** How the conversation history is shown (`[modules.agent.mainline]` `history_chars` and so on). */
export interface TranscriptOptions {
  /** Total characters of history lines; the oldest entries go first. `0`: no limit. */
  maxChars: number;
  /** One entry's text is cut to this many characters. `0`: no limit. */
  maxEntryChars: number;
  /** A gap longer than this between two entries gets a time-gap line. `0`: never. */
  gapMs: number;
  /**
   * Rendered blocks shown between the lines (the main line's tool traces, v4 §4.2), each right
   * after the entry it was kept after; one whose entry is not shown is left out. They are not
   * entries: attention never counts them as her lines.
   */
  traces?: readonly Trace[];
}

/**
 * The entry a trace follows: the last line there was when it was kept, by what never changes of
 * an entry (its time and author; its id comes later for her own lines, its text may be cut), and
 * which of the entries alike it was. Clock times cannot place it: a platform's message times and
 * the local clock disagree.
 */
export interface TraceAnchor {
  ts: number;
  author: string;
  self: boolean;
  /** 1 for the first entry with this time and author, 2 for the second, ... */
  nth: number;
}

/** A rendered block shown after one entry of the transcript. */
export interface Trace {
  after: TraceAnchor;
  text: string;
}

const anchorKey = (ts: number, author: string, self: boolean) => `${ts}|${self ? 1 : 0}|${author}`;

/** The anchor of the last of `history` (`null`: empty). */
export function traceAnchor(history: readonly HistoryEntry[]): TraceAnchor | null {
  const last = history.at(-1);
  if (last === undefined) return null;
  const key = anchorKey(last.ts, last.author, last.isSelf);
  const nth = history.filter((e) => anchorKey(e.ts, e.author, e.isSelf) === key).length;
  return { ts: last.ts, author: last.author, self: last.isSelf, nth };
}

export const DEFAULT_TRANSCRIPT: TranscriptOptions = {
  maxChars: 16_000,
  maxEntryChars: 2000,
  gapMs: 30 * 60 * 1000,
};

/** Longest quoted parent line (characters of its text). */
export const MAX_PARENT_CHARS = 300;

/** Name tag of a bot account in the transcript. */
export const BOT_TAG = "(bot)";
/** Name tag of a spoken line. */
export const SPOKEN_TAG = "(語音)";
/** Heading of the block that repeats the message(s) the turn answers (its focus). */
export const FOCUS_HEAD = "# 要回的訊息(前面的對話、筆記和記憶用來接住這句,不用另開話題)";
/** At most this many focus messages are repeated (the newest). */
const MAX_FOCUS = 5;
/** Title of the data block that holds what the input defence flagged. */
export const FLAGGED_TITLE = "可疑的訊息";
/** What stands in the transcript for a flagged message: it is data, not a line of conversation. */
export const FLAGGED_LINE = `[內容在參考資料「${FLAGGED_TITLE}」]`;

/** What a transcript shows of `entry`. */
function shownText(entry: HistoryEntry): string {
  return entry.flagged == null ? entry.text : FLAGGED_LINE;
}

/** The messages the input defence flagged, each with what it noticed. */
export function flaggedBody(history: readonly HistoryEntry[]): string {
  return history
    .filter((e) => e.flagged != null)
    .map((e) => `${safeName(e.author)}:${neutralize(e.text)}\n${e.flagged}`)
    .join("\n");
}

/**
 * The turn's focus messages (history entries marked `current`), repeated as the last user
 * block and naming who asked (`Owen 問你:…`, `Owen 接著說:…`; `null` when none). Names are
 * made inert and the text neutralized like the transcript.
 */
export function focusMessage(history: readonly HistoryEntry[]): string | null {
  const focus = focusLines(history);
  if (focus === null) return null;
  const pick = focus.rule === null ? "" : `\n${focus.rule}`;
  return `${FOCUS_HEAD}\n${focus.lines.join("\n")}${pick}`;
}

/**
 * The focus messages as lines (`Owen 問你:…`, numbered `[1] …` when several people speak) and the
 * rule on how to answer several (`null`: one message); `null` when there is no focus.
 */
export function focusLines(
  history: readonly HistoryEntry[],
): { lines: string[]; rule: string | null } | null {
  const current = focusEntries(history);
  if (current.length === 0) return null;
  const byId = new Map<string, HistoryEntry>();
  for (const e of history) if (e.id !== null) byId.set(e.id, e);
  // Several people at once: the lines are numbered so she can say which one each reply answers.
  const numbered = severalPeople(current);
  const lines = current.map((e, i) => {
    const verb = e.focusVerb ?? "說";
    const text = cut(neutralize(shownText(e)), DEFAULT_TRANSCRIPT.maxEntryChars);
    const n = numbered ? `[${i + 1}] ` : "";
    return `${n}${safeName(e.author)}${e.spoken ? SPOKEN_TAG : ""}${replyTagOf(e, byId, true)} ${verb}:${text}`;
  });
  const rule = numbered ? REPLY_PICK_RULE : current.length > 1 ? ONE_THOUGHT_RULE : null;
  return { lines, rule };
}

/** The turn's focus entries, in the order (and numbering) of the focus block. */
export function focusEntries(history: readonly HistoryEntry[]): HistoryEntry[] {
  return history.filter((e) => e.current === true && !e.isSelf).slice(-MAX_FOCUS);
}

/** More than one person among `entries`. */
export function severalPeople(entries: readonly { account: AccountRef }[]): boolean {
  const first = entries[0]?.account;
  return first !== undefined && entries.some((e) => !sameAccount(e.account, first));
}

/** Several messages at once are not a list to work through. */
export const PICK_SOME_RULE =
  "以上是最近的多則訊息,不需要每則都回,挑你最想回的一兩件就好,其他可以不理。";

/** One person's messages in a row are usually one thought split over several lines. */
export const ONE_THOUGHT_RULE = "這幾則是同一個人連續說的,當成一件事整體回覆。";

/** How she says which numbered message a reply answers. */
export const REPLY_PICK_RULE = `${PICK_SOME_RULE}好幾個人同時說話時一次回一個人,每段開頭寫 [回覆 編號]。`;

/** `text` cut before every line that starts with a `[回覆 N]` mark, so each part quotes its own. */
export function splitByReplyMarks(text: string): string[] {
  return text
    .split(/\n(?=\s*[[［]\s*回覆\s*\d{1,2}\s*[\]］])/)
    .filter((part) => part.trim() !== "");
}

/** `[回覆 2]` at the start of a reply: which focus message (1-based) it answers, and the rest. */
export function takeReplyMark(text: string): { n: number | null; text: string } {
  const m = /^\s*[[［]\s*回覆\s*(\d{1,2})\s*[\]］]\s*/.exec(text);
  if (m === null) return { n: null, text };
  return { n: Number(m[1]), text: text.slice(m[0].length) };
}
/** What a quoted parent line of hers is attributed to. */
export const SELF_QUOTE_NAME = "你";

/** Characters of the replied-to message quoted inside a reply tag. */
export const MAX_REPLY_EXCERPT = 24;

/**
 * `(回覆 X)` after a name: the message replies to X (`你` for her). With `excerpt`, a short
 * quote of the very message replied to (`(回覆 X「…」)`), so a reply to one of several lines
 * of X is not taken for another, or for whatever arrived at the same moment.
 */
export function replyTag(name: string, excerpt?: string): string {
  const quote =
    excerpt === undefined ? "" : cut(excerpt.replace(/\s+/g, " ").trim(), MAX_REPLY_EXCERPT);
  return quote === "" ? `(回覆 ${name})` : `(回覆 ${name}「${quote}」)`;
}

/**
 * The reply tag of `entry`: the history entry it replies to, else the fetched parent. The parent
 * is quoted when it sits among other lines (in the history) or `always` (the focus block); a
 * fetched parent in the transcript already has its own `> ` line just above.
 */
function replyTagOf(
  entry: HistoryEntry,
  byId: ReadonlyMap<string, HistoryEntry>,
  always = false,
): string {
  if (entry.replyTo == null) return "";
  const inHistory = byId.get(entry.replyTo);
  const parent = inHistory ?? entry.parents?.at(-1);
  if (parent === undefined) return "";
  const name = parent.isSelf ? SELF_QUOTE_NAME : safeName(parent.author);
  return inHistory !== undefined || always
    ? replyTag(name, neutralize(shownText(parent)))
    : replyTag(name);
}

/** Characters of a line around a quoted parent. */
const MAX_CONTEXT_CHARS = 120;

/** `剛剛`, `5 分鐘前`, `3 小時前`, `2 天前`: how long before the reply a quoted line was. */
export function agoLabel(ms: number): string {
  const minutes = Math.round(Math.max(ms, 0) / 60_000);
  if (minutes < 1) return "剛剛";
  if (minutes < 60) return `${minutes} 分鐘前`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} 小時前`;
  return `${Math.round(minutes / (24 * 60))} 天前`;
}

/** `> (tag) name: text`: a quoted line outside the transcript. */
function quoteLine(e: HistoryEntry, tag: string, max: number): string {
  const name = e.isSelf ? SELF_QUOTE_NAME : safeName(e.author);
  const text = cut(neutralize(shownText(e)).replace(/\s+/g, " ").trim(), max);
  return `> (${tag}) ${name}: ${text}`;
}

/** Time-gap line between two entries further apart than `gapMs`. */
export function gapLine(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const span =
    minutes < 60
      ? `${minutes} 分鐘`
      : minutes < 48 * 60
        ? `${Math.round(minutes / 60)} 小時`
        : `${Math.round(minutes / (24 * 60))} 天`;
  return `—— 過了 ${span} ——`;
}

function cut(text: string, max: number): string {
  if (max <= 0) return text;
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** One transcript item: her line (`assistant`) or someone else's / a marker (`user`). */
interface Item {
  role: ChatRole;
  line: string;
}

/**
 * The transcript lines of `history` (oldest first), grouped per entry: a time-gap line, quoted
 * parents that are not in the history, then the entry itself. Every name goes through
 * `safeName` and every text through `neutralize`; nothing here is an instruction.
 */
function transcriptBlocks(history: readonly HistoryEntry[], options: TranscriptOptions): Item[][] {
  const byId = new Map<string, HistoryEntry>();
  for (const e of history) if (e.id !== null) byId.set(e.id, e);
  const blocks: Item[][] = [];
  // A trace sits right after the line that was last when it was kept: every line added later
  // comes after it, so the transcript up to it never changes once shown.
  const traces = (options.traces ?? []).filter((t) => t.text.trim() !== "");
  const seen = new Map<string, number>();
  let previous: HistoryEntry | null = null;
  for (const entry of history) {
    const block: Item[] = [];
    if (previous !== null && options.gapMs > 0 && entry.ts - previous.ts > options.gapMs) {
      block.push({ role: "user", line: gapLine(entry.ts - previous.ts) });
    }
    previous = entry;
    if (!entry.isSelf) {
      for (const [i, parent] of entry.parents.entries()) {
        const direct = i === entry.parents.length - 1;
        const around = direct ? parent.around : undefined;
        // Lines around the direct parent that the transcript does not already show.
        const extra = (lines: readonly HistoryEntry[] | undefined) =>
          (lines ?? []).filter((e) => e.id === null || (!byId.has(e.id) && e.id !== entry.id));
        for (const e of extra(around?.before)) {
          block.push({ role: "user", line: quoteLine(e, "前文", MAX_CONTEXT_CHARS) });
        }
        const when = parent.undated === true ? "較早" : agoLabel(entry.ts - parent.ts);
        const tag =
          around !== undefined && (around.before.length > 0 || around.after.length > 0)
            ? `${when},被回覆`
            : when;
        block.push({ role: "user", line: quoteLine(parent, tag, MAX_PARENT_CHARS) });
        for (const e of extra(around?.after)) {
          block.push({ role: "user", line: quoteLine(e, "後文", MAX_CONTEXT_CHARS) });
        }
      }
    }
    const line = entry.isSelf
      ? ownLine(entry, options.maxEntryChars)
      : otherLine(entry, options.maxEntryChars, replyTagOf(entry, byId));
    block.push({ role: entry.isSelf ? "assistant" : "user", line });
    blocks.push(block);
    if (traces.length > 0) {
      const key = anchorKey(entry.ts, entry.author, entry.isSelf);
      const nth = (seen.get(key) ?? 0) + 1;
      seen.set(key, nth);
      for (const t of traces) {
        const a = t.after;
        if (a.nth === nth && anchorKey(a.ts, a.author, a.self) === key) {
          blocks.push([{ role: "user", line: t.text }]);
        }
      }
    }
  }
  return blocks;
}

function blockChars(block: readonly Item[]): number {
  return block.reduce((n, item) => n + charCount(item.line) + 1, 0);
}

/**
 * The newest blocks that fit in `maxChars` (always at least the newest one); a time-gap line
 * at the very start is dropped (it would point at nothing).
 */
function fitBlocks(blocks: Item[][], maxChars: number): Item[] {
  let start = blocks.length;
  let used = 0;
  while (start > 0) {
    const size = blockChars(blocks[start - 1] as Item[]);
    if (maxChars > 0 && start < blocks.length && used + size > maxChars) break;
    used += size;
    start--;
  }
  const items = blocks.slice(start).flat();
  const first = items[0];
  if (first !== undefined && first.role === "user" && first.line.startsWith("—— ")) {
    items.shift();
  }
  return items;
}

/**
 * `[persona, examples?, history..., data?, situation]`. Her messages become `assistant`, everyone else's
 * `user` as `"{name}: {text}"`, with name tags `(bot)`, `(語音)` and `(回覆 X)`; quoted
 * parents (`> X: …`) and time-gap lines (`—— 過了 2 小時 ——`) are `user` lines too.
 * Consecutive lines of the same role are merged. The history is cut to `options.maxChars`
 * (oldest first) and each entry to `options.maxEntryChars`.
 *
 * `images` (the turn's images) are attached to the last `user` history message, which holds
 * the message she answers. `data` (see `situationData`) is a separate `user` message, never
 * part of a system message.
 */
export function buildMessages(
  persona: string,
  situation: string,
  history: Iterable<HistoryEntry>,
  data: string | null = null,
  options: Partial<TranscriptOptions> = {},
  images: readonly ContentPart[] = [],
  /** Fixed data (the example dialogues), right after the persona so it stays cacheable. */
  examples: string | null = null,
): ChatMessage[] {
  const opts = { ...DEFAULT_TRANSCRIPT, ...options };
  const items = fitBlocks(transcriptBlocks([...history], opts), opts.maxChars);
  const tail: { role: ChatRole; lines: string[] }[] = [];
  for (const item of items) {
    const last = tail.at(-1);
    if (last && last.role === item.role) last.lines.push(item.line);
    else tail.push({ role: item.role, lines: [item.line] });
  }
  const lastUser = tail.findLastIndex((m) => m.role === "user");
  const messages = tail.map((m, i) => {
    const text = m.lines.join("\n");
    if (m.role === "assistant") return assistantMessage(text);
    if (i !== lastUser || images.length === 0) return userMessage(text);
    return userMessage([{ type: "text", text }, ...images]);
  });
  const out = [systemMessage(persona)];
  if (examples !== null) out.push(userMessage(examples));
  out.push(...messages);
  // Last before the rules: the message(s) this turn answers, so the notes and memories in the
  // data block (often about an older topic) are not what she replies to.
  const focus = focusMessage([...history]);
  const extra = [data, focus].filter((t): t is string => t !== null);
  if (extra.length > 0) out.push(userMessage(extra.join("\n\n")));
  out.push(systemMessage(situation));
  return out;
}

/**
 * A history entry as one transcript line (`"{name}: {text}"`), for prompt contributors;
 * `name` is hers.
 */
export function transcriptLine(entry: HistoryEntry, name: string): string {
  const max = DEFAULT_TRANSCRIPT.maxEntryChars;
  return entry.isSelf ? `${name}: ${ownLine(entry, max)}` : otherLine(entry, max, "");
}

function ownLine(entry: HistoryEntry, maxChars: number): string {
  const text = cut(entry.text, maxChars);
  return entry.interrupted ? `${text}${INTERRUPTED}` : text;
}

/**
 * Someone else's line; the name is made inert and the text neutralized. `parent` is the entry
 * it replies to, if known (its author goes into the `(回覆 X)` tag).
 */
function otherLine(entry: HistoryEntry, maxChars: number, reply: string): string {
  let tags = "";
  if (entry.isBot) tags += BOT_TAG;
  if (entry.spoken) tags += SPOKEN_TAG;
  tags += reply;
  return `${safeName(entry.author)}${tags}: ${cut(neutralize(shownText(entry)), maxChars)}`;
}

function asciiEqualIgnoreCase(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x >= 65 && x <= 90) x += 32;
    if (y >= 65 && y <= 90) y += 32;
    if (x !== y) return false;
  }
  return true;
}

/**
 * Removes a leading `"{her name}:"` the model may copy from the history format, and writes what
 * she wrote in Simplified Chinese in Traditional (`script.ts`).
 */
export function cleanReply(text: string, names: readonly string[]): string {
  let t = text.trim();
  for (const name of names) {
    if (utf8Len(t) < utf8Len(name)) continue;
    const head = t.slice(0, name.length);
    if (!asciiEqualIgnoreCase(head, name)) continue;
    const rest = t.slice(name.length).trimStart();
    if (rest.startsWith(":")) {
      t = rest.slice(1).trimStart();
      break;
    }
  }
  return toTraditional(t.trim());
}

const CUT_SETS: readonly (readonly string[])[] = [
  ["\n"],
  ["。", "!", "?", "!", "?", ".", "…"],
  [" ", ","],
];

/**
 * Splits `text` into chunks of at most `maxChars` characters, preferring line breaks, then
 * sentence ends, then spaces.
 */
export function splitMessage(text: string, maxChars: number): string[] {
  const max = Math.max(maxChars, 1);
  const out: string[] = [];
  let rest = [...text.trim()];
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // Offsets are in UTF-8 bytes (`min` is half the window's bytes).
    const offsets: number[] = [];
    let bytes = 0;
    for (const c of window) {
      offsets.push(bytes);
      bytes += utf8Len(c);
    }
    const min = Math.floor(bytes / 2);
    let cut = window.length;
    outer: for (const set of CUT_SETS) {
      for (let i = window.length - 1; i >= 0; i--) {
        if (set.includes(window[i] as string) && (offsets[i] as number) >= min) {
          cut = i + 1;
          break outer;
        }
      }
    }
    const chunk = rest.slice(0, cut).join("").trim();
    if (chunk !== "") out.push(chunk);
    rest = [...rest.slice(cut).join("").trimStart()];
  }
  const last = rest.join("");
  if (last !== "") out.push(last);
  return out;
}
