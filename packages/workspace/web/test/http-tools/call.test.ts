// Calling a tool against a fake resolver and transport (no network): arguments, the guard,
// secrets, redirects, the answer's shape, and the module through the real gate.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActuatorRegistry, ActuatorRegistryKey, CapabilityError } from "@miyoria/gate/actions";
import { type ModuleContext, ServiceRegistry } from "@miyoria/runtime/kernel";
import { DATA_CLOSE, DATA_OPEN, MASKED, Principals } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  callHttpTool,
  type HttpRequest,
  HttpToolsConfigSchema,
  HttpToolsModule,
  type HttpTransport,
  parseHttpTool,
} from "../../src/http-tools/index.js";
import type { RawResponse } from "../../src/net.js";
import { resolver, response } from "../helpers.js";

const SECRET = "s3cr3t-value-123456";
const config = HttpToolsConfigSchema.parse({ secrets: ["WEATHER_KEY"] });
const env = (name: string) => (name === "WEATHER_KEY" ? SECRET : undefined);

const WEATHER = `
name = "weather_now"
description = "查某個城市現在的天氣"
risk = "low"
read_only = true
url = "https://api.example.com/v1/weather/{city}"
[params.city]
type = "string"
enum = ["Taipei", "Tokyo"]
[params.days]
type = "integer"
[params.metric]
type = "boolean"
[query]
units = "metric"
[headers]
Authorization = "Bearer {secret:WEATHER_KEY}"
X-Client = "miyoria"
[response]
pick = ["main.temp", "weather.0.description", "missing.path"]
`;

const WEATHER_JSON = JSON.stringify({
  main: { temp: 21.5, humidity: 80 },
  weather: [{ description: "多雲" }, { description: "x" }],
});

/** A transport answering with `answer`; records every request. */
function transport(
  answer: (request: HttpRequest) => RawResponse = () => response(200, WEATHER_JSON),
): HttpTransport & { calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const t = (async (request: HttpRequest) => {
    calls.push(request);
    return answer(request);
  }) as HttpTransport & { calls: HttpRequest[] };
  t.calls = calls;
  return t;
}

const signal = () => new AbortController().signal;

async function failure(run: Promise<unknown>): Promise<CapabilityError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(CapabilityError);
    return error as CapabilityError;
  }
  throw new Error("expected a failure");
}

describe("arguments", () => {
  const def = parseHttpTool(WEATHER, config);
  const call = (args: unknown) =>
    callHttpTool(def, args, signal(), {
      config,
      env,
      resolver: resolver(),
      transport: transport(),
    });

  it("refuses a missing required one, a wrong type, a value outside the enum and an unknown one", async () => {
    expect((await failure(call({}))).message).toBe("少了參數 city");
    expect((await failure(call({ city: 3 }))).message).toBe("參數 city 要是文字");
    expect((await failure(call({ city: "Taipei", days: 1.5 }))).message).toBe("參數 days 要是整數");
    expect((await failure(call({ city: "Taipei", metric: "yes" }))).message).toMatch(
      /true 或 false/,
    );
    expect((await failure(call({ city: "Paris" }))).message).toBe("參數 city 只能是:Taipei、Tokyo");
    expect((await failure(call({ city: "Taipei", town: "x" }))).message).toMatch(/不認得參數 town/);
  });

  it("refuses a path segment of `..`", async () => {
    const open = parseHttpTool(WEATHER.replace('enum = ["Taipei", "Tokyo"]', ""), config);
    const run = callHttpTool(open, { city: ".." }, signal(), {
      config,
      env,
      resolver: resolver(),
      transport: transport(),
    });
    expect((await failure(run)).message).toMatch(/「\.\.」/);
  });
});

describe("the request", () => {
  it("fills path and query, puts the secret in the header only, and pins the address", async () => {
    const t = transport();
    const def = parseHttpTool(WEATHER, config);
    const out = await callHttpTool(def, { city: "Tokyo", days: 2, metric: true }, signal(), {
      config,
      env,
      resolver: resolver({ "api.example.com": ["93.184.216.34"] }),
      transport: t,
    });
    expect(t.calls).toHaveLength(1);
    const req = t.calls[0] as HttpRequest;
    expect(req.method).toBe("GET");
    expect(req.url.href).toBe(
      "https://api.example.com/v1/weather/Tokyo?units=metric&days=2&metric=true",
    );
    expect(req.address).toEqual({ address: "93.184.216.34", family: 4 });
    expect(req.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(req.headers["x-client"]).toBe("miyoria");
    expect(req.body).toBeNull();
    expect(req.url.href).not.toContain(SECRET);
    // Several picks: an object keyed by path; a missing path is null.
    expect(JSON.parse(out.text)).toEqual({
      "main.temp": 21.5,
      "weather.0.description": "多雲",
      "missing.path": null,
    });
    expect(out.data).toBeNull();
  });

  it("encodes path values", async () => {
    const t = transport();
    const def = parseHttpTool(WEATHER.replace('enum = ["Taipei", "Tokyo"]', ""), config);
    await callHttpTool(def, { city: "新北/板橋?x=1" }, signal(), {
      config,
      env,
      resolver: resolver(),
      transport: t,
    });
    expect(t.calls[0]?.url.pathname).toBe(`/v1/weather/${encodeURIComponent("新北/板橋?x=1")}`);
    expect(t.calls[0]?.url.search).toBe("?units=metric");
  });

  it("never lets a secret through, even when the server echoes the request", async () => {
    // Raw JSON text: the second copy is written with a `\u` escape, as some servers do.
    const echo = transport((req) =>
      response(
        200,
        `{"you_sent":${JSON.stringify(req.headers.authorization)},` +
          `"escaped":"${SECRET.replace("-", "\\u002d")}",` +
          `"encoded":${JSON.stringify(encodeURIComponent(`Bearer ${SECRET}`))}}`,
      ),
    );
    const def = parseHttpTool(WEATHER.replace(/\[response\][\s\S]*$/, ""), config);
    const out = await callHttpTool(def, { city: "Taipei" }, signal(), {
      config,
      env,
      resolver: resolver(),
      transport: echo,
    });
    expect(out.text).not.toContain(SECRET);
    expect(out.text).not.toContain(encodeURIComponent(SECRET));
    expect(out.text).toContain(MASKED);
  });

  it("says which secret is missing, without a value", async () => {
    const t = transport();
    const def = parseHttpTool(WEATHER, config);
    const err = await failure(
      callHttpTool(def, { city: "Taipei" }, signal(), {
        config,
        env: () => "  ",
        resolver: resolver(),
        transport: t,
      }),
    );
    expect(err.message).toBe("這個工具的密鑰沒有設定(WEATHER_KEY)");
    expect(t.calls).toHaveLength(0);
  });

  it("refuses private addresses without connecting", async () => {
    const def = parseHttpTool(WEATHER, config);
    for (const address of ["10.0.0.5", "127.0.0.1"]) {
      const t = transport();
      const err = await failure(
        callHttpTool(def, { city: "Taipei" }, signal(), {
          config,
          env,
          resolver: resolver({ "api.example.com": ["93.184.216.34", address] }),
          transport: t,
        }),
      );
      expect(err.message).toMatch(/內部位址/);
      expect(t.calls).toHaveLength(0);
    }
  });

  it("refuses a literal private url without connecting", async () => {
    // Loading refuses it already; a def that skipped loading is refused again at call time.
    const good = parseHttpTool(WEATHER, config);
    const def = { ...good, url: "http://192.168.1.1/" };
    const t = transport();
    const err = await failure(
      callHttpTool(def, { city: "Taipei" }, signal(), {
        config,
        env,
        resolver: resolver(),
        transport: t,
      }),
    );
    expect(err.message).toMatch(/內部位址/);
    expect(t.calls).toHaveLength(0);
  });

  it("does not follow a redirect and reports other statuses by number only", async () => {
    const def = parseHttpTool(WEATHER, config);
    const redirect = response(302, "", { location: "https://evil.example.net/" });
    const t = transport(() => redirect);
    const err = await failure(
      callHttpTool(def, { city: "Taipei" }, signal(), {
        config,
        env,
        resolver: resolver(),
        transport: t,
      }),
    );
    expect(err.message).toMatch(/302/);
    expect(t.calls).toHaveLength(1);
    expect(redirect.destroyed).toBe(true);

    const denied = transport(() => response(401, `bad key ${SECRET}`));
    const err401 = await failure(
      callHttpTool(def, { city: "Taipei" }, signal(), {
        config,
        env,
        resolver: resolver(),
        transport: denied,
      }),
    );
    expect(err401.message).toBe("服務回了 401");
  });

  it("refuses an answer that is not JSON", async () => {
    const def = parseHttpTool(WEATHER, config);
    const err = await failure(
      callHttpTool(def, { city: "Taipei" }, signal(), {
        config,
        env,
        resolver: resolver(),
        transport: transport(() => response(200, "<html>")),
      }),
    );
    expect(err.message).toMatch(/JSON/);
  });
});

describe("bodies and answers", () => {
  const POST = `
name = "post_note"
description = "寫一則筆記"
method = "POST"
url = "https://api.example.com/notes"
[params.title]
type = "string"
required = true
[params.count]
type = "integer"
[params.tag]
type = "string"
in = "query"
`;

  it("sends body parameters as JSON by default", async () => {
    const t = transport(() => response(201, '{"id": 7}'));
    const def = parseHttpTool(POST, config);
    const out = await callHttpTool(def, { title: "嗨", count: 2, tag: "a" }, signal(), {
      config,
      resolver: resolver(),
      transport: t,
    });
    const req = t.calls[0] as HttpRequest;
    expect(req.method).toBe("POST");
    expect(req.url.search).toBe("?tag=a");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(req.body ?? new Uint8Array()))).toEqual({
      title: "嗨",
      count: 2,
    });
    expect(out.text).toBe('{"id":7}');
  });

  it("sends a form when the file says so", async () => {
    const t = transport(() => response(200, "{}"));
    const def = parseHttpTool(`${POST}\n[body]\nformat = "form"\n`, config);
    await callHttpTool(def, { title: "a b&c", count: 3 }, signal(), {
      config,
      resolver: resolver(),
      transport: t,
    });
    const req = t.calls[0] as HttpRequest;
    expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(new TextDecoder().decode(req.body ?? new Uint8Array())).toBe("title=a+b%26c&count=3");
  });

  it("picks one nested path and array index as the value itself", async () => {
    const def = parseHttpTool(
      `name = "w"\ndescription = "d"\nurl = "https://api.example.com/w"\n[response]\npick = "weather.0.description"\n`,
      config,
    );
    const out = await callHttpTool(def, {}, signal(), {
      config,
      resolver: resolver(),
      transport: transport(),
    });
    expect(out.text).toBe("多雲");
  });

  it("cuts a long text answer at max_chars with a note", async () => {
    const def = parseHttpTool(
      `name = "t"\ndescription = "d"\nurl = "https://api.example.com/t"\n[response]\nformat = "text"\nmax_chars = 100\n`,
      config,
    );
    const out = await callHttpTool(def, {}, signal(), {
      config,
      resolver: resolver(),
      transport: transport(() => response(200, "字".repeat(250))),
    });
    expect(out.text.startsWith("字".repeat(100))).toBe(true);
    expect(out.text).not.toContain("字".repeat(101));
    expect(out.text).toMatch(/後面還有 150 字/);
  });
});

describe("module", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function rig(raw: Record<string, unknown>, files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "http-tools-mod-"));
    made.push(dir);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const services = new ServiceRegistry();
    const registered = new Map<string, unknown>();
    const registry = new ActuatorRegistry({
      services,
      builtins: false,
      tools: {
        register: (t: { spec: { name: string } }) => registered.set(t.spec.name, t),
        get: (n: string) => registered.get(n),
        unregister: (n: string) => registered.delete(n),
      } as never,
    });
    services.provide("actions", ActuatorRegistryKey, registry);
    const warnings: unknown[] = [];
    const quiet = () => undefined;
    const ctx = {
      services,
      config: (schema: { parse(v: unknown): unknown }) => schema.parse(raw),
      log: { warn: (o: unknown) => warnings.push(o), info: quiet, debug: quiet, error: quiet },
    } as unknown as ModuleContext;
    return { dir, ctx, registry, registered, warnings, services };
  }

  it("registers each tool as a gated capability whose answer is framed", async () => {
    const r = rig(
      { dirs: ["."], secrets: ["WEATHER_KEY"] },
      { "weather.toml": WEATHER, "bad.toml": WEATHER.replace("WEATHER_KEY", "OTHER") },
    );
    const t = transport();
    const m = new HttpToolsModule({
      baseDir: r.dir,
      resolver: resolver(),
      transport: t,
      env,
      extensionDirs: () => [{ extension: "demo", dir: join(r.dir, "nothing-here") }],
    });
    expect(m.manifest.id).toBe("http_tools");
    await m.start(r.ctx);
    expect(r.warnings).toHaveLength(1);
    expect(JSON.stringify(r.warnings)).not.toContain(SECRET);
    expect(r.registered.has("weather_now")).toBe(true);

    const outcome = await r.registry.invoke({
      principal: Principals.self(null),
      capability: "http.weather_now",
      args: { city: "Taipei" },
      why: null,
      turn: null,
    });
    expect(outcome.status).toBe("done");
    if (outcome.status !== "done") return;
    // `safeName` writes the attribute's `:` as `∶`.
    expect(outcome.result.text).toMatch(new RegExp(`^${DATA_OPEN} source="http.weather_now"`));
    expect(outcome.result.text.trim().endsWith(DATA_CLOSE)).toBe(true);
    expect(outcome.result.text).toContain("多雲");
    expect(outcome.result.text).not.toContain(SECRET);
    expect(t.calls).toHaveLength(1);

    const bad = await r.registry.invoke({
      principal: Principals.self(null),
      capability: "http.weather_now",
      args: { city: "Paris" },
      why: null,
      turn: null,
    });
    expect(bad.status).toBe("denied");
    expect(t.calls).toHaveLength(1);

    await m.stop();
    expect(r.registered.has("weather_now")).toBe(false);
  });

  it("does nothing when disabled", async () => {
    const r = rig({ enabled: false, dirs: ["."], secrets: ["WEATHER_KEY"] }, { "w.toml": WEATHER });
    const m = new HttpToolsModule({ baseDir: r.dir });
    await m.start(r.ctx);
    expect(r.registered.size).toBe(0);
  });
});
