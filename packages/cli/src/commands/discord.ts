// `miyoria discord commands reset`: deletes every slash command of the bot (globally and in
// every server it is in). Use it once to remove duplicates left from earlier global / guild
// mode runs; `miyoria core` registers the current set again when it starts.

import type { Config } from "@miyoria/runtime/kernel";
import { t } from "../i18n/index.js";
import type { Prompter } from "../prompt.js";
import { bold, dim, fail, ok, println, warn } from "../ui.js";
import { loadConfig } from "./node.js";

const API = "https://discord.com/api/v10";

export class DiscordCommandError extends Error {
  override readonly name = "DiscordCommandError";
}

/** The bot token from `[modules."platform.discord.bot"] token` (after `${VAR}` expansion). */
export function botToken(config: Config): string {
  const section = config.module("platform.discord.bot").config;
  const token =
    section !== null &&
    typeof section === "object" &&
    !Array.isArray(section) &&
    typeof section.token === "string"
      ? section.token.trim()
      : "";
  if (token === "") throw new DiscordCommandError(t.discord.noToken);
  return token;
}

/** A tiny Discord REST client: JSON in and out, waits out rate limits. */
export class DiscordApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request(method: "GET" | "PUT", route: `/${string}`, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(`${API}${route}`, {
        method,
        headers: {
          authorization: `Bot ${this.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 429 && attempt < 5) {
        const info = (await response.json().catch(() => ({}))) as { retry_after?: number };
        await new Promise((resolve) => setTimeout(resolve, (info.retry_after ?? 1) * 1000 + 50));
        continue;
      }
      if (!response.ok) {
        throw new DiscordCommandError(t.discord.apiStatus(method, route, response.status));
      }
      return response.status === 204 ? null : response.json();
    }
  }

  put(route: `/${string}`, options?: { body?: unknown }): Promise<unknown> {
    return this.request("PUT", route, options?.body);
  }

  async applicationId(): Promise<string> {
    const app = (await this.request("GET", "/applications/@me")) as { id?: string };
    if (!app.id) throw new DiscordCommandError(t.discord.noApplicationId);
    return app.id;
  }

  /** Every server the bot is in (paged, 200 at a time). */
  async guildIds(): Promise<string[]> {
    const out: string[] = [];
    let after = "0";
    for (;;) {
      const page = (await this.request("GET", `/users/@me/guilds?limit=200&after=${after}`)) as {
        id: string;
      }[];
      out.push(...page.map((g) => g.id));
      const last = page.at(-1);
      if (page.length < 200 || !last) return out;
      after = last.id;
    }
  }
}

/** `miyoria discord commands reset`. */
export async function commandsReset(
  configPath: string,
  p: Prompter | null,
  yes: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const config = await loadConfig(configPath);
  const api = new DiscordApi(botToken(config), fetchImpl);
  const appId = await api.applicationId();
  const guilds = await api.guildIds();
  println(t.discord.willDelete(guilds.length) + dim(t.discord.reregistered));
  if (!yes) {
    if (!p) throw new DiscordCommandError(t.discord.needYes);
    if (!(await p.confirm(t.discord.confirm, false))) {
      println(t.discord.cancelled);
      return;
    }
  }
  const { resetCommands } = await import("@miyoria/discord");
  const report = await resetCommands(api, appId, guilds);
  ok(t.discord.cleared(report.cleared.length));
  for (const f of report.failed) {
    warn(
      t.discord.scopeFailed(
        f.scope === "global" ? t.discord.scopeGlobal : t.discord.scopeGuild(f.scope),
        f.error,
      ),
    );
  }
  if (report.failed.length > 0) fail(t.discord.someFailed);
  println(bold(t.discord.restart));
}
