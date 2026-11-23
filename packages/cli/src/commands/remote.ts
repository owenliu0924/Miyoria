// CLI commands that talk to a running core through the Admin API.

import { type ApiRpc, ClientError, contract, responseError } from "@miyoria/api";
import type { Config } from "@miyoria/runtime/kernel";
import type { ModuleStateKind } from "@miyoria/types";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { t } from "../i18n/index.js";
import { cyan, dim, green, println, red, yellow } from "../ui.js";

export const DEFAULT_API_BIND = "127.0.0.1:7878";

export class RemoteError extends Error {
  override readonly name = "RemoteError";
}

/**
 * A running core's API: the route table through the contract's typed client (`rpc`), which sends
 * the token and fails with a `ClientError`.
 */
export interface Remote {
  rpc: ApiRpc;
}

/** The route table's client for the core at `baseUrl`. */
export function rpcClient(baseUrl: string, token: string): ApiRpc {
  const link = new OpenAPILink(contract, {
    url: baseUrl,
    headers: { authorization: `Bearer ${token}` },
    fetch: async (request, init) => {
      let response: Response;
      try {
        response = await fetch(request, init);
      } catch (error) {
        throw ClientError.transport(error);
      }
      if (!response.ok) throw await responseError(response);
      return response;
    },
  });
  return createORPCClient(link);
}

/** Where `config` says the admin API listens, and the token it takes. */
export interface ApiEndpoint {
  /** `[modules.api] bind` as written (default `127.0.0.1:7878`). */
  bind: string;
  /** The token; `""` when none is set. */
  token: string;
  /** The base URL this machine reaches it by (a wildcard bind goes through loopback). */
  local: string;
}

export function apiEndpoint(config: Config): ApiEndpoint {
  const section = config.module("api").config;
  const obj =
    section !== null && typeof section === "object" && !Array.isArray(section) ? section : {};
  const bind = typeof obj.bind === "string" && obj.bind !== "" ? obj.bind : DEFAULT_API_BIND;
  const token = typeof obj.token === "string" ? obj.token : "";
  // A wildcard bind address is reachable locally through loopback.
  const host = bind.replace("0.0.0.0", "127.0.0.1").replace("[::]", "[::1]");
  return { bind, token, local: `http://${host}` };
}

/** Client for the core described by `config` (`[modules.api]`). */
export function clientFor(config: Config): Remote {
  const { token, local } = apiEndpoint(config);
  if (token === "") throw new RemoteError(t.remote.noToken);
  return { rpc: rpcClient(local, token) };
}

/** `true` when a core answers `/api/health` within `timeoutMs`. */
export async function isRunning(client: Remote, timeoutMs = 2000): Promise<boolean> {
  try {
    await client.rpc.health(undefined, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

/** A module's state in the active language, colored; an unknown state prints as it is. */
export function stateLabel(state: ModuleStateKind): string {
  const words: Record<string, string> = t.remote.moduleStates;
  const word = words[state] ?? state;
  switch (state) {
    case "running":
      return green(word);
    case "degraded":
      return yellow(word);
    case "failed":
      return red(word);
    case "disabled":
      return dim(word);
    default:
      return word;
  }
}

export async function modules(client: Remote): Promise<void> {
  for (const m of await client.rpc.modules.list()) {
    const reason = m.reason === null ? "" : `  (${m.reason})`;
    println(`${m.id.padEnd(24)} ${stateLabel(m.state)}${reason}`);
  }
}

export async function moduleAction(client: Remote, id: string, action: string): Promise<void> {
  const m = await client.rpc.modules.action({ params: { id, action } });
  println(`${m.id} → ${stateLabel(m.state)}`);
}

export async function status(client: Remote): Promise<void> {
  const health = await client.rpc.health();
  println(`core ${health.version}  ${health.status}\n`);
  await modules(client);
  const usage = Object.entries(await client.rpc.llm.usage()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (usage.length > 0) {
    println(`\n${t.remote.usageTitle}`);
    for (const [model, u] of usage) {
      println(
        t.remote.usage(
          model,
          u.calls,
          t.common.int(u.prompt_tokens),
          t.common.int(u.cached_prompt_tokens),
          t.common.int(u.completion_tokens),
        ),
      );
    }
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local `MM-DD HH:MM:SS`. */
function localStamp(ts: string, withDate: boolean): string {
  const d = new Date(Date.parse(ts));
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return withDate ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}` : time;
}

/** Terminal columns of a text: CJK and full-width characters take two. */
function columns(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width += code >= 0x2e80 && code <= 0xffdc ? 2 : 1;
  }
  return width;
}

export async function decisions(client: Remote, limit: number): Promise<void> {
  const { replied, skipped } = t.remote;
  const width = Math.max(columns(replied), columns(skipped));
  for (const d of await client.rpc.decisions({ query: { limit } })) {
    const trace = d.trace;
    const mark = trace.respond ? replied : skipped;
    println(
      `${localStamp(d.ts, true)} ${mark}${" ".repeat(width - columns(mark))} ${trace.context.channel.padEnd(5)} ${trace.score.toFixed(2)}  ${trace.context.platform}  ${trace.reasons.join(";")}`,
    );
  }
}

export async function personaShow(client: Remote): Promise<void> {
  for (const s of await client.rpc.persona.list()) {
    println(`${cyan(`## ${s.key}`)}${t.remote.characters([...s.body].length)}\n${s.body}\n`);
  }
}

export async function personaSet(client: Remote, key: string, body: string): Promise<void> {
  const { version } = await client.rpc.persona.set({
    params: { key },
    body: { body, edited_by: "cli" },
  });
  println(`${green("✓")} ${t.remote.personaUpdated(key, version)}`);
}

/** `miyoria tail`: one line per bus event (time, type, payload) until `signal` aborts. */
export async function events(
  client: Remote,
  topics: string[],
  signal?: AbortSignal,
): Promise<void> {
  const filter = topics.length === 0 ? ["*"] : topics;
  const stream = await client.rpc.events(
    { query: { topics: filter.join(",") } },
    signal ? { signal } : {},
  );
  try {
    for await (const env of stream) {
      println(`${localStamp(env.at, false)} ${env.type.padEnd(26)} ${JSON.stringify(env.data)}`);
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    await stream.return?.().catch(() => undefined);
  }
}
