// Tools that come from outside her own code (an extension's, an MCP server's, a declarative HTTP
// tool's) as capabilities, so they pass the same gate as everything else she does: the risk the
// tool declared (or the owner set), rate limits, the audit record, `on_own`, the review for high
// risk, and the bond rule for their `tools.*` node (`isWorkNode`).
//
// What such a tool answers was written by another program: it reaches her inside a data block
// (`dataBlock`), never as her own words. Only a spec whose own code writes the whole answer (the
// HTTP tools) may say its text is already framed.

import { errorMessage } from "@miyoria/runtime/kernel";
import {
  dataBlock,
  escapeData,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "@miyoria/types";
import { z } from "zod";
import {
  type ActionResult,
  type Capability,
  CapabilityError,
  defineCapability,
  type ExecContext,
  type Risk,
} from "./capability.js";
import type { Limit } from "./config.js";

/** Where an external tool comes from; also its `find_tools` group. */
export type ExternalToolGroup = "extension" | "mcp" | "http";

/** What `ExternalToolSpec.call` answers. */
export interface ExternalToolAnswer {
  text: string;
  data?: JsonValue;
  /**
   * The text already holds what came from outside in data blocks. Only for a caller whose own
   * code wrote the whole text; a plugin's or a server's word for it is never taken.
   */
  framed?: boolean;
}

export interface ExternalToolSpec {
  /** `ext.<id>.<wire>`, `mcp.<server>.<tool>`, `http.<name>`. */
  capability: string;
  /** The tool's name in the registry (old names keep working). */
  tool: string;
  /** One line for the audit, the review and the status (Traditional Chinese where possible). */
  summary: string;
  /** What the model reads. */
  description: string;
  /** JSON Schema object of the arguments (the gate adds `why` and `on_own`). */
  parameters: JsonObject;
  risk: Risk;
  /** The node the person asking needs; a `tools.ext.` / `tools.mcp.` / `tools.http.` one is a work node. */
  permission: string | null;
  group: ExternalToolGroup;
  /** Low risk only: it only looks, so it may run next to other such calls. */
  readOnly?: boolean;
  /** Use `[modules.actions.work]`'s default limits instead of the medium tier's. */
  work?: boolean;
  /** High risk: wait up to `inline_wait_ms` for the result, then report it as a notice. */
  followup?: boolean;
  limits?: Partial<Limit>;
  /** High risk: what the self-review should know. */
  guidance?: string;
  /**
   * Arguments as the gate checks them (stage `args`). Default: any JSON object; the program
   * behind the tool checks its own.
   */
  args?: z.ZodType<JsonObject>;
  /** Where the result came from, for its data block (default the capability name). */
  source?: string;
  call(args: JsonObject, ctx: ExecContext): Promise<ExternalToolAnswer>;
}

/** Call counts as an extension or a tool file declares them (`ExtToolLimits`). */
export interface ExternalLimits {
  per_hour?: number | undefined;
  per_person_per_hour?: number | undefined;
  per_day?: number | undefined;
  per_person_per_day?: number | undefined;
  cooldown_ms?: number | undefined;
}

/**
 * Declared counts as the gate's `Limit`. In a declaration `0` means "no such limit" (the
 * protocol's word for it), while the gate reads `0` as "never": it becomes a count nobody reaches.
 * Keys left out fall back to the tier's.
 */
export function externalLimits(declared: ExternalLimits | undefined): Partial<Limit> | undefined {
  if (declared === undefined) return undefined;
  const count = (n: number | undefined) =>
    n === undefined ? undefined : n === 0 ? Number.MAX_SAFE_INTEGER : n;
  const out: Partial<Limit> = {};
  const perDay = count(declared.per_day);
  if (perDay !== undefined) out.per_day = perDay;
  const perPersonPerDay = count(declared.per_person_per_day);
  if (perPersonPerDay !== undefined) out.per_person_per_day = perPersonPerDay;
  const perHour = count(declared.per_hour);
  if (perHour !== undefined) out.per_hour = perHour;
  const perPersonPerHour = count(declared.per_person_per_hour);
  if (perPersonPerHour !== undefined) out.per_person_per_hour = perPersonPerHour;
  if (declared.cooldown_ms !== undefined) out.cooldown_ms = declared.cooldown_ms;
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Any JSON object (the model's arguments). */
const ANY_OBJECT: z.ZodType<JsonObject> = z.custom<JsonObject>(
  (value) => isJsonObject(value),
  "the arguments must be a JSON object",
);

/** Longest error text passed back from another program. */
const MAX_ERROR_CHARS = 600;

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** The parts of a JSON Schema object the registry's tool spec takes. */
function toolShape(parameters: JsonObject): { properties: JsonObject; required?: string[] } {
  const properties = isJsonObject(parameters.properties) ? parameters.properties : {};
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((r): r is string => typeof r === "string")
    : [];
  return required.length > 0 ? { properties, required } : { properties };
}

/** An external tool as a capability (see the file comment). */
export function externalToolCapability(spec: ExternalToolSpec): Capability<JsonObject> {
  const source = spec.source ?? spec.capability;
  const shape = toolShape(spec.parameters);
  return defineCapability<JsonObject>({
    name: spec.capability,
    summary: spec.summary,
    risk: spec.risk,
    args: spec.args ?? ANY_OBJECT,
    permission: spec.permission,
    ...(spec.work === undefined ? {} : { work: spec.work }),
    ...(spec.limits === undefined ? {} : { limits: spec.limits }),
    ...(spec.guidance === undefined ? {} : { guidance: spec.guidance }),
    tool: {
      name: spec.tool,
      description: spec.description,
      ...shape,
      // Whatever it answered is put in a data block here, so the agent passes it on as it is.
      framed: true,
      ...(spec.readOnly === true ? { readOnly: true } : {}),
      ...(spec.followup === true ? { followup: true } : {}),
      meta: { effect: "external", speed: "instant", group: spec.group },
    },
    async execute(args, ctx): Promise<ActionResult> {
      let answer: ExternalToolAnswer;
      try {
        answer = await spec.call(args, ctx);
      } catch (error) {
        if (error instanceof CapabilityError) throw error;
        // Another program's error text is data as much as its answer: no tags of the prompt's.
        throw new CapabilityError(escapeData(clip(errorMessage(error), MAX_ERROR_CHARS)), {
          cause: error,
        });
      }
      const text =
        answer.framed === true
          ? answer.text
          : dataBlock(source, `${spec.tool} 的結果`, answer.text === "" ? "(空的)" : answer.text);
      return { text, data: answer.data ?? null };
    },
  });
}
