// The request of one run, laid out for the provider's prefix cache (docs/design/v5-brain.md
// 「提示詞版面」):
//
//     [system]     1  persona core, then the runner's rules            fixed
//     (tools)      2  the always-on tools, then what the session loaded only grows at the end
//     [system]     3  the owner's rules, her own document              about once a day
//     [user]       4  this place and its regulars, as data             on compaction or a new face
//     [history]    5  the transcript: lines, her calls, results,       only grows
//                     reasoning (`toMessages`)
//     [user]       6  what was retrieved, her inbox, as data; the      every run
//                     files and images of the lines that woke her
//     [system]     7  <now>, <style_note> and what woke her            every run
//     ...             what the run itself adds: her steps, their results
//
// Everything that changes from run to run comes after the transcript, so the request of the next
// run starts with this one's up to the transcript's last entry. Within a run each step's request
// is the one before plus what that step added.

import {
  type ChatMessage,
  type ContentPart,
  systemMessage,
  type ToolSpec,
  userMessage,
} from "@miyoria/llm/llm";
import type { ToolEntry } from "@miyoria/llm/tools";
import { type TranscriptTail, toMessages } from "@miyoria/memory/transcript";
import { dataBlock } from "@miyoria/types";
import { slimTool } from "../../agent/src/index.js";
import type { ProfileName } from "./profiles.js";
import { RESULT_TITLE, rulesFor, WAKE_LINES } from "./rules.js";
import type { PromptInput, PromptSource, Wake } from "./types.js";

/** The text of each block around the transcript; `null`: the block is left out. */
export interface PromptBlocks {
  fixed: string | null;
  pinned: string | null;
  place: string | null;
  recalled: string | null;
  now: string | null;
  /** Block 7's `<style_note>` (`PromptSource.style`). */
  style?: string | null;
  /** Block 6's files and images (`PromptSource.attachments`); empty: none. */
  attached?: readonly ContentPart[];
}

type TextBlock = Exclude<keyof PromptBlocks, "attached" | "style">;

const blank = (text: string | null): string | null =>
  text === null || text.trim() === "" ? null : text.trim();

/** Asks `source` for every block at once. A block that fails is left out and reported. */
export async function gatherBlocks(
  source: PromptSource,
  input: PromptInput,
  onError: (block: keyof PromptBlocks, error: unknown) => void = () => undefined,
): Promise<PromptBlocks> {
  const ask = async (block: TextBlock): Promise<string | null> => {
    try {
      return blank(await source[block](input));
    } catch (error) {
      onError(block, error);
      return null;
    }
  };
  const attach = async (): Promise<ContentPart[]> => {
    try {
      return (await source.attachments?.(input)) ?? [];
    } catch (error) {
      onError("attached", error);
      return [];
    }
  };
  const styled = async (): Promise<string | null> => {
    try {
      return blank((await source.style?.(input)) ?? null);
    } catch (error) {
      onError("style", error);
      return null;
    }
  };
  const [fixed, pinned, place, recalled, now, style, attached] = await Promise.all([
    ask("fixed"),
    ask("pinned"),
    ask("place"),
    ask("recalled"),
    ask("now"),
    styled(),
    attach(),
  ]);
  return { fixed, pinned, place, recalled, now, style, attached };
}

/** Block 7's last part: what this run is. */
export function wakeLine(wake: Wake): string {
  switch (wake.kind) {
    case "addressed":
      return WAKE_LINES[wake.reason](wake.from.name);
    case "result":
      return WAKE_LINES.result(wake.tool, wake.job, wake.ok);
    case "timer":
      return WAKE_LINES.timer(wake.note);
    case "world":
      return WAKE_LINES.world(wake.what);
    case "glance":
      return WAKE_LINES.glance(wake.lines);
    case "self":
      return WAKE_LINES.self(wake.note);
  }
}

/** What a wake brings that is data: the result that came back. */
function wakeData(wake: Wake): string | null {
  if (wake.kind !== "result" || wake.text.trim() === "") return null;
  return dataBlock("result", RESULT_TITLE, wake.text);
}

/** The three parts of a run's first request; the run appends its steps after `tail`. */
export interface RunMessages {
  /** Blocks 1, 3, 4. */
  head: ChatMessage[];
  /** Block 5. */
  history: ChatMessage[];
  /** Blocks 6, 7. */
  tail: ChatMessage[];
}

export function runMessages(
  blocks: PromptBlocks,
  transcript: TranscriptTail,
  wake: Wake,
  profile: ProfileName,
): RunMessages {
  const rules = rulesFor(profile);
  const head: ChatMessage[] = [
    systemMessage(blocks.fixed === null ? rules : `${blocks.fixed}\n\n${rules}`),
  ];
  if (blocks.pinned !== null) head.push(systemMessage(blocks.pinned));
  if (blocks.place !== null) head.push(userMessage(blocks.place));

  const tail: ChatMessage[] = [];
  const data = [blocks.recalled, wakeData(wake)].filter((b): b is string => b !== null);
  const attached = blocks.attached ?? [];
  if (attached.length > 0) {
    // Files and images only here, after the transcript: the next run's prefix never has them.
    const text: ContentPart[] = data.length > 0 ? [{ type: "text", text: data.join("\n\n") }] : [];
    tail.push(userMessage([...text, ...attached]));
  } else if (data.length > 0) {
    tail.push(userMessage(data.join("\n\n")));
  }
  const now = blocks.now === null ? "" : `<now>\n${blocks.now}\n</now>\n`;
  const style = blocks.style ? `<style_note>\n${blocks.style}\n</style_note>\n` : "";
  tail.push(systemMessage(`${now}${style}<turn>${wakeLine(wake)}</turn>`));

  return { head, history: toMessages(transcript), tail };
}

/**
 * The tools as the model is offered them, in the order given: each spec once, without the
 * request rule every capability repeats (the rules say it once; `slimTool`).
 */
export function toolSpecs(offered: readonly ToolEntry[]): ToolSpec[] {
  return offered.map((entry) => slimTool(entry.tool.spec, { description: 0, argument: 0 }));
}

/** One line per message: equal lines are equal messages, so a shared prefix can be counted. */
export function serialiseMessages(messages: readonly ChatMessage[]): string[] {
  return messages.map((m) =>
    JSON.stringify({
      role: m.role,
      content: m.content,
      name: m.name,
      tool_calls: m.tool_calls,
      tool_call_id: m.tool_call_id,
      reasoning: m.reasoning ?? null,
    }),
  );
}

/** The same for a tool list. */
export function serialiseTools(tools: readonly ToolSpec[]): string[] {
  return tools.map((t) => JSON.stringify([t.name, t.description, t.parameters]));
}
