import { describe, expect, it } from "vitest";
import { inspectZip, isZip, safeEntryName } from "../src/index.js";
import { buildZip } from "./zip-fixture.js";

const LIMITS = { maxUnpackedBytes: 1024 * 1024, maxEntries: 10 };
const bytes = (n: number) => new Uint8Array(n).fill(65);
const text = (s: string) => new TextEncoder().encode(s);

describe("zip listing", () => {
  it("takes an ordinary archive, stored or deflated, with or without data descriptors", async () => {
    const zip = buildZip([
      { name: "report/summary.md", data: bytes(100) },
      { name: "report/data.csv", data: bytes(50), deflate: true },
      { name: "report/notes.txt", data: bytes(30), deflate: true, descriptor: true },
      { name: "report/" },
    ]);
    expect(isZip(zip)).toBe(true);
    expect(await inspectZip(zip, LIMITS)).toEqual({ ok: true, entries: 4, unpacked: 180 });
    expect(await inspectZip(buildZip([]), LIMITS)).toEqual({ ok: true, entries: 0, unpacked: 0 });
  });

  it("refuses names that leave the folder, with either separator", async () => {
    for (const name of [
      "../evil.txt",
      "a/../../evil.txt",
      "a\\..\\..\\evil.txt",
      "/etc/passwd",
      "\\windows\\evil.dll",
      "C:/evil.txt",
      "c:\\evil.txt",
      "nul\0byte",
    ]) {
      const zip = buildZip([
        { name: "ok.txt", data: bytes(3) },
        { name, data: bytes(3) },
      ]);
      expect(await inspectZip(zip, LIMITS), name).toEqual({
        ok: false,
        why: "a file name leaves the folder",
      });
    }
    expect(safeEntryName("a..b/c")).toBe(true);
  });

  it("refuses a bomb: a listing over the limit, too many entries, or overlapping data", async () => {
    const big = buildZip([{ name: "big.bin", data: bytes(10), claimedSize: 2 * 1024 * 1024 }]);
    expect(await inspectZip(big, LIMITS)).toMatchObject({ ok: false });
    const listed = buildZip([
      { name: "a.bin", data: new Uint8Array(600 * 1024), deflate: true },
      { name: "b.bin", data: new Uint8Array(600 * 1024), deflate: true },
    ]);
    expect(await inspectZip(listed, LIMITS)).toEqual({ ok: false, why: "unpacks too large" });
    const huge = buildZip([{ name: "big.bin", data: bytes(10), claimedSize: 0xffffffff }]);
    expect(await inspectZip(huge, { ...LIMITS, maxUnpackedBytes: 2 ** 40 })).toMatchObject({
      ok: false,
    });
    const many = buildZip(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt` })));
    expect(await inspectZip(many, LIMITS)).toEqual({ ok: false, why: "more than 10 files" });
    const overlap = buildZip([
      { name: "a.txt", data: bytes(40) },
      { name: "b.txt", data: bytes(40), sameDataAs: 0 },
    ]);
    expect(await inspectZip(overlap, LIMITS)).toEqual({ ok: false, why: "entries overlap" });
  });

  it("inflates deflate data under a cap: 64 MiB behind a 10-byte record is caught at once", async () => {
    const zip = buildZip([
      { name: "small.txt", data: new Uint8Array(64 * 1024 * 1024), deflate: true, claimedSize: 10 },
    ]);
    // The compressed data is small: only the record lies.
    expect(zip.length).toBeLessThan(200 * 1024);
    const started = Date.now();
    expect(await inspectZip(zip, LIMITS)).toMatchObject({
      ok: false,
      why: "unpacks to more than its record says",
    });
    expect(Date.now() - started).toBeLessThan(5000);
    const over = buildZip([{ name: "a.txt", data: bytes(100), deflate: true, claimedSize: 200 }]);
    expect(await inspectZip(over, LIMITS)).toMatchObject({
      ok: false,
      why: "unpacks to less than its record says",
    });
    const stored = buildZip([{ name: "a.txt", data: bytes(100), claimedSize: 10 }]);
    expect(await inspectZip(stored, LIMITS)).toEqual({ ok: false, why: "sizes do not match" });
  });

  it("refuses a local entry the directory never names, whatever its name", async () => {
    for (const name of [
      "../../evil.bat",
      "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/run.bat",
      "plain.txt",
    ]) {
      const zip = buildZip([
        { name: "ok.txt", data: bytes(3) },
        { name, data: text("echo hi\r\n"), hidden: true },
        { name: "also-ok.txt", data: bytes(3) },
      ]);
      expect(await inspectZip(zip, LIMITS), name).toEqual({
        ok: false,
        why: "a part of the archive is not in its directory",
      });
    }
    const last = buildZip([
      { name: "ok.txt", data: bytes(3) },
      { name: "../x.bat", data: bytes(3), hidden: true },
    ]);
    expect(await inspectZip(last, LIMITS)).toMatchObject({ ok: false });
    const gap = buildZip([{ name: "ok.txt", data: bytes(3) }], { gap: bytes(64) });
    expect(await inspectZip(gap, LIMITS)).toMatchObject({ ok: false });
    const trailing = buildZip([{ name: "ok.txt", data: bytes(3) }], { trailing: bytes(8) });
    expect(await inspectZip(trailing, LIMITS)).toEqual({
      ok: false,
      why: "data after the zip directory",
    });
  });

  it("refuses more directory records than the end record declares", async () => {
    const zip = buildZip(
      [
        { name: "a.txt", data: bytes(3) },
        { name: "../b.bat", data: bytes(3) },
      ],
      { declaredCount: 1 },
    );
    expect(await inspectZip(zip, LIMITS)).toEqual({
      ok: false,
      why: "the zip directory holds more than it lists",
    });
  });

  it("refuses a stored zip of bytes under 0x80 that workspace_write could create", async () => {
    // Every byte below 0x80, so it survives a round trip through UTF-8 text.
    const zip = buildZip([
      { name: "a.txt", data: text("hi"), mode: 0, crc: 0x01020304 },
      { name: "../../x.bat", data: text("calc"), mode: 0, crc: 0x01020304, hidden: true },
    ]);
    expect(zip.every((b) => b < 0x80)).toBe(true);
    const round = new TextEncoder().encode(new TextDecoder().decode(zip));
    expect(round).toEqual(zip);
    expect(isZip(round)).toBe(true);
    expect(await inspectZip(round, LIMITS)).toMatchObject({ ok: false });
  });

  it("refuses a local header that does not match its record", async () => {
    const renamed = buildZip([{ name: "a.txt", localName: "../a.bat", data: bytes(3) }]);
    expect(await inspectZip(renamed, LIMITS)).toEqual({
      ok: false,
      why: "a file's header does not match the directory",
    });
    const lying = buildZip([
      { name: "a.txt", data: bytes(30), descriptor: true, descriptorSize: 3 },
    ]);
    expect(await inspectZip(lying, LIMITS)).toEqual({
      ok: false,
      why: "a data descriptor does not match the directory",
    });
  });

  it("refuses zip64, encryption, other compressions and archives split over disks", async () => {
    const encrypted = buildZip([{ name: "a.txt", data: bytes(3), flags: 1 }]);
    expect(await inspectZip(encrypted, LIMITS)).toEqual({ ok: false, why: "encrypted" });
    const zip = buildZip([{ name: "a.txt", data: bytes(3) }]);
    const view = (z: Uint8Array) => new DataView(z.buffer, z.byteOffset, z.byteLength);
    const disks = zip.slice();
    view(disks).setUint16(disks.length - 22 + 4, 1, true);
    expect(await inspectZip(disks, LIMITS)).toEqual({ ok: false, why: "split over disks" });
    const zip64 = zip.slice();
    view(zip64).setUint32(zip64.length - 22 + 16, 0xffffffff, true);
    expect(await inspectZip(zip64, LIMITS)).toEqual({ ok: false, why: "zip64 is not taken" });
    // Method 12 (bzip2) in both headers.
    const bzip = zip.slice();
    const central = bzip.length - 22 - 46 - 5;
    view(bzip).setUint16(8, 12, true);
    view(bzip).setUint16(central + 10, 12, true);
    expect(await inspectZip(bzip, LIMITS)).toEqual({
      ok: false,
      why: "a compression it cannot check",
    });
  });

  it("refuses links and broken archives", async () => {
    const link = buildZip([{ name: "link", data: bytes(5), mode: 0o120777 }]);
    expect(await inspectZip(link, LIMITS)).toEqual({ ok: false, why: "contains a link" });
    expect(await inspectZip(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), LIMITS)).toEqual(
      {
        ok: false,
        why: "no zip directory",
      },
    );
    const zip = buildZip([{ name: "a.txt", data: bytes(40) }]);
    const cut = zip.slice();
    // The directory claims to start past where it can.
    new DataView(cut.buffer).setUint32(cut.length - 6, 0x7fff_ffff, true);
    expect(await inspectZip(cut, LIMITS)).toMatchObject({ ok: false });
    const broken = buildZip([{ name: "a.txt", data: bytes(40), deflate: true }]);
    const flipped = broken.slice();
    // The deflate data, cut short and garbled.
    flipped.fill(0xff, 30 + 5, 30 + 5 + 3);
    expect(await inspectZip(flipped, LIMITS)).toMatchObject({ ok: false });
  });

  it("passes every text entry to the scan, Office XML also without its tags", async () => {
    const seen: string[] = [];
    const scan = (t: string, name: string) => {
      seen.push(name);
      return t.includes("sk-secretvalue") ? { code: "secret", rule: "secrets.test" } : null;
    };
    const clean = buildZip([
      { name: "a.md", data: text("# fine\n"), deflate: true },
      { name: "b.bin", data: Uint8Array.from([0, 1, 2, 255]) },
    ]);
    expect(await inspectZip(clean, LIMITS, scan)).toMatchObject({ ok: true });
    expect(seen).toEqual(["a.md"]);
    const leaky = buildZip([
      { name: "a.md", data: text("# fine\n") },
      { name: "deep/config.env", data: text("KEY=sk-secretvalue\n"), deflate: true },
    ]);
    expect(await inspectZip(leaky, LIMITS, scan)).toEqual({
      ok: false,
      why: "holds what the output checks block",
      block: { code: "secret", rule: "secrets.test" },
      entry: "deep/config.env",
    });
    // A Word document splits text into runs.
    const docx = buildZip([
      {
        name: "word/document.xml",
        data: text("<w:p><w:r><w:t>sk-secret</w:t></w:r><w:r><w:t>value</w:t></w:r></w:p>"),
        deflate: true,
      },
    ]);
    expect(await inspectZip(docx, LIMITS, scan)).toMatchObject({
      ok: false,
      block: { rule: "secrets.test" },
    });
  });
});
