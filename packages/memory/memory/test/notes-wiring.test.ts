// The memory module over a real store: the notebook and her prompt come from the notes, and the old
// pages are moved into them once, at start.

import { type LlmRouter, LlmRouterKey, MockProvider } from "@miyoria/llm/llm";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  ServiceRegistry,
  Supervisor,
} from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import { NotebookKey, PromptContributors, PromptContributorsKey } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { LEGACY_IMPORT_KEY } from "../../notes/src/legacy.js";
import { notesTables } from "../../notes/src/store.js";
import { embeddingConfig, MemoryModule, memoryConfig, memoryTables } from "../src/index.js";
import { NotebookStore } from "../src/notebook.js";
import { NOTEBOOK_TOOLS } from "../src/notebook-tools.js";
import { profile, router } from "./helpers.js";

class LlmStub implements Module {
  readonly manifest = defineManifest("llm", "LLM stub");
  constructor(readonly router: LlmRouter) {}
  async start(ctx: ModuleContext): Promise<void> {
    ctx.provide(LlmRouterKey, this.router);
  }
}

const stores: SqliteStore[] = [];
const sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
  for (const s of stores.splice(0)) await s.close();
});

async function legacyPage(store: SqliteStore, path: string, body: string) {
  const pages = new NotebookStore({
    settings: store.settings,
    profile: profile(),
    config: () => memoryConfig().notebook,
  });
  await pages.load();
  await pages.write(path, body, "append", { context: null });
}

async function start(store: SqliteStore) {
  const services = new ServiceRegistry();
  const sup = new Supervisor({ services });
  sups.push(sup);
  services.provide("app", StoreKey, store);
  const tools = new ToolRegistry();
  services.provide("app", ToolRegistryKey, tools);
  services.provide("app", PromptContributorsKey, new PromptContributors());
  await sup.register(new LlmStub(router(new MockProvider("p"))), null, true);
  await sup.register(new MemoryModule(profile(), embeddingConfig()), {}, true);
  await sup.startAll();
  return { sup, tools, services };
}

describe("the memory module on the notes", () => {
  it("moves the old pages into the notes once, and leaves the old rows alone", async () => {
    const store = await SqliteStore.open(":memory:", { plugins: [memoryTables, notesTables] });
    stores.push(store);
    await legacyPage(store, "主題/活動", "週五有團");
    const notes = store.plugin(notesTables);
    const rows = async () => (await store.settings.list(profile(), "notebook:page:")).size;
    const before = await rows();
    expect(before).toBeGreaterThan(0);

    const first = await start(store);
    expect(notes.document("topic:活動")).not.toBeNull();
    expect(notes.lines("topic:活動", "owner").map((l) => l.text)).toEqual(["週五有團"]);
    expect(await store.settings.get(profile(), LEGACY_IMPORT_KEY)).toMatchObject({ pages: 1 });
    expect(await rows()).toBe(before);
    for (const name of NOTEBOOK_TOOLS) expect(first.tools.get(name)).toBeDefined();
    expect(first.services.get(NotebookKey)).toBeDefined();
    await first.sup.stopAll();

    // A page that appears after the first start is not looked for again.
    await legacyPage(store, "主題/新的", "之後才有");
    await start(store);
    expect(notes.document("topic:新的")).toBeNull();
    expect(notes.lines("topic:活動", "owner")).toHaveLength(1);
  });
});
