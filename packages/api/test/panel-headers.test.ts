// The panel's pages say what they may load (CSP) and, once reached over HTTPS, keep to HTTPS (HSTS);
// a page whose preview tags name the host varies by the headers that name it.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PANEL_CSP, PANEL_HSTS, servePanel } from "../src/panel.js";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "myr-panel-"));
  await writeFile(join(dir, "index.html"), "<html><head></head><body></body></html>");
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "assets", "app.js"), "console.log(1)");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const get = (path: string, headers: Record<string, string> = {}, rewrite = false) =>
  servePanel(
    dir,
    new Request(`http://127.0.0.1:7880${path}`, { headers }),
    rewrite ? async (html) => html : undefined,
  );

describe("the panel's headers", () => {
  it("lets a page run only the panel's own scripts", async () => {
    for (const rewrite of [false, true]) {
      const page = await get("/", {}, rewrite);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toBe(PANEL_CSP);
    }
    expect(PANEL_CSP).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(PANEL_CSP).toContain("frame-ancestors 'none'");
    expect(PANEL_CSP).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it("leaves a script or picture without one", async () => {
    const asset = await get("/assets/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-security-policy")).toBeNull();
  });

  it("asks for HTTPS only when the page came over HTTPS", async () => {
    expect((await get("/")).headers.get("strict-transport-security")).toBeNull();
    const tunnelled = await get("/", { "x-forwarded-proto": "https" }, true);
    expect(tunnelled.headers.get("strict-transport-security")).toBe(PANEL_HSTS);
    const asset = await get("/assets/app.js", { "x-forwarded-proto": "https" });
    expect(asset.headers.get("strict-transport-security")).toBe(PANEL_HSTS);
  });

  it("keeps one rewritten page per host in a cache in front", async () => {
    const vary = (await get("/", {}, true)).headers.get("vary") ?? "";
    expect(vary.split(",").map((v) => v.trim())).toEqual(
      expect.arrayContaining(["accept-encoding", "x-forwarded-host", "x-forwarded-proto"]),
    );
  });
});
