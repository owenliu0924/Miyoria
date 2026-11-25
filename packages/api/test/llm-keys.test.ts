// `/api/llm/keys`: provider keys added from the panel, against a real in-memory store, the real
// `llm` module and a fake provider API (no network). A key's value never comes back out.

import type { LlmKeyRow, LlmKeysView, LlmKeyTestResult } from "@miyoria/contracts/api";
import {
  LlmConfigSchema,
  LlmModule,
  LlmRouterKey,
  OpenAiConfig,
  OpenAiProvider,
  PANEL_KEYS_PLUGIN,
  PANEL_KEYS_STATE,
  type ProviderFactory,
  userMessage,
} from "@miyoria/llm/llm";
import { Supervisor, SupervisorKey } from "@miyoria/runtime/kernel";
import { AuditLogKey, ProfileDataStoreKey, SqliteStore, StoreKey } from "@miyoria/store";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiModule } from "../src/index.js";
import { raw } from "./support/http.js";

const TOKEN = "test-token";
const P = "deepseek-chan";
const CONFIG_KEY = "key-config-one-made-up";
const PANEL_KEY = "key-panel-two-made-up-0123456789";
const REFUSED_KEY = "key-refused-three-made-up";

const REPLY =
  'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

const sups: Supervisor[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
  for (const s of stores.splice(0)) await s.close();
});

async function harness(store?: SqliteStore) {
  const db = store ?? (await SqliteStore.open(":memory:"));
  if (!store) stores.push(db);
  const sent: string[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const key = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
    sent.push(key);
    if (key === REFUSED_KEY) return new Response(`invalid key ${key}`, { status: 401 });
    return new Response(REPLY, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const factory: ProviderFactory = {
    kinds: ["openai-compatible"],
    build: (name, cfg) => {
      const config = OpenAiConfig.fromProviderConfig(cfg);
      config.retryBackoffMs = 0;
      return new OpenAiProvider(name, config, { fetch });
    },
  };
  const config = LlmConfigSchema.parse({
    providers: {
      p: { kind: "openai-compatible", base_url: "http://provider.invalid/v1", api_key: CONFIG_KEY },
    },
    purposes: { chat: ["p:model-a"] },
    call_log: { enabled: false },
  });
  const sup = new Supervisor();
  sups.push(sup);
  const s = sup.services;
  s.provide("kernel", SupervisorKey, sup);
  s.provide("kernel", ActiveProfileKey, P);
  s.provide("kernel", StoreKey, db);
  s.provide("kernel", AuditLogKey, db.audit);
  s.provide("kernel", ProfileDataStoreKey, db.profileData);
  await sup.register(new LlmModule(config, [factory]), null, true);
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");
  const call = (method: string, path: string, body?: unknown) =>
    raw(base, method, path, { token: TOKEN, ...(body === undefined ? {} : { json: body }) });
  const ask = async () => {
    const router = sup.services.require(LlmRouterKey);
    await router.complete("chat", { messages: [userMessage("hi")] });
  };
  const audit = async () =>
    (await db.audit.recent(50, "api")).filter((e) => e.action.startsWith("llm.key."));
  return { db, sent, call, ask, audit };
}

/** Whether any response, audit entry or stored copy outside the keys' own row holds a key. */
function leaks(text: string): boolean {
  return [CONFIG_KEY, PANEL_KEY, REFUSED_KEY].some((k) => text.includes(k));
}

describe("/api/llm/keys", () => {
  it("lists the config file's key read-only, never its value", async () => {
    const h = await harness();
    const r = await h.call("GET", "/api/llm/keys");
    expect(r.status).toBe(200);
    const view = r.body as LlmKeysView;
    expect(view.providers).toMatchObject([
      {
        provider: "p",
        editable: true,
        test_model: "model-a",
        breaker: null,
        keys: [{ id: "config:1", position: 1, source: "config", state: "ok", hint: null }],
      },
    ]);
    expect(leaks(r.text)).toBe(false);
  });

  it("adds a key the next request uses, and deletes it so the next does not", async () => {
    const h = await harness();
    const added = await h.call("POST", "/api/llm/keys/p", { key: PANEL_KEY, label: "朋友的訂閱" });
    expect(added.status).toBe(200);
    const row = added.body as LlmKeyRow;
    expect(row).toMatchObject({ position: 2, label: "朋友的訂閱", source: "panel", hint: "…6789" });
    expect(leaks(added.text)).toBe(false);
    await h.ask();
    await h.ask();
    expect(h.sent.sort()).toEqual([CONFIG_KEY, PANEL_KEY].sort());

    const off = await h.call("POST", `/api/llm/keys/p/${row.id}/disable`);
    expect(off.body).toMatchObject({ state: "disabled", position: null });
    const on = await h.call("POST", `/api/llm/keys/p/${row.id}/enable`);
    expect(on.body).toMatchObject({ state: "ok", position: 2 });

    const gone = await h.call("DELETE", `/api/llm/keys/p/${row.id}`);
    expect(gone.body).toEqual({ deleted: true });
    h.sent.length = 0;
    await h.ask();
    await h.ask();
    expect(h.sent).toEqual([CONFIG_KEY, CONFIG_KEY]);
    const list = await h.call("GET", "/api/llm/keys");
    expect((list.body as LlmKeysView).providers[0]?.keys.map((k) => k.id)).toEqual(["config:1"]);

    // Every change is audited by who, which provider and which key, never its value.
    const audit = await h.audit();
    expect(audit.map((e) => [e.action, e.ok, e.target]).reverse()).toEqual([
      ["llm.key.add", true, "llm:p"],
      ["llm.key.disable", true, "llm:p"],
      ["llm.key.enable", true, "llm:p"],
      ["llm.key.delete", true, "llm:p"],
    ]);
    expect(audit.find((e) => e.action === "llm.key.add")?.detail).toMatchObject({
      provider: "p",
      id: row.id,
      position: 2,
      label: "朋友的訂閱",
    });
    // Who: the admin token here (`api`), a session's account otherwise.
    expect(audit.every((e) => e.actor === "api")).toBe(true);
    expect(leaks(JSON.stringify(audit))).toBe(false);
  });

  it("refuses bad, repeated and config keys with messages that do not echo them", async () => {
    const h = await harness();
    const cases: [unknown, number, string][] = [
      [{ key: "" }, 400, "金鑰是空的"],
      [{ key: "key with space-made-up" }, 400, "金鑰裡不能有空白或換行"],
      [{ key: CONFIG_KEY }, 409, "這把金鑰已經在設定檔裡了(#1)"],
      [{ key: 7 }, 422, ""],
      [{}, 422, ""],
    ];
    for (const [body, status, message] of cases) {
      const r = await h.call("POST", "/api/llm/keys/p", body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      if (message) expect((r.body as { error: string }).error).toBe(message);
      expect(leaks(r.text)).toBe(false);
      expect(r.text).not.toContain("key with space");
    }
    await h.call("POST", "/api/llm/keys/p", { key: PANEL_KEY });
    const twice = await h.call("POST", "/api/llm/keys/p", { key: PANEL_KEY });
    expect(twice.status).toBe(409);
    expect(leaks(twice.text)).toBe(false);
    expect((await h.call("POST", "/api/llm/keys/nope", { key: PANEL_KEY })).status).toBe(404);
    expect((await h.call("DELETE", "/api/llm/keys/p/config:1")).status).toBe(400);
    expect((await h.call("POST", "/api/llm/keys/p/panel:nope/disable")).status).toBe(404);
    const refused = (await h.audit()).filter((e) => !e.ok);
    expect(refused.length).toBeGreaterThan(0);
    expect(leaks(JSON.stringify(refused))).toBe(false);
  });

  it("tests a key with one request and says why it failed", async () => {
    const h = await harness();
    const ok = await h.call("POST", "/api/llm/keys/p/config:1/test");
    expect(ok.body as LlmKeyTestResult).toMatchObject({ ok: true, kind: null, model: "model-a" });
    const bad = (await h.call("POST", "/api/llm/keys/p", { key: REFUSED_KEY })).body as LlmKeyRow;
    h.sent.length = 0;
    const refused = await h.call("POST", `/api/llm/keys/p/${bad.id}/test`);
    expect(refused.body).toMatchObject({ ok: false, kind: "auth", status: 401 });
    expect(h.sent).toEqual([REFUSED_KEY]);
    expect(leaks(refused.text)).toBe(false);
    const tests = (await h.audit()).filter((e) => e.action === "llm.key.test");
    expect(tests.map((e) => (e.detail as { ok: boolean }).ok).sort()).toEqual([false, true]);
  });

  it("keeps the keys across a restart, out of the data export", async () => {
    const db = await SqliteStore.open(":memory:");
    stores.push(db);
    const first = await harness(db);
    await first.call("POST", "/api/llm/keys/p", { key: PANEL_KEY, label: "朋友" });
    for (const s of sups.splice(0)) await s.stopAll();

    const again = await harness(db);
    const list = (await again.call("GET", "/api/llm/keys")).body as LlmKeysView;
    expect(list.providers[0]?.keys.map((k) => [k.source, k.label, k.position])).toEqual([
      ["config", null, 1],
      ["panel", "朋友", 2],
    ]);
    await again.ask();
    await again.ask();
    expect(again.sent).toContain(PANEL_KEY);
    // Stored as it is (no at-rest encryption), in plugin state, which no data category exports.
    expect(JSON.stringify(db.config.state.get(PANEL_KEYS_PLUGIN, PANEL_KEYS_STATE))).toContain(
      PANEL_KEY,
    );
    const exported = await again.call("GET", "/api/data/export");
    expect(exported.status).toBe(200);
    expect(exported.text.length).toBeGreaterThan(100);
    expect(leaks(exported.text)).toBe(false);
  });
});
