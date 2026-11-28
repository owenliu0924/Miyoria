// A throwaway Core for trying her room on this machine (docs/design/her-room.md §8): never the live
// one. Everything lives under `<repo>/.dev/room/` (git-ignored), marked by a `.miyoria-dev` file;
// the script takes no path, works out that folder from where it is itself, and refuses any database
// that is not in it or not marked, so the live `data/miyoria.db` can never be opened by it.
//
//   room-dev.ts init [--fresh] [--model <.model3.json>]
//                                          the config, the ports, the panel's env (--fresh: a new database;
//                                          --model: her Live2D model for the room's figure, read only)
//   room-dev.ts member [--name 測試小澄] [--id 900000000000000002]
//                                          a member's session and server membership; prints the cookie
//                                          (--id: another made-up account, to try one member against another)
//
// Not part of any build: `pnpm exec tsx --conditions=@miyoria/source packages/api/dev/room-dev.ts …`.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authTables } from "@miyoria/auth";
import { openStore } from "@miyoria/store";
import { toTimestamp } from "@miyoria/types";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
export const DEV_DIR = join(ROOT, ".dev", "room");
export const MARKER = ".miyoria-dev";
const DB = join(DEV_DIR, "miyoria.db");
/** The member's account: a made-up Discord id no real account has. */
export const DEV_ACCOUNT = { platform: "discord", id: "900000000000000001" } as const;
const DEV_GUILD = "900000000000000999";

/** The ports this machine does not use now (Windows' reserved ranges are never handed out). */
async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

/** Stops unless `path` is inside `.dev/room/` and the folder is marked as a dev folder. */
export function assertDevPath(path: string): void {
  const inside = relative(DEV_DIR, resolve(path));
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`refusing ${path}: not under ${DEV_DIR}`);
  }
  if (!existsSync(join(DEV_DIR, MARKER))) {
    throw new Error(`refusing ${path}: ${DEV_DIR} has no ${MARKER} (run init)`);
  }
}

const tomlString = (s: string) => JSON.stringify(s.replaceAll("\\", "/"));

/** The dev config: every module that could reach Discord, a GPU, a port of the live Core or the internet is off. */
export function devConfig(
  ports: { api: number; stub: number },
  token: string,
  model: string | null = null,
): string {
  const off = [
    "platform.discord.bot",
    "voice",
    "voice.link",
    "stage.link",
    "cluster",
    "speech",
    "sing",
    "live",
    "watch",
    "mcp",
    "game",
    "game.chat",
    "karaoke",
    "market",
    "exchange",
    "extensions",
    "eval",
    "report",
    "imagegen",
    "sandbox",
    "web",
    "http_tools",
    "knowledge",
    "conversation",
    "reflect",
  ];
  return `# A dev Core for her room (packages/api/dev/room-dev.ts). Throwaway: delete .dev/room/ when done.
[core]
profile = "deepseek-chan"
profiles_dir = ${tomlString(join(ROOT, "profiles"))}
database_url = ${tomlString(`sqlite:${DB}`)}
log = "info"

# The profile's own [llm.purposes] name the provider \`deepseek\`: that name is the local stub here,
# so whatever model a purpose names, nothing leaves this machine.
[llm.providers.deepseek]
kind = "openai-compatible"
base_url = "http://127.0.0.1:${ports.stub}/v1"
api_key = "dev"

[llm.purposes]
chat = ["deepseek:chat"]
review = ["deepseek:chat"]
fast = ["deepseek:chat"]
summarizer = ["deepseek:chat"]
reflect = ["deepseek:chat"]
watch = ["deepseek:chat"]
game = ["deepseek:chat"]
mind = ["deepseek:chat"]

[llm.call_log]
enabled = false

${off.map((id) => `[modules.${id.includes(".") ? `"${id}"` : id}]\nenabled = false\n`).join("\n")}
# Her memory sums a conversation up soon after it goes quiet, so the relation panel has memories
# (the stub's summarizer writes one) without waiting five minutes.
[modules.memory]
consolidate_idle_secs = 20
tick_secs = 5

[modules.api]
bind = "127.0.0.1:${ports.api}"
token = "${token}"
panel_dir = ""

[modules.api.discord_oauth]
client_id = "dev"
client_secret = "dev"
redirect_uri = "http://127.0.0.1:${ports.api}/api/auth/oauth/callback"

[modules.api.public]
enabled = true

[modules.api.room]
enabled = true
# The figure's copies (textures made smaller) stay in this folder, never in data/.
figure_cache = ${tomlString(join(DEV_DIR, "figure"))}
${
  model === null
    ? ""
    : `
# Her model for the room's Live2D figure (read only; cards stay as they are).
[modules.cards]
portrait_model = ${tomlString(resolve(model))}
`
}`;
}

async function init(fresh: boolean, model: string | null): Promise<void> {
  if (existsSync(DEV_DIR) && !existsSync(join(DEV_DIR, MARKER))) {
    throw new Error(`${DEV_DIR} exists but is not a dev folder (no ${MARKER}); not touching it`);
  }
  mkdirSync(DEV_DIR, { recursive: true });
  writeFileSync(join(DEV_DIR, MARKER), "a throwaway Core for her room; safe to delete\n");
  if (fresh) {
    for (const f of ["miyoria.db", "miyoria.db-wal", "miyoria.db-shm"]) {
      const path = join(DEV_DIR, f);
      assertDevPath(path);
      rmSync(path, { force: true });
    }
  }
  const ports = { api: await freePort(), stub: await freePort() };
  const token = randomBytes(24).toString("base64url");
  writeFileSync(join(DEV_DIR, "ports.json"), `${JSON.stringify(ports, null, 2)}\n`);
  writeFileSync(join(DEV_DIR, "miyoria.toml"), devConfig(ports, token, model));
  writeFileSync(join(DEV_DIR, "panel.env"), `MIYORIA_CORE_URL=http://127.0.0.1:${ports.api}\n`);
  process.stdout.write(
    `dev room in ${DEV_DIR}\n  core:  http://127.0.0.1:${ports.api}  (admin token in miyoria.toml)\n  stub:  http://127.0.0.1:${ports.stub}/v1\n`,
  );
}

async function member(name: string, id: string = DEV_ACCOUNT.id): Promise<void> {
  if (!/^9\d{17}$/.test(id))
    throw new Error(`refusing --id ${id}: made-up ids are 18 digits starting with 9`);
  const account = { platform: "discord", id } as const;
  assertDevPath(DB);
  const store = await openStore(`sqlite:${DB}`);
  try {
    // Sessions live in the auth plugin's table, routed once the plugin is attached (as in Core).
    store.plugin(authTables);
    const places = store.places;
    if (!places) throw new Error("this store has no places");
    // A made-up server she is in, and the member in it (the room is only for server members).
    const space = places.seen("discord", DEV_GUILD, "開發用伺服器");
    places.memberSeen(space, account, name);
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const now = Date.now();
    await store.settings.set("_global", `panel_session:${hash}`, {
      account: { ...account },
      name,
      avatar_url: null,
      tier: "member",
      created_at: toTimestamp(now),
      expires_at: toTimestamp(now + 7 * 86_400_000),
    });
    process.stdout.write(
      `member ${name} (${account.platform}:${account.id}) in server ${space}\n` +
        `in the browser at the panel's address: document.cookie = "miyoria_session=${token}; path=/"\n` +
        `curl: -H "cookie: miyoria_session=${token}" -H "x-miyoria-request: 1"\n`,
    );
  } finally {
    await store.close();
  }
}

function isMain(): boolean {
  return (process.argv[1] ?? "").replaceAll("\\", "/").endsWith("packages/api/dev/room-dev.ts");
}

if (isMain()) {
  const [command, ...rest] = process.argv.slice(2);
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  try {
    if (command === "init") await init(rest.includes("--fresh"), flag("--model") ?? null);
    else if (command === "member") await member(flag("--name") ?? "測試小澄", flag("--id"));
    else {
      process.stderr.write("usage: room-dev.ts init [--fresh] | member [--name <name>]\n");
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
