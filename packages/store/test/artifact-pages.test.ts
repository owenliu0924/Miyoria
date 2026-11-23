// Web pages: a random address, the files a page loads by relative path, audiences no wider than
// where each file was made, expiry and taking back, the daily count, and files kept as long as the
// page.

import type { PersonId } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Artifact, ArtifactShareError, pageAssetPath } from "../src/index.js";
import { DAY, type Fixture, fixture, HOUR, SAMPLES, T0 } from "./artifact-fixtures.js";

const html = (s: string) =>
  new TextEncoder().encode(`<!doctype html><html><body>${s}</body></html>`);

let f: Fixture;
let page: Artifact;
let picture: Artifact;
beforeEach(async () => {
  f = fixture();
  page = await f.store.ingest(html("hi"), {
    source: "sandbox",
    plugin: "sandbox",
    filename: "index.html",
    place: f.room,
    made_for: f.person,
  });
  picture = await f.store.ingest(SAMPLES["image/png"] as Uint8Array, {
    source: "sandbox",
    plugin: "sandbox",
    filename: "cat.png",
    place: f.room,
    made_for: f.person,
  });
});
afterEach(() => {
  f.close();
});

const person = () => f.person as PersonId;

describe("pages", () => {
  it("get a random address and hold their files by path", () => {
    const one = f.store.pages.create({
      artifact_id: page.id,
      assets: [{ path: "img/cat.png", artifact_id: picture.id }],
      audience: "person",
      person_id: person(),
      made_for: person(),
      size: page.size + picture.size,
      ttlMs: DAY,
    });
    const two = f.store.pages.create({
      artifact_id: page.id,
      assets: [],
      audience: "space",
      space_id: f.room.space_id,
      made_for: person(),
      size: page.size,
      ttlMs: DAY,
    });
    expect(one.slug).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(one.slug).not.toBe(two.slug);
    const found = f.store.pages.bySlug(one.slug);
    expect(found).toMatchObject({ ok: true, page: { id: one.id }, artifact: { id: page.id } });
    expect(f.store.pages.asset(one.id, "img/cat.png")?.id).toBe(picture.id);
    expect(f.store.pages.asset(one.id, "cat.png")).toBeNull();
    expect(f.store.pages.asset(two.id, "img/cat.png")).toBeNull();
    expect(f.store.pages.bySlug("x".repeat(22))).toEqual({ ok: false, reason: "unknown" });
    expect(f.store.pages.bySlug("../etc")).toEqual({ ok: false, reason: "unknown" });
  });

  it("take only plain relative paths", () => {
    for (const ok of ["style.css", "./app.js", "img/cat.png", "a_b-c.d/e.json"]) {
      expect(pageAssetPath(ok), ok).not.toBeNull();
    }
    for (const bad of ["", "../x", "a/../b", "/abs", ".hidden", "a//b", "a\\b", "~t/x", "a b"]) {
      expect(pageAssetPath(bad), bad).toBeNull();
    }
    expect(() =>
      f.store.pages.create({
        artifact_id: page.id,
        assets: [{ path: "../up.png", artifact_id: picture.id }],
        audience: "person",
        person_id: person(),
        made_for: person(),
        size: 1,
        ttlMs: DAY,
      }),
    ).toThrow(ArtifactShareError);
  });

  it("are never wider than where each file was made", async () => {
    const dmPage = await f.store.ingest(html("dm"), {
      source: "sandbox",
      plugin: "sandbox",
      filename: "dm.html",
      place: f.dm,
      made_for: f.person,
    });
    const base = { assets: [], made_for: person(), size: 1, ttlMs: DAY };
    expect(() =>
      f.store.pages.create({
        ...base,
        artifact_id: dmPage.id,
        audience: "space",
        space_id: f.room.space_id,
      }),
    ).toThrow(ArtifactShareError);
    // Anyone: only when its own person asked.
    expect(() => f.store.pages.create({ ...base, artifact_id: page.id, audience: "link" })).toThrow(
      ArtifactShareError,
    );
    expect(
      f.store.pages.create({ ...base, artifact_id: page.id, audience: "link", widen: true })
        .audience,
    ).toBe("link");
    // A DM-made file cannot ride on a room's page to the server.
    expect(() =>
      f.store.pages.create({
        ...base,
        artifact_id: page.id,
        assets: [{ path: "x.html", artifact_id: dmPage.id }],
        audience: "space",
        space_id: f.room.space_id,
      }),
    ).toThrow(ArtifactShareError);
  });

  it("expire, are taken back at once, and close with the artifact they show", () => {
    const made = (ttlMs: number) =>
      f.store.pages.create({
        artifact_id: page.id,
        assets: [],
        audience: "person",
        person_id: person(),
        made_for: person(),
        size: page.size,
        ttlMs,
      });
    const short = made(HOUR);
    const kept = made(DAY);
    const taken = made(DAY);
    expect(f.store.pages.revoke(taken.id)).toBe(true);
    expect(f.store.pages.revoke(taken.id)).toBe(false);
    expect(f.store.pages.bySlug(taken.slug)).toEqual({ ok: false, reason: "revoked" });
    f.clock.advance(HOUR);
    expect(f.store.pages.bySlug(short.slug)).toEqual({ ok: false, reason: "expired" });
    expect(f.store.pages.bySlug(kept.slug).ok).toBe(true);
    expect(f.store.pages.list({ made_for: person(), open: true }).map((p) => p.id)).toEqual([
      kept.id,
    ]);
    expect(f.store.pages.countFor(person(), "2026-11-14T00:00:00.000Z" as never)).toBe(3);
    f.store.takeDown(page.id, "owner", "test");
    expect(f.store.pages.bySlug(kept.slug)).toEqual({ ok: false, reason: "gone" });
  });

  it("keep their files as long as the page by extending, never shortening", () => {
    const until = T0 + 30 * DAY;
    expect(Date.parse(page.expires_at ?? "")).toBe(T0 + 7 * DAY);
    expect(f.store.extend(page.id, until)).toBe(true);
    expect(Date.parse(f.store.get(page.id)?.expires_at ?? "")).toBe(until);
    f.store.extend(page.id, T0 + DAY);
    expect(Date.parse(f.store.get(page.id)?.expires_at ?? "")).toBe(until);
    f.store.keep(picture.id, "person");
    expect(f.store.extend(picture.id, until)).toBe(true);
    expect(f.store.get(picture.id)?.expires_at).toBeNull();
  });
});
