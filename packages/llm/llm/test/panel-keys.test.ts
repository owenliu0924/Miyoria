// API keys added in the panel: kept in plugin state, put into rotation at once, never shown.

import type { Clock, JsonValue } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  collectResponse,
  KeyManageError,
  type KeyStateStore,
  LlmKeys,
  LlmRouter,
  OpenAiConfig,
  OpenAiProvider,
  PANEL_KEYS_PLUGIN,
  PANEL_KEYS_STATE,
  parseModelRef,
  userMessage,
} from "../src/index.js";

const REPLY =
  'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

const LONG_KEY = "key-panel-0123456789-abcdWXYZ";

class FakeClock implements Clock {
  t = Date.parse("2026-11-25T00:00:00Z");
  now(): number {
    return this.t;
  }
}

class MemoryState implements KeyStateStore {
  readonly rows = new Map<string, JsonValue>();
  get(plugin: string, key: string) {
    const value = this.rows.get(`${plugin}/${key}`);
    return value === undefined ? null : { value };
  }
  set(plugin: string, key: string, value: JsonValue): void {
    this.rows.set(`${plugin}/${key}`, structuredClone(value));
  }
}

/** A fake API answering by key: `refuse` gets 401, the rest an answer. */
function fakeApi(refuse: ReadonlySet<string> = new Set()) {
  const sent: string[] = [];
  const bodies: Record<string, JsonValue>[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const key = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
    sent.push(key);
    bodies.push(JSON.parse(String(init?.body)));
    if (refuse.has(key)) return new Response(`bad key ${key}`, { status: 401 });
    return new Response(REPLY, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, sent, bodies };
}

function rig(configKeys: string[], options: { refuse?: string[]; state?: MemoryState } = {}) {
  const api = fakeApi(new Set(options.refuse ?? []));
  const config = new OpenAiConfig("http://provider.invalid/v1");
  config.apiKey = configKeys[0] ?? null;
  config.apiKeys = configKeys.slice(1);
  config.retryBackoffMs = 0;
  const clock = new FakeClock();
  const router = new LlmRouter(
    new Map([["p", new OpenAiProvider("p", config, { fetch: api.fetch })]]),
    new Map([["chat", [parseModelRef("p:model-a")]]]),
    { clock },
  );
  const state = options.state ?? new MemoryState();
  const keys = new LlmKeys(router, new Map([["p", configKeys]]), state, clock);
  keys.load();
  const ask = async () =>
    collectResponse(await router.stream("chat", { messages: [userMessage("hi")] }));
  return { api, router, keys, state, ask, clock };
}

const rows = (keys: LlmKeys) => keys.list()[0]?.keys ?? [];

describe("panel keys", () => {
  it("adds a key that the next request uses, and lists it without its value", async () => {
    const { api, keys, ask, state } = rig(["key-config-one"]);
    await ask();
    const row = keys.add("p", LONG_KEY, " 朋友的訂閱 ", "panel:discord:1");
    expect(row).toMatchObject({
      position: 2,
      label: "朋友的訂閱",
      source: "panel",
      state: "ok",
      added_at: "2026-11-25T00:00:00.000Z",
      hint: "…WXYZ",
    });
    await ask();
    await ask();
    // The next two requests take turns over both.
    expect(api.sent.slice(1).sort()).toEqual([LONG_KEY, "key-config-one"].sort());
    const listed = keys.list();
    expect(listed[0]).toMatchObject({ provider: "p", editable: true, test_model: "model-a" });
    expect(listed[0]?.keys.map((k) => [k.id.split(":")[0], k.source, k.position])).toEqual([
      ["config", "config", 1],
      ["panel", "panel", 2],
    ]);
    // A short key gets no hint.
    expect(listed[0]?.keys[0]?.hint).toBeNull();
    expect(JSON.stringify(listed)).not.toContain(LONG_KEY);
    expect(JSON.stringify(listed)).not.toContain("key-config-one");
    // Stored where the data export does not look, with the value (no at-rest encryption).
    expect(JSON.stringify(state.get(PANEL_KEYS_PLUGIN, PANEL_KEYS_STATE))).toContain(LONG_KEY);
  });

  it("refuses bad and repeated keys without echoing them", () => {
    const { keys } = rig(["key-config-one"]);
    const refusal = (value: unknown, label?: unknown) => {
      try {
        keys.add("p", value, label, "x");
      } catch (error) {
        expect(error).toBeInstanceOf(KeyManageError);
        return { code: (error as KeyManageError).code, message: (error as Error).message };
      }
      throw new Error("not refused");
    };
    expect(refusal("")).toEqual({ code: "invalid", message: "金鑰是空的" });
    expect(refusal("key with space")).toMatchObject({ code: "invalid" });
    expect(refusal("key-with-newline\n")).toMatchObject({ code: "invalid" });
    expect(refusal("金鑰-non-ascii")).toMatchObject({ code: "invalid" });
    expect(refusal(42)).toMatchObject({ code: "invalid" });
    expect(refusal("x".repeat(513))).toMatchObject({ code: "invalid" });
    expect(refusal("key-ok-ok", "x".repeat(41))).toMatchObject({ code: "invalid" });
    const dup = refusal("key-config-one");
    expect(dup).toEqual({ code: "duplicate", message: "這把金鑰已經在設定檔裡了(#1)" });
    keys.add("p", "key-panel-two", null, "x");
    expect(refusal("key-panel-two")).toEqual({
      code: "duplicate",
      message: "這把金鑰已經加過了(#2)",
    });
    expect(() => keys.add("nope", "key-x", null, "x")).toThrow(KeyManageError);
  });

  it("disables, enables and deletes a panel key; the config file's stay", async () => {
    const { api, keys, ask } = rig(["key-config-one"]);
    const added = keys.add("p", "key-panel-two", null, "x");
    expect(keys.setDisabled("p", added.id, true)).toMatchObject({
      state: "disabled",
      position: null,
    });
    await ask();
    await ask();
    expect(api.sent).toEqual(["key-config-one", "key-config-one"]);
    keys.setDisabled("p", added.id, false);
    await ask();
    await ask();
    expect(api.sent.slice(2).sort()).toEqual(["key-config-one", "key-panel-two"]);
    const gone = keys.remove("p", added.id);
    expect(gone).toMatchObject({ provider: "p", position: 2, source: "panel" });
    api.sent.length = 0;
    await ask();
    await ask();
    expect(api.sent).toEqual(["key-config-one", "key-config-one"]);
    expect(rows(keys).map((k) => k.id)).toEqual(["config:1"]);
    expect(() => keys.remove("p", "config:1")).toThrow("設定檔裡的金鑰只能在設定檔改");
    expect(() => keys.setDisabled("p", "panel:nope", true)).toThrow("沒有這把金鑰");
  });

  it("keeps the breaker state of the keys that stay", async () => {
    const { keys, ask, router } = rig(["key-config-one", "key-config-two"], {
      refuse: ["key-config-one"],
    });
    await ask();
    expect(router.keyStatus("p", "config:1")?.state).toBe("bad");
    keys.add("p", "key-panel-three", null, "x");
    expect(rows(keys).map((k) => [k.id.split(":")[0], k.state])).toEqual([
      ["config", "bad"],
      ["config", "ok"],
      ["panel", "ok"],
    ]);
  });

  it("brings the stored keys back at start", async () => {
    const state = new MemoryState();
    rig(["key-config-one"], { state }).keys.add("p", "key-panel-two", "朋友", "x");
    const again = rig(["key-config-one"], { state });
    expect(rows(again.keys).map((k) => [k.label, k.position])).toEqual([
      [null, 1],
      ["朋友", 2],
    ]);
    await again.ask();
    await again.ask();
    expect(again.api.sent).toEqual(["key-config-one", "key-panel-two"]);
  });

  it("tests a key with one one-token request, enabled or not", async () => {
    const { api, keys } = rig(["key-config-one"], { refuse: ["key-refused-1"] });
    const bad = keys.add("p", "key-refused-1", null, "x");
    keys.setDisabled("p", bad.id, true);
    expect(await keys.test("p", "config:1")).toMatchObject({
      ok: true,
      kind: null,
      model: "model-a",
    });
    const refused = await keys.test("p", bad.id);
    expect(refused).toMatchObject({ ok: false, kind: "auth", status: 401, model: "model-a" });
    expect(JSON.stringify(refused)).not.toContain("key-refused-1");
    expect(api.sent).toEqual(["key-config-one", "key-refused-1"]);
    expect(api.bodies[0]).toMatchObject({ model: "model-a", max_tokens: 1 });
    // A test is no request of hers: the breaker is left alone.
    expect(rows(keys).find((k) => k.id === bad.id)?.state).toBe("disabled");
    await expect(keys.test("p", "config:9")).rejects.toThrow("沒有這把金鑰");
  });

  it("lists keys but takes none without a store", () => {
    const api = fakeApi();
    const router = new LlmRouter(
      new Map([
        ["p", new OpenAiProvider("p", new OpenAiConfig("http://x.invalid"), { fetch: api.fetch })],
      ]),
      new Map(),
    );
    const keys = new LlmKeys(router, new Map(), null);
    expect(keys.list()).toEqual([
      {
        provider: "p",
        editable: false,
        test_model: null,
        keys: [],
        breaker: { state: "ok", until: null, failures: 0, last_error: null, last_error_at: null },
      },
    ]);
    expect(() => keys.add("p", "key-panel-x", null, "x")).toThrow("沒有資料庫,不能存金鑰");
  });
});
