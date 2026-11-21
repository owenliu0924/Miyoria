// The exchange's routes: who may call each, that the member's go away with the public side's
// switch, what they hand the exchange (the session's account, the body, a web order's key), how a
// refusal comes back, and that what a real service answers fits the contract (strict response
// checks over a real store). The exchange itself is `packages/play/exchange/test`.

import { contract, routeMeta } from "@miyoria/contracts/api";
import {
  ExchangeKey,
  ExchangeService,
  ExchangeStore,
  exchangeConfig,
  exchangeSchema,
} from "@miyoria/play/exchange";
import { openTestDb } from "@miyoria/store/testing";
import {
  AuthorizerKey,
  type ExchangeEntry,
  type ExchangeWallet,
  type PersonId,
} from "@miyoria/types";
import type { AnyRouter } from "@orpc/server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { exchangeAdminRpc, exchangeRpc } from "../src/exchange-routes.js";
import { rpcRoutes, tableRoutes } from "../src/rpc.js";
import type { ApiEnv } from "../src/state.js";

const MEMBER = { platform: "discord", id: "1" };
/** Monday 2026-11-23 11:30 local (UTC+8). */
const T0 = Date.UTC(2026, 10, 23, 3, 30);

class Wallet implements ExchangeWallet {
  readonly currency = "魚幣";
  readonly rows: { person: string; key: string; delta: number }[] = [
    { person: "p1", key: "fund", delta: 1000 },
  ];
  async member() {
    return { person: "p1", name: "小魚乾" };
  }
  async holder() {
    return { person: "p1", name: "小魚乾" };
  }
  async balance(person: PersonId) {
    return this.rows.filter((r) => r.person === person).reduce((t, r) => t + r.delta, 0);
  }
  async transferredIn() {
    return 0;
  }
  async post(person: PersonId, entries: readonly ExchangeEntry[]) {
    const first = entries[0];
    if (first && this.rows.some((r) => r.key === first.key))
      return { ok: true as const, balance: 0, duplicate: true };
    for (const e of entries) this.rows.push({ person, key: e.key, delta: e.delta });
    return { ok: true as const, balance: await this.balance(person), duplicate: false };
  }
  async posted(_person: PersonId, key: string) {
    return this.rows.some((r) => r.key === key);
  }
}

const dbs: { close(): void }[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function exchange(open = true) {
  const clock = { at: T0 };
  const raw = openTestDb({
    identity: true,
    plugins: [exchangeSchema],
    clock: { now: () => clock.at },
  });
  dbs.push(raw);
  const wallet = new Wallet();
  const service = new ExchangeService({
    config: exchangeConfig({ open }),
    store: new ExchangeStore(raw.db),
    wallet: () => wallet,
    traders: {
      about: async () => ({ known_days: 30, tier: 1, insider: false, self: false }),
      name: async () => "小魚乾",
    },
    now: () => clock.at,
    log: { warn: () => undefined, info: () => undefined } as never,
    seed: "api-test",
  });
  return { service, wallet, clock };
}

function app(service: ExchangeService | null) {
  const state = {
    publicSide: { config: { enabled: true }, admitMember: () => null },
    optional: (key: unknown) => (key === AuthorizerKey ? { allows: () => true } : undefined),
    service: (key: unknown, what: string) => {
      if (key === ExchangeKey && service !== null) return service;
      throw ApiError.unavailable(`${what} is not available`);
    },
  };
  const table: AnyRouter = { exchange: exchangeRpc, exchangeAdmin: exchangeAdminRpc };
  const hono = new Hono<ApiEnv>();
  for (const r of tableRoutes(state as never, table, { responseCheck: "strict" })) {
    hono.on(r.method, r.path, async (c) => {
      if (r.member) c.set("member", { account: MEMBER } as never);
      try {
        return await r.handler(c);
      } catch (error) {
        return error instanceof ApiError
          ? error.toResponse()
          : ApiError.internal(error).toResponse();
      }
    });
  }
  return hono;
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});

describe("the exchange's routes", () => {
  it("are member routes, limited, and the owner's two changes need a node", () => {
    for (const name of Object.keys(contract.exchange)) {
      expect(routeMeta(contract, ["exchange", name])).toEqual({
        audience: "member",
        permission: null,
        limited: true,
      });
    }
    expect(routeMeta(contract, ["exchangeAdmin", "view"])).toEqual({
      audience: "admin",
      permission: null,
    });
    for (const name of ["pause", "sell"]) {
      expect(routeMeta(contract, ["exchangeAdmin", name])).toMatchObject({
        audience: "admin",
        permission: "admin.economy.adjust",
      });
    }
  });

  it("go away with the public side's switch, the owner's stay", () => {
    const off = { publicSide: { config: { enabled: false } }, optional: () => undefined };
    const paths = rpcRoutes(off as never).map((r) => r.path);
    expect(paths).not.toContain("/api/member/exchange");
    expect(paths).toContain("/api/exchange");
  });

  it("answer with views that fit the contract, open an account, quote, order once per key", async () => {
    const { service, wallet } = exchange();
    const hono = app(service);
    const market = await hono.request("/api/member/exchange");
    expect(market.status).toBe(200);
    expect((await market.json()).companies).toHaveLength(8);
    expect((await hono.request("/api/member/exchange/company/DPSK")).status).toBe(200);
    expect((await hono.request("/api/member/exchange/company/ZZZZ")).status).toBe(404);
    const account = await hono.request("/api/member/exchange/account", { method: "POST" });
    expect(await account.json()).toMatchObject({ opened: true, limits: { company: 270 } });
    const quote = await hono.request(
      "/api/member/exchange/quote",
      json({ side: "buy", company: "RICE", coins: 100 }),
    );
    expect(await quote.json()).toMatchObject({ coins: 100, fee: 2, margin: 98 });
    const order = () =>
      hono.request(
        "/api/member/exchange/order",
        json({ side: "buy", company: "RICE", coins: 100 }, { "idempotency-key": "abc" }),
      );
    const first = await order();
    expect(first.status).toBe(200);
    const again = await order();
    expect((await again.json()).id).toBe((await first.json()).id);
    expect(wallet.rows.filter((r) => r.key.startsWith("exchange:order:"))).toHaveLength(2);
    const port = await hono.request("/api/member/exchange/portfolio");
    expect((await port.json()).orders).toHaveLength(1);
    expect((await hono.request("/api/member/exchange/boards")).status).toBe(200);
    const hide = await hono.request("/api/member/exchange/visibility", json({ hide_boards: true }));
    expect(await hide.json()).toMatchObject({ hide_boards: true });
    expect((await hono.request("/api/exchange")).status).toBe(200);
  });

  it("bring a refusal back as its status and sentence", async () => {
    const { service } = exchange();
    const hono = app(service);
    const no = await hono.request(
      "/api/member/exchange/order",
      json({ side: "buy", company: "RICE", coins: 100 }),
    );
    expect(no.status).toBe(409);
    expect(await no.json()).toMatchObject({ error: "還沒開戶" });
    await hono.request("/api/member/exchange/account", { method: "POST" });
    const big = await hono.request(
      "/api/member/exchange/order",
      json({ side: "buy", company: "RICE", coins: 900 }),
    );
    expect(big.status).toBe(409);
    const lev = await hono.request("/api/member/exchange/leverage", json({ accept: false }));
    expect(lev.status).toBe(400);
    const pause = await hono.request("/api/exchange/pause", json({ paused: true }));
    expect(await pause.json()).toEqual({ paused: true, refunded: 0 });
    const closed = await hono.request(
      "/api/member/exchange/order",
      json({ side: "buy", company: "RICE", coins: 100 }),
    );
    expect(await closed.json()).toMatchObject({ error: "交易所現在暫停,不能下單" });
  });

  it("is a 503 naming the module without it", async () => {
    const response = await app(null).request("/api/member/exchange");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "exchange module is not available" });
  });
});
