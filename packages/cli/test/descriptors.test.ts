// Pins the descriptors to the launcher they replace; deleted with `buildPlan`.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Catalog, type CatalogEntry, loadCatalog } from "@miyoria/hostd";
import { Config } from "@miyoria/runtime/kernel";
import { beforeAll, describe, expect, it } from "vitest";
import { buildPlan, type ServiceSpec } from "../src/commands/up.js";
import { estimateVram } from "../src/stack/checks.js";
import { stackConfig, WORKER_DEFAULT_PORT, WORKER_DEFAULTS } from "../src/stack/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// The config is never read: only its path is given to the plan.
const configPath = join(root, "pin-test", "miyoria.toml");
// Silero makes the machine start the turn worker too.
const toml = `[machine]
roles = ["broadcast", "core", "inference"]
[modules.voice]
vad_engine = "silero"
`;

let catalog: Catalog;
let plan: ServiceSpec[];
const stack = stackConfig(Config.fromToml(toml, () => undefined));

beforeAll(() => {
  catalog = loadCatalog(root);
  plan = buildPlan({
    config: Config.fromToml(toml, () => undefined),
    configPath,
    stack,
    root,
    platform: "win32",
    env: {},
    nodeExec: { execPath: "node", execArgv: [], script: "main.js" },
  });
});

function entry(name: string): CatalogEntry {
  const found = catalog.services.get(name);
  if (found === undefined) throw new Error(`no descriptor for ${name}`);
  return found;
}

function spec(name: string): ServiceSpec {
  const found = plan.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no plan entry for ${name}`);
  return found;
}

describe("the workers", () => {
  it.each(["asr", "tts", "sing", "turn"])("%s matches its plan entry", (name) => {
    const { descriptor, dir } = entry(name);
    const run = descriptor.run;
    const s = spec(name);
    expect(run).toBeDefined();
    if (run === undefined) return;

    expect(run.port).toBe(WORKER_DEFAULT_PORT[name]);
    expect(run.port).toBe(s.port);
    // The entry file is the last element of the command; the interpreter is a placeholder.
    expect(run.command.at(-1)).toBe(s.args.at(-1));
    expect(run.command[0]).toBe("{python}");
    expect(resolve(dir)).toBe(resolve(s.cwd));
    expect(run.host_env).toBe("HOST");
    expect(run.port_env).toBe("PORT");
    expect(s.env.HOST).toBeDefined();
    expect(s.env.PORT).toBe(String(run.port));
    expect(new URL(s.health ?? "").pathname).toBe(run.health.http);
  });

  it.each(["asr", "tts", "sing", "turn"])("%s has the default environment", (name) => {
    const { descriptor, dir } = entry(name);
    const { VOICES_DIR, ...env } = descriptor.run?.env ?? {};
    expect(env).toEqual(WORKER_DEFAULTS[name]?.env);
    if (name === "tts") {
      // The plan fills VOICES_DIR itself; the descriptor says it with a placeholder.
      expect(VOICES_DIR).toBe("{service}/../voices");
      expect(resolve(dir, "..", "voices")).toBe(resolve(spec(name).env.VOICES_DIR ?? ""));
    } else {
      expect(VOICES_DIR).toBeUndefined();
    }
  });

  it("sing starts after the workers it offloads", () => {
    const after = entry("sing").descriptor.run?.after ?? [];
    expect([...after].sort()).toEqual([...(WORKER_DEFAULTS.sing?.offload ?? [])].sort());
    const names = plan.map((s) => s.name);
    for (const peer of after) {
      expect(names.indexOf(peer)).toBeLessThan(names.indexOf("sing"));
    }
  });

  it("states the VRAM the checks estimate", () => {
    for (const w of stack.workers) {
      const vram = entry(w.name).descriptor.gpu?.vram_mb;
      expect(vram?.resident ?? 0).toBe(estimateVram(w));
    }
  });
});

describe("core, the voice node and the stage", () => {
  it("core runs the CLI's own entry with core", () => {
    const { descriptor } = entry("core");
    const s = spec("core");
    const run = descriptor.run;
    expect(run?.command[0]).toBe("{miyoria}");
    expect(run?.command.slice(1).map((p) => (p === "{config}" ? configPath : p))).toEqual(
      s.args.slice(-3),
    );
    expect(s.args.slice(-3)[0]).toBe("core");
    expect(run?.port).toBe(s.port);
    expect(new URL(s.health ?? "").pathname).toBe(run?.health.http);
  });

  it("stage runs the CLI's own entry with stage and serves the overlay on 7884", () => {
    const { descriptor } = entry("stage");
    const s = spec("stage");
    const run = descriptor.run;
    expect(run?.command[0]).toBe("{miyoria}");
    expect(run?.command.slice(1).map((p) => (p === "{config}" ? configPath : p))).toEqual(
      s.args.slice(-3),
    );
    expect(s.args.slice(-3)[0]).toBe("stage");
    expect(run?.port).toBe(7884);
    expect(s.port).toBe(7884);
    // No health URL today: the plan waits for the process to stay alive.
    expect(s.health).toBeNull();
    expect(run?.health.http).toBeUndefined();
    expect(run?.health.process).toBe(true);
  });

  it("the voice node runs pnpm start in its folder", () => {
    const { descriptor, dir } = entry("voice-node");
    const s = spec("voice-node");
    expect(descriptor.run?.command).toEqual([s.command, ...s.args]);
    expect(resolve(dir)).toBe(resolve(s.cwd));
    expect(s.health).toBeNull();
    expect(descriptor.run?.health.process).toBe(true);
    expect(s.port).toBeNull();
    expect(descriptor.run?.port).toBeUndefined();
  });

  it("the two nodes start after core, as in the plan", () => {
    const names = plan.map((s) => s.name);
    for (const name of ["voice-node", "stage"]) {
      expect(entry(name).descriptor.run?.after).toEqual(["core"]);
      expect(names.indexOf("core")).toBeLessThan(names.indexOf(name));
    }
  });
});
