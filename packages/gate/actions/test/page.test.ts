// `page_publish`, `page_list`, `page_unpublish`: who may publish what, the request the file origin
// gets, the daily limit shared with `share`, and listing and taking back one's own pages (an owner
// all of them). On a real artifact store; the file origin's page service is a stand-in over the
// store's pages that records what it was asked.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@miyoria/llm/tools";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import {
  type Artifact,
  ArtifactStoreKey,
  type FilePages,
  FilePagesKey,
  type PagePublishRequest,
  SqliteStore,
} from "@miyoria/store";
import {
  type AccountRef,
  AuthorizerKey,
  type ContextKey,
  MouthKey,
  PlatformSinks,
  PlatformSinksKey,
  publishedInto,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ActionResult,
  type Capability,
  type ExecContext,
  pageCapabilities,
  type ShareConfig,
  ShareConfigSchema,
  shareCapability,
  WORKSPACE_ALL,
} from "../src/index.js";
import { RateLimiter } from "../src/rate.js";
import { ActuatorRegistry } from "../src/registry.js";

const T0 = Date.parse("2026-11-23T00:00:00.000Z");
const OWEN: AccountRef = { platform: "discord", id: "100" };
const MIA: AccountRef = { platform: "discord", id: "200" };
const ROOM: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const OWEN_DM: ContextKey = { platform: "discord", scope: null, channel: "d1", kind: "dm" };
const html = (s: string) => new TextEncoder().encode(`<!doctype html><p>${s}</p>`);

let dir: string;
let store: SqliteStore;
let services: ServiceRegistry;
let asked: PagePublishRequest[];
let owners: Set<string>;
let config: ShareConfig;
let caps: Map<string, Capability>;
let limiter: RateLimiter;

function artifacts() {
  const a = store.artifacts;
  if (!a) throw new Error("no artifact store");
  return a;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "miyoria-page-"));
  store = await SqliteStore.open(join(dir, "a.db"), { clock: { now: () => T0 } });
  store.persons.resolve(ROOM, { account: OWEN, display_name: "Owen" });
  store.persons.resolve(ROOM, { account: MIA, display_name: "Mia" });
  store.persons.resolve(OWEN_DM, { account: OWEN, display_name: "Owen" });
  services = new ServiceRegistry();
  services.provide("test", ArtifactStoreKey, artifacts());
  owners = new Set();
  services.provide("test", AuthorizerKey, {
    allows: (a: AccountRef, node: string) => node === WORKSPACE_ALL && owners.has(a.id),
    allowsSubject: () => false,
  });
  asked = [];
  config = ShareConfigSchema.parse({});
  limiter = new RateLimiter();
  caps = new Map(
    pageCapabilities({ services, config: () => config, limiter, clock: { now: () => T0 } }).map(
      (c) => [c.name, c],
    ),
  );
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The file origin's page service, as the `api` module's would answer, over the store. */
function origin(publicPages = false): void {
  const pages: FilePages = {
    available: (audience) => audience !== "link" || publicPages,
    urlOf: (slug) => `https://files.test/p/${slug}/`,
    publish: async (request) => {
      asked.push(request);
      const page = artifacts().pages.create({
        artifact_id: request.artifact_id,
        assets: request.assets,
        audience: request.audience,
        person_id: request.person_id ?? null,
        space_id: request.space_id ?? null,
        made_for: request.requested_by,
        size: 10,
        ttlMs: 30 * 86_400_000,
        widen: request.widen === true,
      });
      return {
        ok: true,
        url: `https://files.test/p/${page.slug}/`,
        page_id: page.id,
        audience: page.audience,
        expires_at: page.expires_at,
        size: 10,
      };
    },
  };
  services.provide("api", FilePagesKey, pages);
}

async function make(data: Uint8Array, at: ContextKey, as: AccountRef, filename = "index.html") {
  const site = artifacts().places.at(at, as, { create: true });
  if (site === null) throw new Error("unknown place");
  return artifacts().ingest(data, {
    source: "sandbox",
    plugin: "sandbox",
    filename,
    place: site.place,
    made_for: site.person_id,
    turn: "T0",
  });
}

async function exec(name: string, who: AccountRef, where: ContextKey, args: object) {
  const cap = caps.get(name);
  if (cap === undefined) throw new Error(`no ${name}`);
  const principal = { kind: "user", requester: who, context: where, override: false, actor: null };
  const ctx = {
    principal,
    request: { principal, capability: name, args, why: null, turn: "T1", message: null },
    decision: {},
    services,
    signal: new AbortController().signal,
  } as unknown as ExecContext;
  return (await cap.execute(cap.args.parse(args), ctx)) as ActionResult;
}

const data = (r: ActionResult) => r.data as Record<string, unknown>;

describe("page_publish", () => {
  it("publishes the asker's own page for them, and says where and for whom", async () => {
    origin();
    const page = await make(html("hi"), ROOM, OWEN);
    const css = await make(new TextEncoder().encode("p{}"), ROOM, OWEN, "style.css");
    const result = await exec("page.publish", OWEN, ROOM, {
      artifact: page.id,
      assets: [{ path: "style.css", artifact: css.id }],
      days: 10,
    });
    expect(data(result)).toMatchObject({ ok: true, audience: "person" });
    expect(result.text).toContain("https://files.test/p/");
    expect(result.text).toContain("只有對方登入後打得開");
    const owen = artifacts().places.at(ROOM, OWEN)?.person_id;
    expect(asked[0]).toMatchObject({
      artifact_id: page.id,
      assets: [{ path: "style.css", artifact_id: css.id }],
      audience: "person",
      person_id: owen,
      space_id: null,
      days: 10,
      requested_by: owen,
      widen: false,
    });
  });

  it("asks for the server's members with here, and anyone only as the asker's own", async () => {
    origin(true);
    const page = await make(html("hi"), ROOM, OWEN);
    await exec("page.publish", OWEN, ROOM, { artifact: page.id, to: "here" });
    expect(asked[0]).toMatchObject({ audience: "space", person_id: null });
    expect(asked[0]?.space_id).not.toBeNull();
    await exec("page.publish", OWEN, ROOM, { artifact: page.id, to: "anyone" });
    expect(asked[1]).toMatchObject({ audience: "link", widen: true });
    const dm = await make(html("dm"), OWEN_DM, OWEN);
    const fromDm = await exec("page.publish", OWEN, OWEN_DM, { artifact: dm.id, to: "here" });
    expect(data(fromDm).refused).toBe("wider_than_origin");
  });

  it("refuses someone else's file, a file from elsewhere, an unknown id, and no file origin", async () => {
    const mine = await make(html("mine"), ROOM, OWEN);
    expect(data(await exec("page.publish", OWEN, ROOM, { artifact: mine.id })).refused).toBe(
      "unavailable",
    );
    origin();
    const theirs = await make(html("theirs"), ROOM, MIA);
    expect(data(await exec("page.publish", OWEN, ROOM, { artifact: theirs.id })).refused).toBe(
      "not_for_them",
    );
    const asAsset = await exec("page.publish", OWEN, ROOM, {
      artifact: mine.id,
      assets: [{ path: "x.css", artifact: theirs.id }],
    });
    expect(data(asAsset)).toMatchObject({ refused: "not_for_them" });
    const dm = await make(html("dm"), OWEN_DM, OWEN);
    expect(data(await exec("page.publish", OWEN, ROOM, { artifact: dm.id })).refused).toBe(
      "wider_than_origin",
    );
    const unknown = await exec("page.publish", OWEN, ROOM, {
      artifact: "01JX0000000000000000000000",
    });
    expect(data(unknown).refused).toBe("not_found");
    expect(unknown.text).toContain("workspace_export");
    expect(asked).toEqual([]);
    // An owner may publish what was made for someone else.
    owners.add(OWEN.id);
    expect(data(await exec("page.publish", OWEN, ROOM, { artifact: theirs.id })).ok).toBe(true);
  });

  it("counts toward the same daily limit as share", async () => {
    origin();
    config = ShareConfigSchema.parse({ per_person_per_day: 1, per_day: 100 });
    const page = await make(html("a"), ROOM, OWEN);
    expect(data(await exec("page.publish", OWEN, ROOM, { artifact: page.id })).ok).toBe(true);
    expect(data(await exec("page.publish", OWEN, ROOM, { artifact: page.id })).refused).toBe(
      "limit",
    );
    // And `share` reads the same count.
    const sinks = new PlatformSinks();
    services.provide("test", PlatformSinksKey, sinks);
    services.provide("test", MouthKey, { owns: () => true, say: async () => {} });
    const share = shareCapability({
      services,
      config: () => config,
      publish: publishedInto([]),
      clock: { now: () => T0 },
      names: null,
      limiter,
    });
    const note = await make(new TextEncoder().encode("words\n"), ROOM, OWEN, "n.txt");
    const principal = {
      kind: "user",
      requester: OWEN,
      context: ROOM,
      override: false,
      actor: null,
    };
    const ctx = {
      principal,
      request: { principal, capability: "share", args: {}, why: null, turn: "T1", message: null },
      decision: {},
      services,
      signal: new AbortController().signal,
    } as unknown as ExecContext;
    const shared = (await share.execute(
      share.args.parse({ artifact: note.id }),
      ctx,
    )) as ActionResult;
    expect(data(shared).refused).toBe("limit");
  });
});

describe("page_list and page_unpublish", () => {
  async function publishAs(who: AccountRef): Promise<{ id: string; artifact: Artifact }> {
    const artifact = await make(html("p"), ROOM, who);
    const result = await exec("page.publish", who, ROOM, { artifact: artifact.id });
    return { id: data(result).page_id as string, artifact };
  }

  it("list and take back the asker's own pages; an owner reaches all", async () => {
    origin();
    const owen = await publishAs(OWEN);
    const mia = await publishAs(MIA);
    const mine = await exec("page.list", OWEN, ROOM, {});
    expect((data(mine).pages as { page_id: string }[]).map((p) => p.page_id)).toEqual([owen.id]);
    expect(mine.text).toContain("https://files.test/p/");
    expect(data(await exec("page.unpublish", OWEN, ROOM, { page: mia.id })).refused).toBe(
      "not_found",
    );
    expect(artifacts().pages.get(mia.id)?.revoked_at).toBeNull();
    const done = await exec("page.unpublish", OWEN, ROOM, { page: owen.id });
    expect(data(done)).toMatchObject({ ok: true, revoked: true });
    expect(artifacts().pages.isOpen(artifacts().pages.get(owen.id) as never)).toBe(false);
    expect((data(await exec("page.list", OWEN, ROOM, {})).pages as unknown[]).length).toBe(0);
    owners.add(OWEN.id);
    const all = await exec("page.list", OWEN, ROOM, {});
    expect((data(all).pages as { page_id: string }[]).map((p) => p.page_id)).toEqual([mia.id]);
    expect(data(await exec("page.unpublish", OWEN, ROOM, { page: mia.id })).ok).toBe(true);
  });
});

describe("the registered page tools", () => {
  it("are work tools of the files group; page_publish is always offered, the rest found", () => {
    const tools = new ToolRegistry();
    const registry = new ActuatorRegistry({ services, tools, publish: publishedInto([]) });
    const publish = registry.get("page.publish");
    expect(publish?.permission).toBe("sandbox.workspace");
    expect(publish?.tool?.meta).toMatchObject({ group: "files", core: true });
    expect(registry.get("page.list")?.tool?.meta).toMatchObject({ group: "files", core: false });
    expect(registry.get("page.unpublish")?.tool?.meta).toMatchObject({ core: false });
    expect(tools.names()).toEqual(
      expect.arrayContaining(["page_publish", "page_list", "page_unpublish"]),
    );
  });
});
