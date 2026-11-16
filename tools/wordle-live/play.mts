// Live test of the Wordle extension: an LLM (DeepSeek or any OpenAI-compatible API) plays through
// the extension's real tools, and the Wordle page shows every move.
//
//   pnpm install && pnpm build          (once: builds the overlay page and the packages)
//   pnpm exec tsx --conditions=@miyoria/source tools/wordle-live/play.mts
//
// Then open the URL it prints (or add it to OBS as a browser source).
//
// The key: LLM_API_KEY in the environment, else LLM_API_KEY= in the repo's .env, else it asks.
// Options (environment): LLM_BASE_URL (default https://api.deepseek.com), MODEL (deepseek-chat),
// GAMES (1), PORT (7999), MAX_GUESSES (6).
//
// What runs: the extension in the real SDK runtime (JSON-RPC, as the extension host drives it);
// the model sees the tools as Core exposes them (`wordle.guess` -> `wordle_guess`); each board the
// extension publishes goes Stage Forwarder -> link schema -> OverlayHub -> WebSocket -> the page.
// Not covered: Core itself, Discord, OBS and the scene director.

import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const at = (p: string) => pathToFileURL(join(ROOT, p)).href;
const { WebSocketServer } = createRequire(join(ROOT, "packages/stage/package.json"))("ws");
const sdk = await import(at("packages/sdk/src/index.ts"));
const extension = (await import(at("extensions/wordle/src/index.ts"))).default;
const { Forwarder, OverlayHub, parseCoreMessage, WORDLE_TOPIC, WordleOnStream } = await import(
  at("packages/stage/src/index.ts")
);
const { Events, eventEnvelope } = await import(at("packages/types/src/index.ts"));

// ---- the key
function fromDotEnv(): string | undefined {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*LLM_API_KEY\s*=\s*"?([^"\s#]+)"?/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}
async function ask(question: string): Promise<string> {
  // Input not echoed: the key never shows on screen.
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  const answer = new Promise<string>((resolve) => rl.question(question, resolve));
  muted = true;
  const value = await answer;
  rl.close();
  process.stdout.write("\n");
  return value.trim();
}
const KEY = process.env.LLM_API_KEY || fromDotEnv() || (await ask("LLM API key (not shown): "));
if (!KEY) throw new Error("no API key");
const BASE = (process.env.LLM_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
const MODEL = process.env.MODEL ?? "deepseek-chat";
const GAMES = Number(process.env.GAMES ?? 1);
const PORT = Number(process.env.PORT ?? 7999);

// ---- the page (the built overlay) and the feed, on one port
const DIST = join(ROOT, "apps/overlay/dist");
if (!existsSync(join(DIST, "index.html"))) throw new Error("apps/overlay/dist is missing: run `pnpm build` first");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const http = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/")).replace(/^([/\\])+/, "");
  const file = join(DIST, path === "" ? "index.html" : path);
  if (!file.startsWith(DIST) || !existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});
const hub = new OverlayHub();
const wss = new WebSocketServer({ server: http });
wss.on("connection", (ws: { send: (s: string) => void }) => {
  for (const f of hub.initial()) ws.send(f);
});
hub.listen((frame: string) => {
  for (const c of wss.clients) c.send(frame);
});
await new Promise<void>((resolve) => http.listen(PORT, "127.0.0.1", resolve));
const PAGE = `http://127.0.0.1:${PORT}/?layer=wordle&ws=ws://127.0.0.1:${PORT}/`;

const forwarder = new Forwarder(false);
const scene: boolean[] = [];
const onStream = new WordleOnStream((on: boolean) => scene.push(on));
let dropped = 0;
function published(params: { type: string; data: unknown }): void {
  if (params.type !== WORDLE_TOPIC) return;
  const env = eventEnvelope("ext.miyoria.wordle", Events.ExtensionEvent, params.data as never, { type: params.type });
  const msgs = forwarder.onEvent(env);
  if (msgs.length !== 1) {
    dropped += 1;
    console.log("!! the Stage dropped a board:", JSON.stringify(params.data));
    return;
  }
  const msg = parseCoreMessage(msgs[0]);
  onStream.board(msg.board);
  hub.wordle(msg.board);
}

// ---- the extension, in the SDK runtime
const hostToExt = new PassThrough();
const extToHost = new PassThrough();
const runtime = sdk.runExtension(extension, { input: hostToExt, output: extToHost, exit: () => {}, timeoutMs: 5000 });
const peer = new sdk.RpcPeer({
  input: extToHost,
  output: hostToExt,
  timeoutMs: 5000,
  onRequest: (method: string, params: unknown) => {
    if (method === "events.publish") published(params as { type: string; data: unknown });
    return {};
  },
  onNotification: () => {},
});
const init = (await peer.request("initialize", {
  protocol: 2,
  host: { name: "miyoria", version: "0.1.0" },
  extension: { id: "miyoria.wordle", version: "0.1.0", dir: join(ROOT, "extensions/wordle"), game: null },
  config: { max_guesses: Number(process.env.MAX_GUESSES ?? 6) },
  permissions: { events: [], tools: true, commands: false, network: [], input: [] },
})) as { contributions: { tools: { name: string; description: string; parameters: unknown }[] } };
const decls = init.contributions.tools;
const tools = decls.map((t) => ({
  type: "function",
  function: { name: t.name.replace(/\./g, "_"), description: t.description, parameters: t.parameters },
}));
const wireName = new Map(decls.map((t) => [t.name.replace(/\./g, "_"), t.name]));
const channel = { platform: "discord", scope: null, channel: "wordle-live", kind: "text" };
async function callTool(name: string, args: unknown): Promise<string> {
  const r = (await peer.request("tools.call", {
    name,
    args,
    context: {
      turn: "01J00000000000000000000000",
      context: channel,
      account: { platform: "discord", id: "owner" },
      message: { context: channel, id: "m1" },
      priority: "normal",
    },
  })) as { content: string };
  return r.content;
}

// ---- the model
interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}
interface Msg {
  role: string;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
async function chat(messages: Msg[]): Promise<Msg> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools, temperature: 0.7 }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices: { message: Msg }[] };
  const m = body.choices[0]?.message;
  if (!m) throw new Error("LLM: no answer");
  return m;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (text: string | null) => {
  if (text?.trim()) console.log(`[她] ${text.replace(/\s+/g, " ").slice(0, 200)}`);
};

console.log(`\nOpen the Wordle page: ${PAGE}`);
console.log("Starting in 10 s…\n");
await sleep(10_000);

const summary: string[] = [];
for (let g = 1; g <= GAMES; g++) {
  const messages: Msg[] = [
    {
      role: "system",
      content:
        "你是直播主,正在直播上玩 Wordle。用 wordle_start 開局,然後一次只用 wordle_guess 猜一個五個字母的英文單字,看提示(🟩🟨⬛)推理下一個字,直到猜中或次數用完。每次猜之前用一句話說你的想法。",
    },
    { role: "user", content: g === 1 ? "來玩一局 Wordle!" : "再來一局!" },
  ];
  let calls = 0;
  let result = "unfinished";
  for (let step = 0; step < 30 && result === "unfinished"; step++) {
    const m = await chat(messages);
    messages.push({ role: "assistant", content: m.content ?? "", tool_calls: m.tool_calls });
    say(m.content);
    if (!m.tool_calls?.length) break;
    for (const tc of m.tool_calls) {
      const name = wireName.get(tc.function.name) ?? tc.function.name;
      let args: unknown = {};
      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {}
      const out = await callTool(name, args);
      calls += 1;
      console.log(`  → ${name} ${JSON.stringify(args)}\n    ${out.replace(/\n/g, "\n    ")}`);
      messages.push({ role: "tool", tool_call_id: tc.id, content: out });
      if (/答對了/.test(out)) result = "won";
      else if (/次數用完|放棄了/.test(out)) result = "lost";
      // Let the page finish typing and turning the row over.
      if (name === "wordle.guess") await sleep(4000);
    }
  }
  if (result !== "unfinished") say((await chat(messages)).content);
  summary.push(`game ${g}: ${result} (${calls} tool calls)`);
  if (g < GAMES) await sleep(18_000);
}

await sleep(17_000); // the finished game stays up 15 s, then the page fades
console.log(`\n== ${summary.join("; ")}`);
console.log(`   boards the Stage dropped: ${dropped}; Wordle scene on/off: ${JSON.stringify(scene)}`);
await runtime.shutdown();
wss.close();
http.close();
