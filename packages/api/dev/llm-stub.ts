// A small local stand-in for the chat model, for trying her room on this machine without a paid
// model (docs/design/her-room.md §8). OpenAI-compatible `POST /v1/chat/completions` (streamed or
// not), answering by a script:
//
// * a request that wants JSON (`response_format`, or a system message that asks for JSON): `{}`;
// * a request with an image part: 「我看到你的圖了」;
// * otherwise two lines after a `<feel>` block that moves the member's bond up, or down when their
//   last line has 「鬧」 in it.
//
// Every request is kept; `GET /requests` lists them (to see that an image really reached the model).
// Not part of any build; `pnpm exec tsx --conditions=@miyoria/source packages/api/dev/llm-stub.ts`.

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** What one request is answered with. */
export type StubReply =
  | { text: string }
  | { tool: { name: string; args: Record<string, unknown> } };

export interface StubRequest {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role: string; content: unknown }>;
  response_format?: unknown;
  tools?: unknown[];
}

export type StubScript = (request: StubRequest) => StubReply | null;

/** The text of one message's content, image parts as `[image]`. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const p = part as { type?: string; text?: string };
      if (p.type === "text") return p.text ?? "";
      if (p.type === "image_url") return "[image]";
      return "";
    })
    .join("");
}

function hasImage(request: StubRequest): boolean {
  return (request.messages ?? []).some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some(
        (p) => typeof p === "object" && p !== null && (p as { type?: string }).type === "image_url",
      ),
  );
}

function wantsJson(request: StubRequest): boolean {
  if (request.response_format !== undefined) return true;
  return (request.messages ?? []).some(
    (m) =>
      m.role === "system" &&
      /\bJSON\b/.test(contentText(m.content)) &&
      !/<feel>/.test(contentText(m.content)),
  );
}

/** What came after her last reply in the request: the lines she is answering now. */
export function lastUserText(request: StubRequest): string {
  const messages = request.messages ?? [];
  let at = messages.length;
  while (at > 0 && messages[at - 1]?.role !== "assistant") at -= 1;
  return messages
    .slice(at)
    .filter((m) => m.role === "user")
    .map((m) => contentText(m.content))
    .join("\n");
}

/** The dev script: her two lines and a `<feel>` about `name`. */
export function devScript(name: string): StubScript {
  return (request) => {
    if (wantsJson(request)) return { text: "{}" };
    if (hasImage(request)) return { text: "我看到你的圖了" };
    const teased = lastUserText(request).includes("鬧");
    const feel = teased
      ? `<feel>\n我: 生氣 弱\n${name}: 羈絆 -3「又在鬧我」\n</feel>`
      : `<feel>\n我: 開心 中\n${name}: 羈絆 + 「記得答應我的事」\n</feel>`;
    return { text: `${feel}\n好呀,我在這裡。\n你今天過得怎麼樣?` };
  };
}

function chunk(model: string, delta: Record<string, unknown>, finish: string | null) {
  return {
    id: "stub",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

const USAGE = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };

function answer(res: ServerResponse, request: StubRequest, reply: StubReply): void {
  const model = request.model ?? "stub";
  const finish = "tool" in reply ? "tool_calls" : "stop";
  const toolCall =
    "tool" in reply
      ? {
          index: 0,
          id: `call_${reply.tool.name}`,
          type: "function",
          function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) },
        }
      : null;
  if (request.stream !== true) {
    const message =
      toolCall === null
        ? { role: "assistant", content: "text" in reply ? reply.text : "" }
        : { role: "assistant", content: null, tool_calls: [{ ...toolCall, index: undefined }] };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "stub",
        object: "chat.completion",
        created: 0,
        model,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: USAGE,
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
  send(chunk(model, { role: "assistant", content: "" }, null));
  if (toolCall !== null) send(chunk(model, { tool_calls: [toolCall] }, null));
  else send(chunk(model, { content: "text" in reply ? reply.text : "" }, null));
  send({ ...chunk(model, {}, finish), usage: USAGE });
  res.write("data: [DONE]\n\n");
  res.end();
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface LlmStub {
  url: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

/** Starts the stub on `host:port` (0: any free port). */
export async function startLlmStub(options: {
  port?: number;
  host?: string;
  script: StubScript;
}): Promise<LlmStub> {
  const requests: StubRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/requests") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(requests, null, 2));
        return;
      }
      if (req.method === "GET" && path === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "chat", object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || path !== "/v1/chat/completions") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "no such endpoint" } }));
        return;
      }
      let request: StubRequest;
      try {
        request = JSON.parse(await body(req)) as StubRequest;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "bad json" } }));
        return;
      }
      requests.push(request);
      answer(res, request, options.script(request) ?? { text: "嗯。" });
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---- run as a script ----------------------------------------------------------------------

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function isMain(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.replaceAll("\\", "/").endsWith("packages/api/dev/llm-stub.ts");
}

if (isMain()) {
  const args = process.argv.slice(2);
  const at = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let port = Number(at("--port") ?? Number.NaN);
  if (!Number.isInteger(port)) {
    try {
      const ports = JSON.parse(readFileSync(join(ROOT, ".dev", "room", "ports.json"), "utf8")) as {
        stub: number;
      };
      port = ports.stub;
    } catch {
      process.stderr.write("no port: run `room-dev.ts init` first, or pass --port\n");
      process.exit(1);
    }
  }
  const name = at("--name") ?? "測試小澄";
  const stub = await startLlmStub({ port, script: devScript(name) });
  process.stdout.write(`llm stub at ${stub.url} (requests: http://127.0.0.1:${port}/requests)\n`);
}
