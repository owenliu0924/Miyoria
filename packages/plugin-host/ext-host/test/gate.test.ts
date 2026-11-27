// An extension's tools through the gate, end to end with the fixture extension: they are
// capabilities `ext.<id>.<wire>` under their old tool names, members she knows well enough may
// use them, the owner always, each call is counted and audited, `on_own` keeps the bond rule,
// high risk waits for a review; and the extension's own schedules.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORK_BOND } from "@miyoria/commands";
import {
  ActuatorRegistry,
  ActuatorRegistryKey,
  CapabilityTool,
  REVIEW_PENDING,
  WORK_BELOW_BOND,
} from "@miyoria/gate/actions";
import { type ToolContext, ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import {
  Config,
  EventBus,
  ServiceRegistry,
  type Subscription,
  Supervisor,
  SupervisorKey,
  sleep,
} from "@miyoria/runtime/kernel";
import { AuditLogKey, openStore, SettingsStoreKey, type Store } from "@miyoria/store";
import {
  type AccountRef,
  type Attitude,
  AuthorizerKey,
  BaseAuthorizer,
  type ContextKey,
  type JsonObject,
  type JsonValue,
  newId,
  type Principal,
  Principals,
  SocialSignalsKey,
  type Subject,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { discover } from "../src/index.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const EXT = "ext.test.fixture";

const CTX: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const OWNER: AccountRef = { platform: "discord", id: "900" };
const MEMBER: AccountRef = { platform: "discord", id: "201" };
const NEWCOMER: AccountRef = { platform: "discord", id: "202" };

/** The owner holds every node; members hold `work.bond`; nobody else anything. */
class Roles extends BaseAuthorizer {
  allowsSubject(subject: Subject, node: string): boolean {
    if (subject.account.id === OWNER.id) return true;
    return node === WORK_BOND && [MEMBER.id, NEWCOMER.id].includes(subject.account.id);
  }
}

function attitude(affinity: number): Attitude {
  return {
    person: `p${affinity}`,
    affinity,
    trust: 50,
    familiarity: 50,
    blocked: false,
    label: "朋友",
    call_name: null,
  };
}

/** The member is well past `work_min_bond` (15); the newcomer is not. */
const social = {
  attitude: (a: AccountRef) =>
    a.id === MEMBER.id ? attitude(40) : a.id === NEWCOMER.id ? attitude(3) : null,
};

interface Harness {
  sup: Supervisor;
  bus: EventBus;
  tools: ToolRegistry;
  actuators: ActuatorRegistry;
  store: Store;
}

const running: Harness[] = [];

afterEach(async () => {
  for (const h of running.splice(0)) await h.sup.stopAll();
});

async function harness(extra = ""): Promise<Harness> {
  const config = Config.fromToml(
    `[modules.extensions]\ndirs = [${JSON.stringify(join(FIXTURES, "test-ext"))}]\ninit_timeout_ms = 5000\ncall_timeout_ms = 2000\nshutdown_grace_ms = 500\n[extensions."test.fixture"]\ngated_tools = true\n${extra}`,
  );
  const bus = new EventBus();
  const services = new ServiceRegistry();
  const sup = new Supervisor({ bus, services });
  const store = await openStore("memory://");
  const tools = new ToolRegistry();
  services.provide("app", ToolRegistryKey, tools);
  services.provide("app", SettingsStoreKey, store.settings);
  services.provide("app", AuditLogKey, store.audit);
  services.provide("app", AuthorizerKey, new Roles());
  services.provide("app", SocialSignalsKey, social);
  services.provide("app", SupervisorKey, sup);
  const actuators = new ActuatorRegistry({ services, tools, builtins: false });
  services.provide("app", ActuatorRegistryKey, actuators);
  for (const m of discover(config, FIXTURES).modules) {
    await sup.register(m.module, m.config, m.enabled);
  }
  await sup.startAll();
  const h = { sup, bus, tools, actuators, store };
  running.push(h);
  await eventually(() => sup.list().find((m) => m.id === EXT)?.state === "running");
  return h;
}

async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error("condition not met in time");
}

function toolCtx(principal: Principal): ToolContext {
  const account = principal.requester ?? OWNER;
  return {
    turn: newId(),
    context: CTX,
    account,
    principal,
    message: { context: CTX, id: "m1" },
    priority: "direct",
    signal: new AbortController().signal,
  };
}

function capabilityTool(h: Harness, name: string): CapabilityTool {
  const tool = h.tools.get(name);
  if (!(tool instanceof CapabilityTool)) throw new Error(`${name} is not a capability tool`);
  return tool;
}

/** The text between the data block's tags. */
function unframe(text: string): string {
  const match = /^<data [^>]*>\n([\s\S]*)\n<\/data>$/u.exec(text);
  if (!match) throw new Error(`not a data block: ${text}`);
  return match[1] as string;
}

const invoke = (h: Harness, capability: string, principal: Principal, args: JsonValue = {}) =>
  h.actuators.invoke({ principal, capability, args, why: null, turn: null });

describe("extension tools behind the gate", { timeout: 30_000 }, () => {
  it("are capabilities ext.<id>.<wire> under their old tool names, medium risk unless said", async () => {
    const h = await harness();
    const echo = h.actuators.get("ext.test.fixture.echo.say");
    expect(echo).toMatchObject({
      risk: "medium",
      permission: "tools.ext.test.fixture",
      work: true,
    });
    expect(capabilityTool(h, "echo_say").framed).toBe(true);
    expect(h.actuators.get("ext.test.fixture.look.up")?.risk).toBe("low");
    expect(capabilityTool(h, "look_up").readOnly).toBe(true);
    expect(h.actuators.get("ext.test.fixture.risky.do")?.risk).toBe("high");
    // Disabling the extension takes its capabilities away.
    await h.sup.disable(EXT);
    expect(h.actuators.get("ext.test.fixture.echo.say")).toBeUndefined();
    expect(h.tools.get("echo_say")).toBeUndefined();
  });

  it("a member at work_min_bond and the owner may ask; a newcomer hears why not", async () => {
    const h = await harness();
    const member = await invoke(h, "ext.test.fixture.echo.say", Principals.user(MEMBER, CTX), {
      text: "hi",
    });
    expect(member.status === "done" && unframe(member.result.text)).toBe("echo: hi from 201");
    const owner = await invoke(h, "ext.test.fixture.echo.say", Principals.user(OWNER, CTX), {
      text: "yo",
    });
    expect(owner.status).toBe("done");
    const newcomer = await invoke(h, "ext.test.fixture.echo.say", Principals.user(NEWCOMER, CTX));
    expect(newcomer).toMatchObject({
      status: "denied",
      decision: { stage: "permission", reason: WORK_BELOW_BOND },
    });
    // As a tool call, with `on_own`: still the newcomer's work, still the bond.
    const own = await capabilityTool(h, "echo_say").result(
      toolCtx(Principals.user(NEWCOMER, CTX)),
      { text: "x", on_own: true },
    );
    expect(own).toMatchObject({ ok: false, code: "denied", stage: "permission" });
    // Her own idea with nobody asking is hers to make.
    const alone = await invoke(h, "ext.test.fixture.echo.say", Principals.self(CTX), {
      text: "me",
    });
    expect(alone.status === "done" && unframe(alone.result.text)).toBe("echo: me from self");
  });

  it("passes who asked and where to the extension", async () => {
    const h = await harness();
    const out = await capabilityTool(h, "look_up").call(toolCtx(Principals.user(MEMBER, CTX)), {});
    expect(unframe(out)).toBe("looked for 201 in c1");
  });

  it("holds a tool to its declared limits and audits every call", async () => {
    const h = await harness();
    const ping = () => invoke(h, "ext.test.fixture.limited.ping", Principals.user(MEMBER, CTX));
    expect((await ping()).status).toBe("done");
    expect(await ping()).toMatchObject({ status: "denied", decision: { stage: "rate" } });
    const audit = await h.store.audit.recent(20, null);
    expect(
      audit.filter((a) => a.action === "gate.ext.test.fixture.limited.ping").map((a) => a.ok),
    ).toEqual([false, true]);
  });

  it("the owner's risk wins over the extension's", async () => {
    const h = await harness('tools."limited.ping".risk = "low"\n');
    expect(h.actuators.get("ext.test.fixture.limited.ping")?.risk).toBe("low");
    const ping = () => invoke(h, "ext.test.fixture.limited.ping", Principals.user(MEMBER, CTX));
    expect((await ping()).status).toBe("done");
    expect((await ping()).status).toBe("done");
  });

  it("a high-risk tool goes to her review instead of running", async () => {
    const h = await harness();
    const out = await capabilityTool(h, "risky_do").call(toolCtx(Principals.user(OWNER, CTX)), {});
    expect(out).toBe(REVIEW_PENDING);
  });
});

describe("extension schedules", { timeout: 30_000 }, () => {
  const scheduleTry = async (h: Harness, method: string, params: JsonObject) => {
    const out = await invoke(h, "ext.test.fixture.schedule.try", Principals.self(CTX), {
      method,
      params,
    });
    if (out.status !== "done") throw new Error(`schedule.try: ${out.status}`);
    return unframe(out.result.text);
  };

  it("set, list, fire once, cancel; kept in the settings store", async () => {
    const h = await harness();
    const fired: Subscription = h.bus.subscribe(["ext.test.fixture.fired"]);
    const daily = JSON.parse(
      await scheduleTry(h, "schedule.set", { id: "morning", daily: "08:00", payload: { n: 1 } }),
    ) as JsonObject;
    expect(daily).toMatchObject({ id: "morning", daily: "08:00", payload: { n: 1 } });
    expect(typeof daily.next).toBe("number");
    const saved = await h.store.settings.get("default", "ext:test.fixture:schedule:morning");
    expect(saved).toMatchObject({ id: "morning", daily: "08:00" });

    await scheduleTry(h, "schedule.set", { id: "now", at: Date.now() - 1000, payload: "go" });
    const env = await Promise.race([fired.recv(), sleep(5000).then(() => null)]);
    expect(env?.data).toMatchObject({ id: "now", payload: "go" });
    await eventually(async () => {
      const list = JSON.parse(await scheduleTry(h, "schedule.list", {})) as {
        schedules: JsonObject[];
      };
      return list.schedules.map((s) => s.id).join(",") === "morning";
    });
    expect(await h.store.settings.get("default", "ext:test.fixture:schedule:now")).toBeNull();

    expect(await scheduleTry(h, "schedule.cancel", { id: "morning" })).toBe('{"cancelled":true}');
    expect(await h.store.settings.get("default", "ext:test.fixture:schedule:morning")).toBeNull();
  });

  it("refuses a schedule with both or neither time, a big payload, and the 33rd", async () => {
    const h = await harness();
    expect(await scheduleTry(h, "schedule.set", { id: "x", at: 1, daily: "08:00" })).toMatch(
      /^refused: -32602/,
    );
    expect(await scheduleTry(h, "schedule.set", { id: "x" })).toMatch(/^refused: -32602/);
    expect(
      await scheduleTry(h, "schedule.set", { id: "x", daily: "08:00", payload: "x".repeat(5000) }),
    ).toMatch(/^refused: -32602/);
    for (let i = 0; i < 32; i++) {
      await scheduleTry(h, "schedule.set", { id: `s${i}`, daily: "08:00" });
    }
    expect(await scheduleTry(h, "schedule.set", { id: "s32", daily: "08:00" })).toMatch(
      /at most 32/,
    );
    // Replacing one it has is not a new one.
    expect(await scheduleTry(h, "schedule.set", { id: "s0", daily: "09:00" })).toContain(
      '"daily":"09:00"',
    );
  });
});
