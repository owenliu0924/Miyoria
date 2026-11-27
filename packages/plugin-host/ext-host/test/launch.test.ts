// Where an extension's process runs (`ExtensionLauncher`), and the `ext new` template running
// against the real SDK and the host's side of the protocol.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import {
  Config,
  EventBus,
  ServiceRegistry,
  Supervisor,
  SupervisorKey,
  sleep,
} from "@miyoria/runtime/kernel";
import type { ExtensionDefinition } from "@miyoria/sdk";
import { runExtension } from "@miyoria/sdk";
import { AuthorizerKey, BaseAuthorizer, type JsonObject, type JsonValue } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ChildLike,
  discover,
  type ExtensionLauncher,
  ExtensionLauncherKey,
  ExtensionManifest,
  ExtensionModule,
  type LaunchSpec,
  localLauncher,
  newExtension,
  Peer,
  resolveProgram,
} from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk.toString();
  return out;
}

describe("localLauncher", () => {
  it("starts the program here with exactly its environment and the granted secrets", async () => {
    const spec: LaunchSpec = {
      extension: "x",
      dir: HERE,
      runtime: "binary",
      program: process.execPath,
      args: [
        "-e",
        "process.stdin.pipe(process.stdout); process.stderr.write(JSON.stringify([process.env.A ?? null, process.env.S ?? null, process.env.LEAK ?? null]))",
      ],
      cwd: HERE,
      env: { A: "1", PATH: process.env.PATH ?? "" },
      network: [],
      secrets: { S: "granted" },
      runIn: "sandbox",
    };
    process.env.LEAK = "core-secret";
    try {
      const child = await localLauncher().launch(spec, new AbortController().signal);
      expect(child.where).toEqual({ kind: "host" });
      const out = readAll(child.stdout);
      const err = readAll(child.stderr);
      child.stdin.end("ping");
      expect(await out).toBe("ping");
      expect(JSON.parse(await err)).toEqual(["1", "granted", null]);
      expect((await child.exited).code).toBe(0);
    } finally {
      delete process.env.LEAK;
    }
  });

  it("a program that does not start is an error, and kill ends one that does", async () => {
    const launcher = localLauncher();
    const base: LaunchSpec = {
      extension: "x",
      dir: HERE,
      runtime: "binary",
      program: join(HERE, "definitely-not-a-program"),
      args: [],
      cwd: HERE,
      env: {},
      network: [],
      secrets: {},
      runIn: "host",
    };
    await expect(launcher.launch(base, new AbortController().signal)).rejects.toThrow(
      /definitely-not-a-program/,
    );
    const child = await launcher.launch(
      {
        ...base,
        program: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        env: { PATH: process.env.PATH ?? "" },
      },
      new AbortController().signal,
    );
    child.kill();
    const exit = await child.exited;
    expect(exit.code !== 0 || exit.signal !== null).toBe(true);
  });

  it("finds a bare command's shim on Windows the way a shell would", () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-path-"));
    try {
      writeFileSync(join(dir, "npx.cmd"), "@echo off\n");
      const env = { Path: dir, PATHEXT: ".EXE;.cmd" };
      expect(resolveProgram("npx", env, "win32")).toBe(join(dir, "npx.cmd"));
      expect(resolveProgram("npx", env, "linux")).toBe("npx");
      expect(resolveProgram("C:/bin/tool", env, "win32")).toBe("C:/bin/tool");
      expect(resolveProgram("missing", env, "win32")).toBe("missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("launch spec", () => {
  const manifest = (extra: string) =>
    ExtensionManifest.parse(
      `id = "made.up"\nversion = "1"\nruntime = "node"\nentry = "i.js"\n${extra}`,
    );
  const host = { runtimes: {} } as never;

  it("runs in a sandbox by default, a game adapter or input on this machine, run_in wins", () => {
    const granted = { events: [], tools: true, commands: false, network: ["a.example"], input: [] };
    const plain = new ExtensionModule({ manifest: manifest(""), dir: HERE, granted }, host);
    expect(plain.launchSpec({}).spec).toMatchObject({
      runIn: "sandbox",
      network: ["a.example"],
      cwd: HERE,
      runtime: "node",
    });
    const game = manifest('kind = ["game-adapter"]\ngame = "made"');
    expect(
      new ExtensionModule({ manifest: game, dir: HERE, granted }, host).launchSpec({}).spec,
    ).toMatchObject({ runIn: "host" });
    const input = { ...granted, input: ["keyboard"] };
    expect(
      new ExtensionModule({ manifest: manifest(""), dir: HERE, granted: input }, host).launchSpec(
        {},
      ).spec.runIn,
    ).toBe("host");
    const owner = new ExtensionModule(
      { manifest: manifest(""), dir: HERE, granted, runIn: "host" },
      host,
    );
    expect(owner.launchSpec({}).spec.runIn).toBe("host");
    // Only what the owner wrote counts as chosen (a launcher does not undo it).
    expect(owner.launchSpec({}).spec.runInChosen).toBe(true);
    expect(plain.launchSpec({}).spec.runInChosen).toBe(false);
  });

  it("hands over the owner's secrets apart from the environment and says what it held back", () => {
    const m = manifest('[env]\npass = ["MADE_*", "LLM_API_KEY"]');
    const granted = { events: [], tools: true, commands: false, network: [], input: [] };
    const module = new ExtensionModule(
      { manifest: m, dir: HERE, granted, secrets: ["MADE_TOKEN", "MISSING_KEY"] },
      host,
    );
    const { spec, held, missing } = module.launchSpec({
      MADE_URL: "u",
      MADE_TOKEN: "t",
      LLM_API_KEY: "sk",
    });
    expect(spec.env.MADE_URL).toBe("u");
    expect(spec.env.MADE_TOKEN).toBeUndefined();
    expect(spec.env.LLM_API_KEY).toBeUndefined();
    expect(spec.secrets).toEqual({ MADE_TOKEN: "t" });
    expect(held).toEqual(["LLM_API_KEY", "MADE_TOKEN"]);
    expect(missing).toEqual(["MISSING_KEY"]);
  });
});

class AllowAll extends BaseAuthorizer {
  allowsSubject(): boolean {
    return true;
  }
}

describe("the app's launcher", () => {
  const running: Supervisor[] = [];
  afterEach(async () => {
    for (const sup of running.splice(0)) await sup.stopAll();
  });

  it("starts every extension through ExtensionLauncherKey when the app provides one", async () => {
    const seen: LaunchSpec[] = [];
    const local = localLauncher();
    const launcher: ExtensionLauncher = {
      async launch(spec, signal): Promise<ChildLike> {
        seen.push(spec);
        return local.launch(spec, signal);
      },
    };
    const config = Config.fromToml(
      `[modules.extensions]\ndirs = [${JSON.stringify(join(FIXTURES, "test-ext"))}]\ninit_timeout_ms = 5000\n[extensions."test.fixture"]\nrun_in = "host"\n`,
    );
    const services = new ServiceRegistry();
    const sup = new Supervisor({ bus: new EventBus(), services });
    running.push(sup);
    services.provide("app", ToolRegistryKey, new ToolRegistry());
    services.provide("app", AuthorizerKey, new AllowAll());
    services.provide("app", SupervisorKey, sup);
    services.provide("app", ExtensionLauncherKey, launcher);
    for (const m of discover(config, FIXTURES).modules) {
      await sup.register(m.module, m.config, m.enabled);
    }
    await sup.startAll();
    const deadline = Date.now() + 8000;
    while (sup.list().find((m) => m.id === "ext.test.fixture")?.state !== "running") {
      if (Date.now() > deadline) throw new Error("the fixture did not start");
      await sleep(25);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ extension: "test.fixture", runIn: "host", runtime: "node" });
    expect(seen[0]?.env.MIYORIA_RPC).toBe("stdio");
  });
});

describe("ext new", () => {
  it("a dozen lines add a low-risk tool that runs against the SDK", async () => {
    // Under the package, so `@miyoria/sdk` resolves from the generated file.
    const parent = join(HERE, `.gen-${process.pid}-${Date.now()}`);
    mkdirSync(parent, { recursive: true });
    try {
      const dir = newExtension(parent, "my-tool");
      const loaded = (await import(pathToFileURL(join(dir, "index.mjs")).href)) as {
        default: ExtensionDefinition;
      };
      const toExt = new PassThrough();
      const fromExt = new PassThrough();
      const runtime = runExtension(loaded.default, { input: toExt, output: fromExt });
      const peer = new Peer(toExt);
      const stop = new AbortController();
      void peer.serve(
        fromExt,
        { request: async () => ({}), notification: () => undefined },
        stop.signal,
      );
      const init = (await peer.request(
        "initialize",
        {
          protocol: 2,
          host: { name: "miyoria", version: "test" },
          extension: { id: "my-tool", version: "0.1.0", dir, game: null },
          config: {},
          permissions: { events: [], tools: true, commands: false, network: [], input: [] },
        },
        5000,
      )) as { contributions: { tools: JsonObject[] } };
      expect(init.contributions.tools).toEqual([
        expect.objectContaining({ name: "my_tool.echo", risk: "low", read_only: true }),
      ]);
      const context: JsonValue = {
        turn: "t",
        context: { platform: "discord", scope: null, channel: "c", kind: "dm" },
        account: { platform: "discord", id: "1" },
        message: {
          context: { platform: "discord", scope: null, channel: "c", kind: "dm" },
          id: "m",
        },
        priority: "direct",
      };
      expect(
        await peer.request(
          "tools.call",
          { name: "my_tool.echo", args: { text: "嗨" }, context },
          5000,
        ),
      ).toEqual({ content: "嗨" });
      stop.abort();
      void runtime;
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
