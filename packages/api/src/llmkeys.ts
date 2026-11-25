// The providers' API keys from the panel (`admin.llm.keys`, the routes' permission):
//
// * `GET /api/llm/keys` → each provider's keys by position, label, source and state
// * `POST /api/llm/keys/{provider}` `{ key, label? }` → the key, now in rotation
// * `POST /api/llm/keys/{provider}/{id}/disable` | `/enable` → the key
// * `DELETE /api/llm/keys/{provider}/{id}` → `{ deleted }`
// * `POST /api/llm/keys/{provider}/{id}/test` → one request of one token with it alone
//
// A key's value goes in once and never comes back: no response, audit entry, log line or error
// carries it. Every change and test is audited with the provider, the key's id, position and
// label. The keys themselves are the `llm` module's (`LlmKeysKey`, `panel-keys.ts`).

import { KeyManageError, type LlmKeys, LlmKeysKey } from "@miyoria/llm/llm";
import type { JsonValue } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { type ApiContext, type ApiState, actorOf } from "./state.js";

function keysOf(state: ApiState): LlmKeys {
  return state.service(LlmKeysKey, "LLM keys");
}

/** A refused change as the API answers it; its message never holds a key. */
function refusal(error: unknown): unknown {
  if (!(error instanceof KeyManageError)) return error;
  switch (error.code) {
    case "not_found":
      return ApiError.notFound(error.message);
    case "invalid":
      return ApiError.badRequest(error.message);
    case "duplicate":
    case "unsupported":
      return ApiError.conflict(error.message);
    case "unavailable":
      return ApiError.unavailable(error.message);
  }
}

/**
 * Runs `change`, then audits `action` on the provider with `detail` (what it names of the key,
 * never its value), and on a refusal its reason.
 */
async function audited<T>(
  state: ApiState,
  c: ApiContext,
  action: string,
  provider: string,
  detail: () => Record<string, JsonValue>,
  change: () => T | Promise<T>,
  after: (result: T) => Record<string, JsonValue> = () => ({}),
): Promise<T> {
  let result: T;
  try {
    result = await change();
  } catch (error) {
    const reason = error instanceof KeyManageError ? error.code : "error";
    await state.audit(c, action, `llm:${provider}`, { ...detail(), refused: reason }, false);
    throw refusal(error);
  }
  await state.audit(c, action, `llm:${provider}`, { ...detail(), ...after(result) }, true);
  return result;
}

/** What an audit entry says of key `id`: its id, position, label and source. */
function named(keys: LlmKeys, provider: string, id: string): Record<string, JsonValue> {
  const ref = keys.ref(provider, id);
  return { provider, id, position: ref.position, label: ref.label, source: ref.source };
}

export const llmKeysRpc = {
  keys: os.llm.keys.handler(({ context }) => ({ providers: keysOf(context.state).list() })),
  addKey: os.llm.addKey.handler(({ input, context }) => {
    const keys = keysOf(context.state);
    const { provider } = input.params;
    const label = input.body.label ?? null;
    return audited(
      context.state,
      context.c,
      "llm.key.add",
      provider,
      () => ({ provider, label }),
      () => keys.add(provider, input.body.key, label, actorOf(context.c)),
      (row) => ({ id: row.id, position: row.position, label: row.label }),
    );
  }),
  disableKey: os.llm.disableKey.handler(({ input, context }) => {
    const keys = keysOf(context.state);
    const { provider, id } = input.params;
    return audited(
      context.state,
      context.c,
      "llm.key.disable",
      provider,
      () => named(keys, provider, id),
      () => keys.setDisabled(provider, id, true),
    );
  }),
  enableKey: os.llm.enableKey.handler(({ input, context }) => {
    const keys = keysOf(context.state);
    const { provider, id } = input.params;
    return audited(
      context.state,
      context.c,
      "llm.key.enable",
      provider,
      () => ({ provider, id }),
      () => keys.setDisabled(provider, id, false),
      (row) => ({ position: row.position, label: row.label, source: row.source }),
    );
  }),
  deleteKey: os.llm.deleteKey.handler(async ({ input, context }) => {
    const keys = keysOf(context.state);
    const { provider, id } = input.params;
    const before = named(keys, provider, id);
    await audited(
      context.state,
      context.c,
      "llm.key.delete",
      provider,
      () => before,
      () => keys.remove(provider, id),
    );
    return { deleted: true };
  }),
  testKey: os.llm.testKey.handler(({ input, context, signal }) => {
    const keys = keysOf(context.state);
    const { provider, id } = input.params;
    return audited(
      context.state,
      context.c,
      "llm.key.test",
      provider,
      () => named(keys, provider, id),
      () => keys.test(provider, id, signal),
      (r) => ({ ok: r.ok, kind: r.kind, status: r.status, model: r.model }),
    );
  }),
};
