// `workspace.export` takes the wider set of types: tar, tar.gz, a single .gz, OpenDocument and
// epub files; refuses 7z and rar with the reason; and its default cap is 256 MiB.

import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { type ActionResult, type ExecContext, WORKSPACE_ALL } from "@miyoria/gate/actions";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { ArtifactStoreKey, SqliteStore } from "@miyoria/store";
import { type AccountRef, AuthorizerKey, type ContextKey } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersistentWorkspace, workspaceExportCapability } from "../src/index.js";
import { Grants } from "./gate-helpers.js";
import { buildTar } from "./tar-fixture.js";
import { buildZip } from "./zip-fixture.js";

const OWEN: AccountRef = { platform: "discord", id: "100" };
const ROOM: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const text = (s: string) => new TextEncoder().encode(s);

let base: string;
let store: SqliteStore;
let workspace: PersistentWorkspace;
let services: ServiceRegistry;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "miyoria-ws-export-types-"));
  workspace = new PersistentWorkspace(join(base, "workspace"), {
    maxBytes: 64 * 1024 * 1024,
    maxFiles: 50,
    maxFileBytes: 16 * 1024 * 1024,
  });
  await workspace.ensure();
  store = await SqliteStore.open(join(base, "a.db"));
  store.persons.resolve(ROOM, { account: OWEN, display_name: "Owen" });
  services = new ServiceRegistry();
  services.provide("test", ArtifactStoreKey, store.artifacts as never);
  services.provide("test", AuthorizerKey, new Grants().grant(OWEN, WORKSPACE_ALL));
});

afterEach(async () => {
  await store.close();
  rmSync(base, { recursive: true, force: true });
});

async function exportFile(path: string, maxBytes?: number): Promise<ActionResult> {
  const cap = workspaceExportCapability({
    workspace,
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  const principal = { kind: "user", requester: OWEN, context: ROOM, override: false, actor: null };
  const ctx = {
    principal,
    request: { principal, capability: "workspace.export", args: { path }, turn: "T1" },
    decision: {},
    services,
    signal: new AbortController().signal,
  } as unknown as ExecContext;
  return (await cap.execute(cap.args.parse({ path }), ctx)) as ActionResult;
}

const refused = (r: ActionResult) => (r.data as { refused?: string }).refused;
const put = (name: string, data: Uint8Array) => writeFile(join(workspace.dir, name), data);

describe("workspace.export: more types", () => {
  it("takes a tar, a tar.gz and a single gzipped file", async () => {
    const tar = buildTar([{ name: "a.txt", data: text("hello") }]);
    await put("pack.tar", tar);
    await put("pack.tgz", gzipSync(tar));
    await put("log.txt.gz", gzipSync(text("one file")));
    expect((await exportFile("pack.tar")).data).toMatchObject({
      ok: true,
      mime: "application/x-tar",
    });
    expect((await exportFile("pack.tgz")).data).toMatchObject({
      ok: true,
      mime: "application/gzip",
    });
    expect((await exportFile("log.txt.gz")).data).toMatchObject({
      ok: true,
      mime: "application/gzip",
    });
  });

  it("takes OpenDocument files and epub, which are zips named by their extension", async () => {
    const zip = buildZip([{ name: "content.xml", data: text("<a/>") }]);
    for (const [name, mime] of [
      ["sheet.ods", "application/vnd.oasis.opendocument.spreadsheet"],
      ["letter.odt", "application/vnd.oasis.opendocument.text"],
      ["slides.odp", "application/vnd.oasis.opendocument.presentation"],
      ["book.epub", "application/epub+zip"],
    ] as const) {
      await put(name, zip);
      expect((await exportFile(name)).data, name).toMatchObject({ ok: true, mime });
    }
    // An .ods that is not a zip is not stored as one.
    await put("fake.ods", text("just text\n"));
    expect(refused(await exportFile("fake.ods"))).toBe("type_not_allowed");
  });

  it("refuses a tar that climbs out or holds a link, and a gzip bomb", async () => {
    await put("climb.tar", buildTar([{ name: "../x", data: text("a") }]));
    await put("link.tar", buildTar([{ name: "ln", flag: "2" }]));
    await put("bomb.gz", gzipSync(new Uint8Array(260 * 1024 * 1024)));
    for (const name of ["climb.tar", "link.tar", "bomb.gz"]) {
      expect(refused(await exportFile(name)), name).toBe("zip_refused");
    }
  });

  it("tells a 7z or rar to be made a zip instead", async () => {
    await put("pack.7z", Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, 9, 9]));
    await put("pack.rar", Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0, 9, 9]));
    for (const name of ["pack.7z", "pack.rar"]) {
      const result = await exportFile(name);
      expect(refused(result), name).toBe("archive_unreadable");
      expect(result.text).toContain("改用 zip");
    }
  });

  it("another binary is still not a type (an executable)", async () => {
    await put("tool.exe", Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0]));
    expect(refused(await exportFile("tool.exe"))).toBe("type_not_allowed");
  });

  it("takes a file over the old 8 MiB cap by default, and keeps a cap that is given", async () => {
    const big = buildTar([{ name: "big.bin", data: new Uint8Array(9 * 1024 * 1024) }]);
    await put("big.tar", big);
    expect((await exportFile("big.tar")).data).toMatchObject({ ok: true });
    const small = await exportFile("big.tar", 1024 * 1024);
    expect(refused(small)).toBe("limit");
  });
});
