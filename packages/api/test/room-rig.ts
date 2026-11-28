// A fake `ApiState` for her room's unit tests (docs/design/her-room.md §7.2): only what the room's
// code reads of it, the services in a map, a clock the test moves, and what was published and
// logged, in order.

import { PeopleStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  AuthorizerKey,
  type KnownName,
  MouthKey,
  PlacesKey,
  PlatformSinks,
  PlatformSinksKey,
  ROOM_PLATFORM,
  SocialSignalsKey,
} from "@miyoria/types";
import { Hono } from "hono";
import { ApiError } from "../src/errors.js";
import { RoomConfigSchema } from "../src/room/config.js";
import { Room } from "../src/room/room.js";
import type { Route } from "../src/route.js";
import type { ApiEnv } from "../src/state.js";

export const ALICE: AccountRef = { platform: "discord", id: "1" };
export const BOB: AccountRef = { platform: "discord", id: "2" };
export const T0 = Date.UTC(2026, 10, 28, 4, 0, 0);
export const RUN = "run1";

const NAMES: Record<string, string> = { "1": "Alice", "2": "Bobby" };

/** The person she knows `account` as. */
export function personOf(account: AccountRef) {
  return {
    id: `p-${account.id}`,
    display_name: NAMES[account.id] ?? account.id,
    accounts: [{ account }],
  };
}

export interface Rig {
  state: {
    ctx: {
      services: { get(key: unknown): unknown; require(key: unknown): unknown };
      publish(event: { type: string }, data: unknown, meta?: unknown): void;
      clock: { now(): number };
      log: { warn(): void; info(): void; debug(): void };
    };
    room: Room | null;
    files: null;
    publicSide: unknown;
    auth: { sessions: { nameOf(account: AccountRef): string | null } };
    optional(key: unknown): unknown;
    now(): number;
    auditAs(...args: unknown[]): Promise<void>;
  };
  room: Room;
  services: Map<unknown, unknown>;
  clock: { t: number };
  /** Everything published, and the chat log's writes, in the order they happened. */
  order: string[];
  published: { type: string; data: unknown; meta?: unknown }[];
  blocked: Set<string>;
  /** Text moderation refuses on a page (`publicSide.passes`). */
  refused: Set<string>;
  sinks: PlatformSinks;
  /** Requests a member route answered (`stream`, `member`). */
  admitted: { member: number };
}

/** A room open to Alice and Bob, she is there (a mouth, the `web` sink), nothing else. */
export function makeRig(config: Record<string, unknown> = {}): Rig {
  const clock = { t: T0 };
  const services = new Map<unknown, unknown>();
  const order: string[] = [];
  const published: Rig["published"] = [];
  const blocked = new Set<string>();
  const refused = new Set<string>();
  const admitted = { member: 0 };
  const known: KnownName[] = [
    { name: "Alice", person: "p-1" as never, account: ALICE },
    { name: "Bobby", person: "p-2" as never, account: BOB },
  ];
  const sinks = new PlatformSinks();
  sinks.register({ platform: ROOM_PLATFORM } as never);
  services.set(PlatformSinksKey, sinks);
  services.set(MouthKey, {});
  services.set(AuthorizerKey, {
    allows: (_account: AccountRef, node: string) => !node.startsWith("owner."),
  });
  services.set(PlacesKey, { spacesOf: () => ["s1"] });
  services.set(PeopleStoreKey, { personByAccount: async (a: AccountRef) => personOf(a) });
  services.set(SocialSignalsKey, {
    attitude: (a: AccountRef) => ({ blocked: blocked.has(a.id) }),
  });
  const ctx: Rig["state"]["ctx"] = {
    services: {
      get: (key) => services.get(key),
      require: (key) => {
        const s = services.get(key);
        if (s === undefined) throw new Error("missing service");
        return s;
      },
    },
    publish: (event, data, meta) => {
      order.push(`publish:${event.type}`);
      published.push({ type: event.type, data, ...(meta === undefined ? {} : { meta }) });
    },
    clock: { now: () => clock.t },
    log: { warn: () => {}, info: () => {}, debug: () => {} },
  };
  let draws = 0;
  const room = new Room(RoomConfigSchema.parse({ enabled: true, ...config }), () => clock.t, {
    run: RUN,
    random: (n) => {
      draws += 1;
      return new Uint8Array(n).map((_, i) => (i * 37 + draws * 11) & 0xff);
    },
  });
  const state: Rig["state"] = {
    ctx,
    room,
    files: null,
    publicSide: {
      config: { enabled: true },
      admitMember: () => {
        admitted.member += 1;
        return null;
      },
      admit: () => null,
      client: () => "203.0.113.1",
      names: async () => known,
      passes: (_state: unknown, text: string) => ![...refused].some((r) => text.includes(r)),
    },
    auth: { sessions: { nameOf: () => null } },
    optional: (key) => services.get(key),
    now: () => clock.t,
    auditAs: async () => {},
  };
  return { state, room, services, clock, order, published, blocked, refused, sinks, admitted };
}

/** A session record for `account`. */
export function sessionOf(account: AccountRef) {
  return {
    account,
    name: NAMES[account.id] ?? account.id,
    avatar_url: null,
    tier: "member" as const,
    created_at: new Date(T0).toISOString(),
    expires_at: new Date(T0 + 86_400_000).toISOString(),
  };
}

/** A Hono app serving `routes` as `as.account`, errors answered as the shell does. */
export function appOf(routes: Route[], as: { account: AccountRef }): Hono<ApiEnv> {
  const hono = new Hono<ApiEnv>();
  for (const r of routes) {
    hono.on(r.method, r.path, async (c) => {
      if (r.member) c.set("member", sessionOf(as.account) as never);
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

/** Runs `fn` and gives back the `ApiError` it threw. */
export async function refusal(fn: () => Promise<unknown>): Promise<ApiError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** Lets pending promise callbacks run. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
