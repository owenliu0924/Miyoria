// Host-side stand-ins that forward tool calls, command invocations and prompt requests to an
// extension process.

import type { CommandReply, CommandSpec, Invocation } from "@miyoria/commands";
import { ExtCommandReplySchema, ExtPromptContributeResultSchema } from "@miyoria/contracts/ext";
import type { ExecContext } from "@miyoria/gate/actions";
import type { Tool, ToolContext, ToolMeta, ToolSpec } from "@miyoria/llm/tools";
import type {
  AccountRef,
  ContextKey,
  JsonValue,
  MessageRef,
  Principal,
  Priority,
  PromptContributor,
  PromptRequest,
  PromptSection,
} from "@miyoria/types";
import { isJsonObject } from "@miyoria/types";
import { z } from "zod";
import { type Peer, RpcError } from "./rpc.js";

/** Thrown when an extension call fails; the message goes back to the model / user. */
export class ExtensionCallError extends Error {
  override readonly name = "ExtensionCallError";
}

function rethrow(error: unknown): never {
  if (error instanceof RpcError) throw new ExtensionCallError(error.message, { cause: error });
  throw error;
}

/** The `context` object of `tools.call`. */
export function toolContextJson(ctx: ToolContext): JsonValue {
  return {
    turn: ctx.turn,
    context: ctx.context as unknown as JsonValue,
    account: ctx.account as unknown as JsonValue,
    message: ctx.message as unknown as JsonValue,
    priority: ctx.priority,
  };
}

/** Where a call that came from nowhere in particular says it happened: the panel, never a platform. */
const NOWHERE: ContextKey = { platform: "panel", scope: null, channel: "", kind: "dm" };

function priorityOf(p: Principal): Priority {
  switch (p.kind) {
    case "user":
    case "command":
      return "direct";
    case "self":
      return p.requester === null ? "initiative" : "request";
    case "panel":
      return "system";
    case "director":
      return "initiative";
  }
}

/**
 * The `context` object of `tools.call` for a call that came through the gate: who asked (the
 * requester; nobody asking reads as `self`), where, and in answer to which message.
 */
export function execContextJson(ctx: ExecContext): JsonValue {
  const p = ctx.principal;
  const request = ctx.request;
  const context = p.context ?? request.message?.context ?? NOWHERE;
  const account: AccountRef = p.requester ?? { platform: context.platform, id: "self" };
  const message: MessageRef = request.message ?? { context, id: request.turn ?? "" };
  return {
    turn: request.turn ?? "",
    context: context as unknown as JsonValue,
    account: account as unknown as JsonValue,
    message: message as unknown as JsonValue,
    priority: priorityOf(p),
  };
}

/** Text the model sees for a `tools.call` result. */
export function toolResultText(result: JsonValue): string {
  if (typeof result === "string") return result;
  if (isJsonObject(result)) {
    if (!Object.hasOwn(result, "content")) return JSON.stringify(result);
    const content = result.content;
    return typeof content === "string" ? content : JSON.stringify(content);
  }
  return JSON.stringify(result);
}

export class ProxyTool implements Tool {
  /** An extension is a program of its own: what its tool does is not known here. */
  readonly meta: ToolMeta = {
    effect: "external",
    speed: "instant",
    risk: "medium",
    group: "extension",
  };

  constructor(
    readonly peer: Peer,
    /** Name the extension registered (may contain dots). */
    readonly wireName: string,
    /** Spec with the registry name. */
    readonly spec: ToolSpec,
    readonly permission: string | null,
    readonly timeoutMs: number,
    /** The extension declared it only looks (`read_only`). */
    readonly readOnly: boolean = false,
  ) {}

  async call(ctx: ToolContext, args: JsonValue): Promise<string> {
    let result: JsonValue;
    try {
      result = await this.peer.request(
        "tools.call",
        { name: this.wireName, args, context: toolContextJson(ctx) },
        this.timeoutMs,
        ctx.signal,
      );
    } catch (error) {
      rethrow(error);
    }
    return toolResultText(result);
  }
}

/** Forwards one command to `commands.invoke`. */
export async function invokeCommand(
  peer: Peer,
  spec: CommandSpec,
  invocation: Invocation,
  timeoutMs: number,
): Promise<CommandReply> {
  let result: JsonValue;
  try {
    result = await peer.request(
      "commands.invoke",
      JSON.parse(JSON.stringify(invocation)) as JsonValue,
      timeoutMs,
    );
  } catch (error) {
    rethrow(error);
  }
  if (typeof result === "string") return { text: result, ephemeral: spec.ephemeral };
  const parsed = ExtCommandReplySchema.safeParse(result);
  if (!parsed.success) {
    throw new ExtensionCallError(
      `bad \`commands.invoke\` result: ${z.prettifyError(parsed.error)}`,
    );
  }
  return { text: parsed.data.text, ephemeral: parsed.data.ephemeral ?? spec.ephemeral };
}

export class ProxyPrompt implements PromptContributor {
  constructor(
    readonly peer: Peer,
    /** Registered key, `ext.<id>.<key>`. */
    readonly key: string,
    /** Key the extension knows. */
    readonly wireKey: string,
    readonly timeoutMs: number,
  ) {}

  async contribute(request: PromptRequest, signal?: AbortSignal): Promise<PromptSection[]> {
    let value: JsonValue;
    try {
      value = await this.peer.request(
        "prompt.contribute",
        { key: this.wireKey, request: request as unknown as JsonValue },
        this.timeoutMs,
        signal,
      );
    } catch (error) {
      rethrow(error);
    }
    const parsed = ExtPromptContributeResultSchema.safeParse(value);
    if (!parsed.success) {
      throw new ExtensionCallError(
        `bad \`prompt.contribute\` result: ${z.prettifyError(parsed.error)}`,
      );
    }
    return parsed.data.sections;
  }
}
