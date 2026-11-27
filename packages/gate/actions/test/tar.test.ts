// The tar and gzip readers: the same refusals as the zip reader, for the formats the store keeps
// next to zips. Everything in memory.

import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { inspectGzip, inspectTar, isGzip, isTar, isUnreadableArchive } from "../src/tar.js";
import { buildTar } from "./tar-fixture.js";

const text = (s: string) => new TextEncoder().encode(s);
const LIMITS = { maxUnpackedBytes: 1024 * 1024, maxEntries: 50 };

describe("inspectTar", () => {
  it("takes folders and files and counts what unpacks", () => {
    const tar = buildTar([
      { name: "docs/", flag: "5" },
      { name: "docs/a.txt", data: text("hello") },
      { name: "b.bin", data: Uint8Array.from([0, 1, 2, 3]) },
    ]);
    expect(isTar(tar)).toBe(true);
    expect(inspectTar(tar, LIMITS)).toEqual({ ok: true, entries: 3, unpacked: 9 });
  });

  it("takes an archive that ends without the two zero blocks, and zeros to the record size", () => {
    expect(
      inspectTar(buildTar([{ name: "a.txt", data: text("x") }], { noEnd: true }), LIMITS),
    ).toMatchObject({ ok: true });
    expect(
      inspectTar(
        buildTar([{ name: "a.txt", data: text("x") }], { trailing: new Uint8Array(4096) }),
        LIMITS,
      ),
    ).toMatchObject({ ok: true });
  });

  it("reads long names from a pax or a GNU header", () => {
    const long = `${"d/".repeat(60)}file.txt`;
    expect(
      inspectTar(buildTar([{ name: "x", pax: { path: long }, data: text("a") }]), LIMITS),
    ).toMatchObject({ ok: true });
    expect(
      inspectTar(buildTar([{ name: "x", longName: long, data: text("a") }]), LIMITS),
    ).toMatchObject({ ok: true });
    const out = buildTar([{ name: "x", pax: { path: "../up.txt" }, data: text("a") }]);
    expect(inspectTar(out, LIMITS)).toMatchObject({
      ok: false,
      why: "a file name leaves the folder",
    });
    const climbs = buildTar([{ name: "x", longName: "/etc/passwd", data: text("a") }]);
    expect(inspectTar(climbs, LIMITS)).toMatchObject({
      ok: false,
      why: "a file name leaves the folder",
    });
  });

  it("refuses names that climb out, links, devices and repeated names", () => {
    const refuse = (entries: Parameters<typeof buildTar>[0]) =>
      inspectTar(buildTar(entries), LIMITS);
    expect(refuse([{ name: "../evil", data: text("x") }])).toMatchObject({
      ok: false,
      why: "a file name leaves the folder",
    });
    expect(refuse([{ name: "/abs", data: text("x") }])).toMatchObject({ ok: false });
    expect(refuse([{ name: "a/../../b", data: text("x") }])).toMatchObject({ ok: false });
    expect(refuse([{ name: "ln", flag: "2" }])).toMatchObject({
      ok: false,
      why: "contains a link",
    });
    expect(refuse([{ name: "hl", flag: "1" }])).toMatchObject({
      ok: false,
      why: "contains a link",
    });
    expect(refuse([{ name: "dev", flag: "3" }])).toMatchObject({
      ok: false,
      why: "an entry that is not a file or a folder",
    });
    expect(
      refuse([
        { name: "a.txt", data: text("1") },
        { name: "./a.txt", data: text("2") },
      ]),
    ).toMatchObject({ ok: false, why: "a file name is there twice" });
  });

  it("refuses what is hidden: bad checksums, data in padding, data after the end, a short file", () => {
    expect(
      inspectTar(buildTar([{ name: "a", data: text("x"), badChecksum: true }]), LIMITS),
    ).toMatchObject({ ok: false, why: "a tar header is broken" });
    expect(
      inspectTar(buildTar([{ name: "a", data: text("x"), padding: text("SECRET") }]), LIMITS),
    ).toMatchObject({ ok: false, why: "data hidden in a tar entry's padding" });
    expect(
      inspectTar(
        buildTar([{ name: "a", data: text("x") }], { trailing: text("x".repeat(512)) }),
        LIMITS,
      ),
    ).toMatchObject({ ok: false });
    const tar = buildTar([{ name: "a", data: text("x") }]);
    expect(inspectTar(tar.subarray(0, 700), LIMITS)).toMatchObject({ ok: false });
    expect(
      inspectTar(buildTar([{ name: "a", pax: { size: "5" }, data: text("x") }]), LIMITS),
    ).toMatchObject({ ok: false });
  });

  it("holds the limits on entries and unpacked bytes", () => {
    const many = buildTar(
      Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, data: text("x") })),
    );
    expect(inspectTar(many, { ...LIMITS, maxEntries: 5 })).toMatchObject({ ok: false });
    const big = buildTar([{ name: "big", data: new Uint8Array(3000) }]);
    expect(inspectTar(big, { ...LIMITS, maxUnpackedBytes: 2999 })).toMatchObject({
      ok: false,
      why: "unpacks too large",
    });
  });

  it("hands each text file to the scan and stops at a block", () => {
    const tar = buildTar([
      { name: "ok.txt", data: text("fine") },
      { name: "bin", data: Uint8Array.from([0, 159, 146, 150]) },
      { name: "key.txt", data: text("SECRET-VALUE") },
    ]);
    const seen: string[] = [];
    const verdict = inspectTar(tar, LIMITS, (t, name) => {
      seen.push(name);
      return t.includes("SECRET") ? { code: "secret", rule: "secrets.test" } : null;
    });
    expect(verdict).toMatchObject({ ok: false, entry: "key.txt", block: { rule: "secrets.test" } });
    expect(seen).toEqual(["ok.txt", "key.txt"]);
  });
});

describe("inspectGzip", () => {
  it("reads a tar.gz as a tar, and a single file as a file", async () => {
    const tgz = gzipSync(buildTar([{ name: "a.txt", data: text("hello") }]));
    expect(isGzip(tgz)).toBe(true);
    expect(await inspectGzip(tgz, LIMITS)).toEqual({ ok: true, entries: 1, unpacked: 5 });
    expect(await inspectGzip(gzipSync(text("one file")), LIMITS)).toEqual({
      ok: true,
      entries: 1,
      unpacked: 8,
    });
    const bad = gzipSync(buildTar([{ name: "../x", data: text("a") }]));
    expect(await inspectGzip(bad, LIMITS)).toMatchObject({ ok: false });
  });

  it("scans the text of a single gzipped file", async () => {
    const verdict = await inspectGzip(gzipSync(text("SECRET-VALUE")), LIMITS, (t) =>
      t.includes("SECRET") ? { code: "secret", rule: "secrets.test" } : null,
    );
    expect(verdict).toMatchObject({ ok: false, block: { rule: "secrets.test" } });
  });

  it("stops a small file that unpacks to a mountain, at the cap", async () => {
    const bomb = gzipSync(new Uint8Array(8 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(20_000);
    expect(await inspectGzip(bomb, LIMITS)).toMatchObject({ ok: false, why: "unpacks too large" });
  });

  it("refuses broken data and anything after the gzip", async () => {
    const good = gzipSync(text("hello"));
    expect(await inspectGzip(good.subarray(0, good.length - 6), LIMITS)).toMatchObject({
      ok: false,
    });
    expect(await inspectGzip(Buffer.concat([good, text("SECRET-TRAILER")]), LIMITS)).toMatchObject({
      ok: false,
    });
  });
});

describe("the formats it cannot read", () => {
  it("names 7z, rar, xz, bzip2 and zstd by their first bytes", () => {
    expect(isUnreadableArchive(Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]))).toBe(
      true,
    );
    expect(isUnreadableArchive(Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0, 0]))).toBe(
      true,
    );
    expect(isUnreadableArchive(Uint8Array.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]))).toBe(true);
    expect(isUnreadableArchive(text("BZh91AY&SY"))).toBe(true);
    expect(isUnreadableArchive(Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0]))).toBe(true);
    expect(isUnreadableArchive(text("plain text"))).toBe(false);
    expect(isUnreadableArchive(gzipSync(text("x")))).toBe(false);
  });
});
