// The rules every contract schema follows, and the JSON Schema a part is emitted as.
//
// A part is one folder of this package (`wire`, `voice-link`, ...). Its `src/index.ts` exports
// zod schemas; the TypeScript types are inferred from them, and `schema/<part>.json` is generated
// from them (`pnpm contracts:gen`) and checked in, for readers that are not TypeScript.
//
// Rules, checked by `checkRules` for every part (kit/test/parts.test.ts):
//
// 1. No `.transform`, `z.custom`, `z.date`, `z.bigint`, dynamic `.catch`: none of them has a JSON
//    Schema form. Normalising (trim, clamp, `null` to `undefined`) is the receiver's code, after
//    `parse`.
// 2. No `.refine`: JSON Schema drops it without a word, so the other side would not know the
//    rule. Use checks JSON Schema can say (`min`, `max`, `regex`, `int`, an enum).
// 3. An exported object, union or enum has a name: `.meta({ id: "<Part><Name>" })`. It becomes the
//    `$defs` key and the class name on the Python side. Names are unique across parts.
// 4. A field added to a shape that is already in use is `.optional()` or has a `.default()`, so a
//    peer that predates it stays valid. (Not checkable here; reviewers hold it.)
//
// The JSON Schema is emitted in zod's input mode: fields with a default are not required and
// objects do not forbid extra keys, which is what lets an older peer ignore what it does not know.

import { z } from "zod";

/** Kinds of schema that must carry a name when a part exports them. */
const NAMED_KINDS = new Set(["object", "union", "enum", "intersection", "tuple", "lazy"]);

/** Checks that `z.toJSONSchema` cannot express, by zod's own check name. */
const UNSAYABLE_CHECKS = new Set(["custom"]);

export const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** One part's JSON Schema file. */
export interface PartDocument {
  $schema: string;
  title: string;
  $defs: Record<string, unknown>;
}

/** The name a schema was given with `.meta({ id })`, if any. */
export function contractId(schema: z.ZodType): string | null {
  const id = z.globalRegistry.get(schema)?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** The zod schemas among a module's exports, by export name, in name order. */
export function exportedSchemas(part: Record<string, unknown>): Map<string, z.ZodType> {
  const out = new Map<string, z.ZodType>();
  for (const name of Object.keys(part).sort()) {
    const value = part[name];
    if (value instanceof z.ZodType) out.set(name, value);
  }
  return out;
}

/** `voice-link` → `VoiceLink`: what every name of that part starts with. */
export function partPrefix(part: string): string {
  return part
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What breaks the rules in one part: one line per problem, empty when it follows them. */
export function checkRules(partName: string, part: Record<string, unknown>): string[] {
  // A set: zod visits a schema once per place it is used, and one problem is one line.
  const problems = new Set<string>();
  const prefix = partPrefix(partName);
  for (const [name, schema] of exportedSchemas(part)) {
    const id = contractId(schema);
    const kind = schema._zod.def.type;
    if (id === null && NAMED_KINDS.has(kind)) {
      problems.add(`${name}: an exported ${kind} needs .meta({ id: "${prefix}..." })`);
    }
    if (id !== null && !id.startsWith(prefix)) {
      problems.add(`${name}: its id "${id}" does not start with "${prefix}"`);
    }
    for (const io of ["input", "output"] as const) {
      try {
        z.toJSONSchema(schema, {
          io,
          unrepresentable: "throw",
          override: (ctx) => {
            for (const check of ctx.zodSchema._zod.def.checks ?? []) {
              const what = check._zod.def.check;
              if (io === "input" && UNSAYABLE_CHECKS.has(what)) {
                problems.add(`${name}: a ${what} check (.refine) does not reach JSON Schema`);
              }
            }
          },
        });
      } catch (error) {
        problems.add(`${name}: no JSON Schema form (${io}): ${message(error)}`);
      }
    }
  }
  return [...problems];
}

/** The named schemas a part exports, by name. Two exports must not share a name. */
export function namedSchemas(part: Record<string, unknown>): Map<string, z.ZodType> {
  const out = new Map<string, z.ZodType>();
  for (const schema of exportedSchemas(part).values()) {
    const id = contractId(schema);
    if (id === null) continue;
    const other = out.get(id);
    if (other !== undefined && other !== schema) {
      throw new Error(`two schemas are named "${id}"`);
    }
    out.set(id, schema);
  }
  return out;
}

/**
 * The JSON Schema file of a part: one `$defs` entry for every named schema its exports reach,
 * names in order. `null` when the part exports no named schema.
 */
export function emitPart(partName: string, part: Record<string, unknown>): PartDocument | null {
  const named = namedSchemas(part);
  if (named.size === 0) return null;
  // One object that holds them all: zod then puts every named schema it meets under `$defs`,
  // referenced by name, the ones nested inside others included.
  const all = z.object(Object.fromEntries(named));
  const whole = z.toJSONSchema(all, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "throw",
  });
  const defs = (whole.$defs ?? {}) as Record<string, unknown>;
  const anonymous = Object.keys(defs).filter((key) => key.startsWith("__"));
  if (anonymous.length > 0) {
    throw new Error(
      `${partName}: a recursive schema has no name (${anonymous.join(", ")}); give it .meta({ id })`,
    );
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(defs).sort()) sorted[key] = defs[key];
  return { $schema: JSON_SCHEMA_DIALECT, title: `@miyoria/contracts/${partName}`, $defs: sorted };
}

/** The text of a part's file: two-space JSON and a final newline. */
export function formatDocument(document: PartDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
