// Several API keys for one provider, and the breaker that remembers which just failed: against
// a fake `fetch` (no network) and a hand-moved router clock.

import { MetricsRegistry } from "@miyoria/runtime/kernel";
import type { Clock } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  type ChatProvider,
  collectResponse,
  DEFAULT_KEY_BREAKER,
  type KeyAttempt,
  KeyPool,
  LlmRouter,
  llmMetrics,
  OpenAiConfig,
  OpenAiFactory,
  OpenAiProvider,
  ProviderConfigSchema,
  ProviderCoolingError,
  ProviderHttpError,
  ProviderTimeoutError,
  parseModelRef,
  usableKeys,
  userMessage,
} from "../src/index.js";

const REPLY =
  'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":100}}\n\n' +
  "data: [DONE]\n\n";

class FakeClock implements Clock {
  t = Date.parse("2026-11-25T00:00:00Z");
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

type Answer = "ok" | "hang" | "break" | { status: number; retryAfter?: string; body?: string };

/** A fake `fetch` answering by the key in `Authorization`; records the key of every request. */
function fakeApi(answer: (key: string, n: number) => Answer) {
  const sent: string[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const key = auth.replace(/^Bearer /, "");
    sent.push(key);
    const a = answer(key, sent.filter((k) => k === key).length);
    if (a === "hang") {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (a === "ok") {
      return new Response(REPLY, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (a === "break") {
      // Headers and a first chunk, then the connection drops.
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"index":0,"delta":{"content":"half"},"finish_reason":null}]}\n\n',
            ),
          );
          setTimeout(() => c.error(new Error("socket hang up")), 5);
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const headers: Record<string, string> = { "content-type": "text/plain" };
    if (a.retryAfter !== undefined) headers["retry-after"] = a.retryAfter;
    return new Response(a.body ?? "nope", { status: a.status, headers });
  };
  return { fetch, sent };
}

function provider(
  name: string,
  keys: string[],
  fetch: typeof globalThis.fetch,
  tweak: (c: OpenAiConfig) => void = () => undefined,
): OpenAiProvider {
  const config = new OpenAiConfig("http://provider.invalid/v1");
  config.apiKey = keys[0] ?? null;
  config.apiKeys = keys.slice(1);
  config.retryBackoffMs = 0;
  config.connectTimeoutMs = 30;
  tweak(config);
  return new OpenAiProvider(name, config, { fetch });
}

function rig(providers: ChatProvider[], chain: string[], clock = new FakeClock()) {
  const metrics = new MetricsRegistry();
  const router = new LlmRouter(
    new Map(providers.map((p) => [p.name, p])),
    new Map([["chat", chain.map(parseModelRef)]]),
    {
      clock,
      metrics,
      pricing: new Map([
        ["p:m", { input_per_mtok: 1, cached_input_per_mtok: null, output_per_mtok: 2 }],
      ]),
    },
  );
  const ask = async () => {
    const stream = await router.stream("chat", { messages: [userMessage("hi")] });
    const reply = await collectResponse(stream);
    return { stream, reply };
  };
  const last = () => {
    const call = router.calls.list({}, 1).items[0];
    if (!call) throw new Error("no call recorded");
    return call;
  };
  return { router, clock, metrics: llmMetrics(metrics), ask, last };
}

const keysOf = (router: LlmRouter, name: string) =>
  router.providerKeys().find((p) => p.provider === name)?.keys ?? [];

describe("api_keys", () => {
  it("adds keys after api_key, dropping blank ones and repeats", () => {
    expect(usableKeys("key-one", ["key-two", "", "  ", "key-one", "key-three", "key-two"])).toEqual(
      ["key-one", "key-two", "key-three"],
    );
    expect(usableKeys(null, [])).toEqual([]);
    expect(usableKeys("", ["key-two"])).toEqual(["key-two"]);
    const parsed = ProviderConfigSchema.parse({
      kind: "opencode",
      api_key: "",
      api_keys: ["key-one", "", "key-two"],
    });
    const config = OpenAiConfig.fromProviderConfig(parsed);
    expect(config.apiKey).toBe("key-one");
    expect(config.apiKeys).toEqual(["key-two"]);
    // Only an expanded-to-empty key is no key: opencode with keys only in api_keys builds.
    expect(new OpenAiFactory().build("o", parsed).keyCount).toBe(2);
    expect(() =>
      new OpenAiFactory().build(
        "o",
        ProviderConfigSchema.parse({ kind: "opencode", api_keys: [""] }),
      ),
    ).toThrow(/`api_key` \(or `api_keys`\) is required/);
    expect(JSON.stringify(config)).not.toContain("key-two");
  });

  it("reads the breaker settings from the provider table", () => {
    expect(ProviderConfigSchema.parse({ kind: "openai" }).breaker).toEqual(DEFAULT_KEY_BREAKER);
    expect(DEFAULT_KEY_BREAKER).toEqual({
      failures: 2,
      cooldownMs: 60_000,
      maxCooldownMs: 600_000,
      badKeyCooldownMs: 3_600_000,
    });
    const parsed = ProviderConfigSchema.parse({
      kind: "openai",
      breaker_failures: 3,
      breaker_cooldown_secs: 30,
      breaker_max_cooldown_secs: 300,
      bad_key_cooldown_secs: 7200,
    });
    expect(parsed.breaker).toEqual({
      failures: 3,
      cooldownMs: 30_000,
      maxCooldownMs: 300_000,
      badKeyCooldownMs: 7_200_000,
    });
    expect(parsed.extra).toEqual({});
    expect(() => ProviderConfigSchema.parse({ kind: "openai", breaker_failures: -1 })).toThrow();
  });
});

describe("several keys", () => {
  it("takes turns over the keys, and charges the same model whichever answered", async () => {
    const api = fakeApi(() => "ok");
    const { router, ask, last } = rig([provider("p", ["key-one", "key-two"], api.fetch)], ["p:m"]);
    for (let i = 0; i < 4; i++) await ask();
    expect(api.sent).toEqual(["key-one", "key-two", "key-one", "key-two"]);
    expect(last().keys).toEqual([{ provider: "p", key: 2, result: "ok", kind: null }]);
    const today = router.costReport().today;
    expect(Object.keys(today.models)).toEqual(["p:m"]);
    expect(today.models["p:m"]?.calls).toBe(4);
    expect(today.total_usd).toBeCloseTo((4 * (1000 * 1 + 100 * 2)) / 1e6);
  });

  it("moves a refused key's call to the next key and skips the bad key afterwards", async () => {
    const api = fakeApi((key) =>
      key === "key-one" ? { status: 401, body: "bad key key-one" } : "ok",
    );
    const { router, ask, last, metrics } = rig(
      [provider("p", ["key-one", "key-two"], api.fetch)],
      ["p:m"],
    );
    const { stream } = await ask();
    expect(stream.model).toBe("p:m");
    expect(stream.fallback).toBe(false);
    expect(api.sent).toEqual(["key-one", "key-two"]);
    const call = last();
    expect(call.keys).toEqual([
      { provider: "p", key: 1, result: "failed", kind: "auth" },
      { provider: "p", key: 2, result: "ok", kind: null },
    ]);
    expect(call.retries).toEqual(["HTTP 401 → 金鑰 #2"]);
    expect(metrics.errors.get({ model: "p:m", purpose: "chat", stage: "key", kind: "auth" })).toBe(
      1,
    );
    expect(keysOf(router, "p")).toMatchObject([
      { key: 1, state: "bad", last_error: "auth" },
      { key: 2, state: "ok", last_error: null },
    ]);
    await ask();
    await ask();
    // The bad key is not sent again, and the record says it was passed over.
    expect(api.sent).toEqual(["key-one", "key-two", "key-two", "key-two"]);
    expect(last().keys).toEqual([
      { provider: "p", key: 1, result: "skipped", kind: "bad" },
      { provider: "p", key: 2, result: "ok", kind: null },
    ]);
    expect(JSON.stringify(router.calls.list())).not.toMatch(/key-one|key-two/);
    expect(JSON.stringify(router.providerKeys())).not.toMatch(/key-one|key-two/);
  });

  it("never puts a key into an error message", async () => {
    const api = fakeApi((key) => ({ status: 401, body: `invalid api key: ${key}` }));
    const { ask, last } = rig([provider("p", ["key-one", "key-two"], api.fetch)], ["p:m"]);
    const error = await ask().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as Error).message).toBe("p (key #2): HTTP 401 Unauthorized: invalid api key: #2");
    expect(JSON.stringify(last())).not.toMatch(/key-one|key-two/);
  });

  it("uses a 429's Retry-After as the cooldown, at most the cap", async () => {
    const api = fakeApi((key) => (key === "key-one" ? { status: 429, retryAfter: "3600" } : "ok"));
    const { router, ask, clock } = rig([provider("p", ["key-one", "key-two"], api.fetch)], ["p:m"]);
    await ask();
    expect(api.sent).toEqual(["key-one", "key-two"]);
    expect(keysOf(router, "p")[0]).toMatchObject({
      state: "cooling",
      until: new Date(clock.now() + 600_000).toISOString(),
      last_error: "rate_limit",
    });
  });

  it("asks another key after a 400 and blames the refused key when that one gets through", async () => {
    const region = JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: "Model hosted outside your region for key-one",
      },
    });
    const api = fakeApi((key) => (key === "key-one" ? { status: 400, body: region } : "ok"));
    const { router, ask, last, metrics } = rig(
      [provider("p", ["key-one", "key-two"], api.fetch)],
      ["p:m"],
    );
    const { stream } = await ask();
    expect(stream.model).toBe("p:m");
    expect(api.sent).toEqual(["key-one", "key-two"]);
    expect(last()).toMatchObject({ status: "ok", retries: ["HTTP 400 → 金鑰 #2"] });
    expect(last().keys).toEqual([
      { provider: "p", key: 1, result: "failed", kind: "http_4xx" },
      { provider: "p", key: 2, result: "ok", kind: null },
    ]);
    expect(
      metrics.errors.get({ model: "p:m", purpose: "chat", stage: "key", kind: "http_4xx" }),
    ).toBe(1);
    expect(keysOf(router, "p")[0]).toMatchObject({
      state: "ok",
      failures: 1,
      last_error: "http_4xx",
      last_message: "Model hosted outside your region for #1",
    });
    // The next call starts on key two; the one after on key one, refused again: it cools.
    await ask();
    await ask();
    expect(api.sent).toEqual(["key-one", "key-two", "key-two", "key-one", "key-two"]);
    expect(keysOf(router, "p")[0]).toMatchObject({ state: "cooling", failures: 2 });
  });

  it("fails a request both keys refuse with the first refusal, blaming neither", async () => {
    const api = fakeApi(() => ({ status: 400, body: '{"error":{"message":"bad request"}}' }));
    const { router, ask, last, metrics } = rig(
      [provider("p", ["key-one", "key-two"], api.fetch)],
      ["p:m"],
    );
    const error = await ask().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect((error as ProviderHttpError).message).toMatch(/^p \(key #1\): HTTP 400 Bad Request/);
    expect((error as ProviderHttpError).detail).toBe("bad request");
    // Exactly two attempts, and both keys stay healthy.
    expect(api.sent).toEqual(["key-one", "key-two"]);
    expect(keysOf(router, "p").map((k) => [k.state, k.failures])).toEqual([
      ["ok", 0],
      ["ok", 0],
    ]);
    expect(last().keys.map((k) => [k.key, k.result, k.kind])).toEqual([
      [1, "failed", "http_4xx"],
      [2, "failed", "http_4xx"],
    ]);
    expect(
      metrics.errors.get({ model: "p:m", purpose: "chat", stage: "key", kind: "http_4xx" }),
    ).toBe(0);
  });

  it("fails a 400 at once with one key, as before", async () => {
    const api = fakeApi(() => ({ status: 400, body: "nope" }));
    const { router, ask } = rig([provider("p", ["key-one"], api.fetch)], ["p:m"]);
    await expect(ask()).rejects.toBeInstanceOf(ProviderHttpError);
    expect(api.sent).toEqual(["key-one"]);
    expect(keysOf(router, "p")[0]).toMatchObject({ state: "ok", failures: 0 });
  });

  it("counts a 402 against the key and moves to the next", async () => {
    const api = fakeApi((key) =>
      key === "key-one" ? { status: 402, body: '{"error":{"message":"quota used up"}}' } : "ok",
    );
    const { router, ask, last } = rig([provider("p", ["key-one", "key-two"], api.fetch)], ["p:m"]);
    await ask();
    expect(api.sent).toEqual(["key-one", "key-two"]);
    expect(last().keys[0]).toEqual({ provider: "p", key: 1, result: "failed", kind: "quota" });
    expect(keysOf(router, "p")[0]).toMatchObject({
      failures: 1,
      last_error: "quota",
      last_message: "quota used up",
    });
  });

  it("never switches keys once the stream started", async () => {
    const api = fakeApi((key) => (key === "key-one" ? "break" : "ok"));
    const { router } = rig([provider("p", ["key-one", "key-two"], api.fetch)], ["p:m"]);
    const stream = await router.stream("chat", { messages: [userMessage("hi")] });
    await expect(collectResponse(stream)).rejects.toThrow(/stream interrupted/);
    expect(api.sent).toEqual(["key-one"]);
  });

  it("does not multiply the waits of a hung provider by its keys", async () => {
    const api = fakeApi(() => "hang");
    const p = provider("p", ["key-one", "key-two", "key-three"], api.fetch, (c) => {
      c.connectRetries = 1;
      c.maxRetries = 2;
    });
    const error = await p.stream({ model: "m", messages: [userMessage("hi")] }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderTimeoutError);
    // `1 + connectRetries` connect timeouts in all, each on the next key.
    expect(api.sent).toEqual(["key-one", "key-two"]);
  });
});

describe("the breaker", () => {
  it("skips a provider that just hung and goes to the next model", async () => {
    const hung = fakeApi(() => "hang");
    const fine = fakeApi(() => "ok");
    const { router, ask, last, metrics, clock } = rig(
      [
        provider("p", ["key-one"], hung.fetch, (c) => {
          c.connectRetries = 1;
        }),
        provider("q", [], fine.fetch),
      ],
      ["p:m", "q:m"],
    );
    // The first call waits out both connect timeouts (as before), then falls back.
    expect((await ask()).stream.model).toBe("q:m");
    expect(hung.sent).toHaveLength(2);
    expect(keysOf(router, "p")[0]).toMatchObject({
      state: "cooling",
      until: new Date(clock.now() + 60_000).toISOString(),
      failures: 2,
      last_error: "connect_timeout",
    });
    // The next calls do not ask it at all.
    const { stream } = await ask();
    expect(stream.model).toBe("q:m");
    expect(stream.fallback).toBe(true);
    expect(hung.sent).toHaveLength(2);
    const call = last();
    expect(call.fallbacks).toEqual([
      {
        model: "p:m",
        error: `p: skipped, every API key is cooling down after recent failures (until ${new Date(clock.now() + 60_000).toISOString()})`,
        kind: "cooling",
      },
    ]);
    expect(call.keys).toEqual([{ provider: "p", key: 1, result: "skipped", kind: "cooling" }]);
    expect(
      metrics.errors.get({ model: "p:m", purpose: "chat", stage: "request", kind: "cooling" }),
    ).toBe(1);
    expect(
      metrics.errors.get({ model: "p:m", purpose: "chat", stage: "key", kind: "connect_timeout" }),
    ).toBe(2);

    // After the cooldown one call probes it; it fails again, so it cools for twice as long.
    clock.advance(60_000);
    expect(keysOf(router, "p")[0]?.state).toBe("ok");
    await ask();
    expect(hung.sent).toHaveLength(3);
    expect(keysOf(router, "p")[0]).toMatchObject({
      state: "cooling",
      until: new Date(clock.now() + 120_000).toISOString(),
    });
  });

  it("tries the least recently failed key once when nothing else is left", async () => {
    let up = false;
    const api = fakeApi(() => (up ? "ok" : "hang"));
    const { router, ask, last, clock } = rig(
      [
        provider("p", ["key-one", "key-two"], api.fetch, (c) => {
          c.connectRetries = 1;
        }),
      ],
      ["p:m"],
    );
    await expect(ask()).rejects.toBeInstanceOf(ProviderTimeoutError);
    clock.advance(1000);
    await expect(ask()).rejects.toBeInstanceOf(ProviderTimeoutError);
    // The second call starts on the other key.
    expect(api.sent).toEqual(["key-one", "key-two", "key-two", "key-one"]);
    expect(keysOf(router, "p").map((k) => k.state)).toEqual(["cooling", "cooling"]);
    clock.advance(1000);
    // Every key cooling and no other model: one attempt, on the key that failed longest ago.
    await expect(ask()).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(api.sent).toEqual(["key-one", "key-two", "key-two", "key-one", "key-one"]);
    expect(last().fallbacks.map((f) => f.kind)).toEqual(["cooling"]);
    up = true;
    clock.advance(1000);
    const { reply } = await ask();
    expect(reply.text).toBe("ok");
    expect(api.sent.at(-1)).toBe("key-two");
    // It answered: that key is closed again.
    expect(keysOf(router, "p").map((k) => k.state)).toEqual(["cooling", "ok"]);
  });

  it("does not wait on a provider twice in one call", async () => {
    const api = fakeApi(() => "hang");
    const { ask, last } = rig(
      [
        provider("p", ["key-one"], api.fetch, (c) => {
          c.connectRetries = 1;
        }),
      ],
      ["p:a", "p:b"],
    );
    await expect(ask()).rejects.toBeInstanceOf(ProviderTimeoutError);
    // p:a opened the key; p:b is skipped, with no last resort on what just hung.
    expect(api.sent).toHaveLength(2);
    expect(last().fallbacks.map((f) => [f.model, f.kind])).toEqual([["p:b", "cooling"]]);
  });

  it("keeps the breaker on a provider without keys", async () => {
    const api = fakeApi(() => ({ status: 503 }));
    const fine = fakeApi(() => "ok");
    const { router, ask, last } = rig(
      [provider("local", [], api.fetch, (c) => (c.maxRetries = 1)), provider("q", [], fine.fetch)],
      ["local:m", "q:m"],
    );
    await ask();
    expect(api.sent).toHaveLength(2);
    await ask();
    expect(api.sent).toHaveLength(2);
    expect(last().keys).toEqual([]);
    expect(router.providerKeys()).toMatchObject([
      {
        provider: "local",
        keyed: false,
        keys: [{ key: 1, state: "cooling", last_error: "http_5xx" }],
      },
      { provider: "q", keyed: false, keys: [{ key: 1, state: "ok" }] },
    ]);
  });
});

describe("KeyPool", () => {
  const settings = DEFAULT_KEY_BREAKER;
  const attempts: KeyAttempt[] = [];
  const onAttempt = (a: KeyAttempt) => attempts.push(a);

  /** One call: picks a key and reports `outcome` for it. */
  function call(pool: KeyPool, outcome: Parameters<ReturnType<KeyPool["chooser"]>["report"]>[1]) {
    const keys = pool.chooser(false, onAttempt);
    const key = keys.next();
    if (key !== null) keys.report(key, outcome);
    keys.close();
    return key;
  }

  it("opens after the failures in a row, backs off on failed probes up to the cap", () => {
    const clock = new FakeClock();
    const pool = new KeyPool("p", 1, settings, clock);
    const timeout = { type: "failed", failure: "connect_timeout" } as const;
    call(pool, timeout);
    expect(pool.usable()).toBe(true);
    call(pool, timeout);
    expect(pool.usable()).toBe(false);
    expect(pool.reopensAt()).toBe(clock.now() + 60_000);
    const cooldowns: number[] = [];
    for (let i = 0; i < 6; i++) {
      clock.advance((pool.reopensAt() ?? clock.now()) - clock.now());
      expect(pool.usable()).toBe(true);
      call(pool, timeout);
      cooldowns.push(((pool.reopensAt() ?? 0) - clock.now()) / 1000);
    }
    expect(cooldowns).toEqual([120, 240, 480, 600, 600, 600]);
    // A success closes it and starts the count over.
    clock.advance(600_000);
    call(pool, { type: "ok" });
    call(pool, timeout);
    expect(pool.usable()).toBe(true);
    expect(pool.status().keys[0]).toMatchObject({ state: "ok", failures: 1 });
  });

  it("lets one call probe a key whose cooldown passed", () => {
    const clock = new FakeClock();
    const pool = new KeyPool("p", 1, settings, clock);
    const timeout = { type: "failed", failure: "connect_timeout" } as const;
    call(pool, timeout);
    call(pool, timeout);
    clock.advance(60_000);
    const probe = pool.chooser(false, onAttempt);
    expect(probe.next()).toBe(0);
    // Meanwhile nobody else gets it.
    expect(pool.usable()).toBe(false);
    expect(pool.chooser(false, onAttempt).next()).toBeNull();
    probe.report(0, { type: "ok" });
    expect(pool.usable()).toBe(true);
    // A probe nobody reported (the call went away) does not keep the key claimed.
    call(pool, timeout);
    call(pool, timeout);
    clock.advance(60_000);
    const lost = pool.chooser(false, onAttempt);
    lost.next();
    lost.close();
    expect(pool.usable()).toBe(true);
  });

  it("counts nothing for a request refused for itself", () => {
    const pool = new KeyPool("p", 1, settings, new FakeClock());
    for (let i = 0; i < 5; i++) call(pool, { type: "ended", kind: "http_4xx" });
    expect(pool.status().keys[0]).toMatchObject({ state: "ok", failures: 0 });
  });

  it("is off with breaker_failures = 0", () => {
    const pool = new KeyPool("p", 1, { ...settings, failures: 0 }, new FakeClock());
    for (let i = 0; i < 5; i++) call(pool, { type: "failed", failure: "auth" });
    expect(pool.usable()).toBe(true);
  });

  it("names the provider, not a key, when every key is cooling", () => {
    expect(new ProviderCoolingError("p", null).message).toBe(
      "p: skipped, every API key is cooling down after recent failures",
    );
  });
});
