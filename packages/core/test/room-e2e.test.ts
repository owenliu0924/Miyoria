// Her room end to end (docs/design/her-room.md §10, the largest risk): the room's context is on the
// platform `web` while its author is a Discord account, and identity, the transcript, artifact
// visibility, `<feel>`'s name matching, the quota and her initiative were written for one platform
// per conversation. This boots the real Core (real store, real host, real scheduler, the API with
// the room on) against a scripted model on a local port, and checks through the room's own routes:
//
// * her reply reaches the room of the member who spoke, and another member's stream sees nothing;
// * the transcript is the room's place (`web:dm:<person>`), and what she remembers there is in that
//   member's DM scope, the same as their Discord DM's;
// * a `<feel>` naming the member moves that member's bond, and the stream carries `+` with her
//   quote and no number;
// * the quota is charged to that member, not to the other;
// * a file she shares arrives as a download only that member can open;
// * a reminder they asked for in the room is said in the room when it comes due.

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { authTables } from "@miyoria/auth";
import { PersonQuotaKey } from "@miyoria/brain/self";
import { Config, configureLogging } from "@miyoria/runtime/kernel";
import { openStore } from "@miyoria/store";
import { type AccountRef, PlacesKey, roomContext, toTimestamp } from "@miyoria/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contentText,
  type LlmStub,
  lastUserText,
  type StubRequest,
  startLlmStub,
} from "../../api/dev/llm-stub.js";
import type { Core } from "../src/boot.js";
import { buildCore } from "../src/modules.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const ALICE: AccountRef = { platform: "discord", id: "900000000000000011" };
const BOB: AccountRef = { platform: "discord", id: "900000000000000012" };
const MODEL = "deepseek:deepseek-v4.1-flash";

/** The tool whose result her request answers, `null` when it answers a line. */
function answeredTool(request: StubRequest): string | null {
  // The host renames call ids in what it keeps, so the name comes from her call itself.
  const messages = (request.messages ?? []) as {
    role: string;
    tool_calls?: { function?: { name?: string } }[];
  }[];
  let answered = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "tool") answered = true;
    // A line said after the last tool result: this request answers the line.
    if (m?.role === "user" && !answered) return null;
    if (m?.role === "assistant") {
      return answered ? (m.tool_calls?.[0]?.function?.name ?? null) : null;
    }
  }
  return null;
}

/** What she does, by what Alice said and which tool just answered. */
function script(shared: { artifact: string | null }) {
  return (request: StubRequest) => {
    const chat = (request.messages ?? []).some(
      (m) => m.role === "system" && contentText(m.content).includes("<feel>"),
    );
    if (request.response_format !== undefined || !chat) {
      return { text: "{}" };
    }
    const tool = answeredTool(request);
    const feel = "<feel>\n我: 開心 中\n小愛: 羈絆 + 「她記得我愛吃布丁」\n</feel>";
    if (tool === "remember") return { text: `記住了!\n${feel}` };
    if (tool === "remind_me") return { text: "好,一分鐘後提醒你。\n<feel>\n我: 開心 弱\n</feel>" };
    if (tool === "share") return { text: "給你。\n<feel>\n我: 開心 弱\n</feel>" };
    // Her line to answer is Alice's own (`小愛: ...`), not the memory block that follows it.
    const said = lastUserText(request)
      .split("\n")
      .filter((l) => l.startsWith("小愛: "))
      .join("\n");
    if (said.includes("布丁")) {
      return { tool: { name: "remember", args: { content: "小愛最愛吃布丁", about: "speaker" } } };
    }
    if (said.includes("提醒我")) {
      return { tool: { name: "remind_me", args: { what: "提醒小愛喝水", in_minutes: 1 } } };
    }
    if (said.includes("檔案") && shared.artifact !== null) {
      return { tool: { name: "share", args: { artifact: shared.artifact } } };
    }
    // Woken by the reminder: nobody said anything, the note is in what she is shown.
    if (said === "" && JSON.stringify(request.messages).includes("喝水"))
      return { text: "小愛,該喝水囉。\n<feel>\n我: 開心 弱\n</feel>" };
    return { text: "嗯。\n<feel>\n我: 開心 弱\n</feel>" };
  };
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      server.close(() => done(typeof a === "object" && a !== null ? a.port : 0));
    });
  });
}

const toml = (s: string) => JSON.stringify(s.replaceAll("\\", "/"));

function config(db: string, api: number, stub: string): string {
  const off = [
    "platform.discord.bot",
    "voice",
    "voice.link",
    "stage.link",
    "cluster",
    "speech",
    "sing",
    "live",
    "mcp",
    "game",
    "game.chat",
    "karaoke",
    "market",
    "exchange",
    "extensions",
    "eval",
    "web",
    "http_tools",
    "knowledge",
    "conversation",
    "reflect",
  ];
  return `[core]
profile = "deepseek-chan"
profiles_dir = ${toml(join(ROOT, "profiles"))}
database_url = ${toml(`sqlite:${db}`)}

[llm.providers.deepseek]
kind = "openai-compatible"
base_url = "${stub}"
api_key = "test"

[llm.call_log]
enabled = false

[llm.pricing."${MODEL}"]
input_per_mtok = 1.0
output_per_mtok = 1.0

${off.map((id) => `[modules.${id.includes(".") ? `"${id}"` : id}]\nenabled = false\n`).join("\n")}
[modules.arbiter]
quiet_start_hour = 0
quiet_end_hour = 0

[modules.agent.initiative]
tick_secs = 1

[modules.api]
bind = "127.0.0.1:${api}"
token = "test-token"
panel_dir = ""

[modules.api.discord_oauth]
client_id = "test"
client_secret = "test"
redirect_uri = "http://127.0.0.1:${api}/api/auth/oauth/callback"

[modules.api.room]
enabled = true
`;
}

interface Stream {
  events: Record<string, unknown>[];
  stop(): void;
}

let dir = "";
let dbPath = "";
let core: Core | null = null;
let stub: LlmStub | null = null;
let base = "";
const cookies = new Map<string, string>();
const shared: { artifact: string | null } = { artifact: null };
const streams: Stream[] = [];

const headers = (who: AccountRef) => ({
  cookie: `miyoria_session=${cookies.get(who.id)}`,
  "x-miyoria-request": "1",
});

function follow(who: AccountRef): Stream {
  const events: Record<string, unknown>[] = [];
  const abort = new AbortController();
  void (async () => {
    const res = await fetch(`${base}/api/member/room/stream`, {
      headers: headers(who),
      signal: abort.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let at = buffer.indexOf("\n\n"); at >= 0; at = buffer.indexOf("\n\n")) {
        const data = buffer
          .slice(0, at)
          .split("\n")
          .find((l) => l.startsWith("data: "));
        buffer = buffer.slice(at + 2);
        if (data !== undefined) events.push(JSON.parse(data.slice(6)) as Record<string, unknown>);
      }
    }
  })().catch(() => undefined);
  const stream = { events, stop: () => abort.abort() };
  streams.push(stream);
  return stream;
}

async function send(who: AccountRef, text: string): Promise<{ id: string }> {
  const res = await fetch(`${base}/api/member/room/messages`, {
    method: "POST",
    headers: { ...headers(who), "content-type": "application/json" },
    body: JSON.stringify({ text, client_id: "tab-e2e-0001" }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { id: string };
}

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      const seen = streams.map((st) => st.events.map((e) => JSON.stringify(e).slice(0, 160)));
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(seen, null, 1)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

const of = (s: Stream, kind: string) => s.events.filter((e) => e.kind === kind);
const lines = (s: Stream) => of(s, "line").map((e) => e.text as string);

function sql<T>(query: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(query).all(...params) as T[];
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  configureLogging({ level: "warn" });
  dir = mkdtempSync(join(tmpdir(), "miyoria-room-e2e-"));
  dbPath = join(dir, "miyoria.db");
  // Before the Core: a server she is in, the two members in it, and their sessions.
  const seed = await openStore(`sqlite:${dbPath}`);
  seed.plugin(authTables);
  const places = seed.places;
  if (!places) throw new Error("no places");
  const space = places.seen("discord", "900000000000000999", "測試伺服器");
  for (const [who, name] of [
    [ALICE, "小愛"],
    [BOB, "小明"],
  ] as const) {
    places.memberSeen(space, who, name);
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token, "utf8").digest("hex");
    const now = Date.now();
    await seed.settings.set("_global", `panel_session:${hash}`, {
      account: { ...who },
      name,
      avatar_url: null,
      tier: "member",
      created_at: toTimestamp(now),
      expires_at: toTimestamp(now + 86_400_000),
    });
    cookies.set(who.id, token);
  }
  await seed.close();

  stub = await startLlmStub({ script: script(shared) });
  const api = await freePort();
  base = `http://127.0.0.1:${api}`;
  core = await buildCore(
    Config.fromToml(config(dbPath, api, stub.url), () => undefined),
    {
      baseDir: dir,
      discord: false,
    },
  );
  await core.start();
}, 120_000);

afterAll(async () => {
  for (const s of streams) s.stop();
  await core?.stop();
  await stub?.close();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

describe("her room through the real Core", () => {
  it("a member's line, her reply, the place, the scope, the bond and the quota", async () => {
    const alice = follow(ALICE);
    const bob = follow(BOB);
    await until(
      () => of(alice, "hello").length === 1 && of(bob, "hello").length === 1,
      10_000,
      "hello",
    );

    const sent = await send(ALICE, "記得喔,我最愛吃布丁");
    await until(() => lines(alice).includes("記住了!"), 30_000, "her reply in Alice's room");
    await until(() => of(alice, "bond").length === 1, 10_000, "the bond mark");

    // Her words, and only her words: the feel block never reaches the page.
    expect(lines(alice)).toEqual(["記住了!"]);
    expect(of(alice, "you").map((e) => e.id)).toEqual([sent.id]);
    const bond = of(alice, "bond")[0] as Record<string, unknown>;
    expect(Object.keys(bond).sort()).toEqual(["at", "id", "kind", "quote", "sign", "turn"]);
    expect(bond).toMatchObject({ sign: "plus", quote: "她記得我愛吃布丁" });

    // Bob's stream heard none of it.
    expect(
      bob.events.filter((e) => !["hello", "ping", "state"].includes(e.kind as string)),
    ).toEqual([]);

    // The place: identity's room session, and her transcript under it.
    const services = (core as Core).services;
    const person = (await (core as Core).store.people.personByAccount(ALICE))?.id;
    expect(person).toBeDefined();
    const identity = (core as Core).store as unknown as {
      persons: { sessionOf(context: ReturnType<typeof roomContext>): string | null };
    };
    expect(identity.persons.sessionOf(roomContext(ALICE))).toBe(`web:dm:${person}`);
    const sessions = sql<{ session: string }>("SELECT DISTINCT session FROM transcript_entries");
    expect(sessions.map((s) => s.session)).toEqual([`web:dm:${person}`]);

    // What she remembered there is in Alice's DM scope: the scope of her Discord DM too.
    const memory = sql<{ scope: string; scope_key: string }>(
      "SELECT scope, scope_key FROM memory_records WHERE content LIKE ?",
      "%布丁%",
    );
    expect(memory).toHaveLength(1);
    expect(JSON.parse(memory[0]?.scope ?? "null")).toEqual({ type: "dm", account: ALICE });

    // Her bond with Alice moved; Bob has no row at all.
    const rows = sql<{ person_id: string; bond: number }>(
      "SELECT person_id, bond FROM heart_person",
    );
    expect(rows.find((r) => r.person_id === person)?.bond ?? 0).toBeGreaterThan(0);
    const bobPerson = (await (core as Core).store.people.personByAccount(BOB))?.id;
    expect(rows.some((r) => r.person_id === bobPerson && r.bond !== 0)).toBe(false);

    // The model's cost is Alice's.
    const quota = services.get(PersonQuotaKey);
    expect(quota).toBeDefined();
    expect(quota?.used(person as string, Date.now()).hour ?? 0).toBeGreaterThan(0);
    expect(quota?.used(bobPerson as string, Date.now()).hour ?? 0).toBe(0);
  }, 60_000);

  it("a file she shares is a download for that member only", async () => {
    const alice = follow(ALICE);
    await until(() => of(alice, "hello").length === 1, 10_000, "hello");
    const store = (core as Core).store;
    const at = (core as Core).services.get(PlacesKey)?.at(roomContext(ALICE));
    const person = (await store.people.personByAccount(ALICE))?.id ?? null;
    const made = await store.artifacts?.ingest(new TextEncoder().encode("布丁食譜\n"), {
      source: "doc",
      plugin: "test",
      filename: "pudding.txt",
      mime: "text/plain",
      place: { session: `web:dm:${person}`, space_id: null, room_id: at?.room_id ?? null },
      made_for: person,
    });
    expect(made).toBeDefined();
    shared.artifact = made?.id ?? null;

    await send(ALICE, "把那個檔案給我");
    await until(() => lines(alice).includes("給你。"), 30_000, "her line with the file");
    const withFile = of(alice, "line").find((e) => (e.files as unknown[]).length > 0);
    expect(withFile).toBeDefined();
    expect(((withFile?.files ?? []) as unknown[])[0]).toMatchObject({
      name: "pudding.txt",
      download: true,
    });

    const path = `${base}/api/member/room/files/${withFile?.id}/0`;
    const mine = await fetch(path, { headers: headers(ALICE) });
    expect(mine.status).toBe(200);
    expect(mine.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(mine.headers.get("content-security-policy")).toContain("sandbox");
    expect(await mine.text()).toBe("布丁食譜\n");
    const theirs = await fetch(path, { headers: headers(BOB) });
    expect(theirs.status).toBe(404);
  }, 60_000);

  it("a reminder asked for in the room is said in the room", async () => {
    const alice = follow(ALICE);
    const bob = follow(BOB);
    await until(() => of(alice, "hello").length === 1, 10_000, "hello");
    await send(ALICE, "一分鐘後提醒我喝水");
    await until(() => lines(alice).includes("好,一分鐘後提醒你。"), 30_000, "her yes");
    const due = sql<{ id: string; context: string | null }>(
      "SELECT id, context FROM initiative_schedules",
    );
    expect(due).toHaveLength(1);
    // Brought forward instead of waiting a minute: the tick finds it due now.
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE initiative_schedules SET due = ?").run((Date.now() - 1_000) * 1000);
    db.close();
    await until(() => lines(alice).includes("小愛,該喝水囉。"), 30_000, "the reminder in the room");
    expect(lines(bob)).toEqual([]);
  }, 90_000);
});
