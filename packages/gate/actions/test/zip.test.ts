import { describe, expect, it } from "vitest";
import { inspectZip, isZip, safeEntryName } from "../src/index.js";
import { buildZip } from "./zip-fixture.js";

const LIMITS = { maxUnpackedBytes: 1024 * 1024, maxEntries: 10 };
const bytes = (n: number) => new Uint8Array(n).fill(65);

describe("zip listing", () => {
  it("takes an ordinary archive", () => {
    const zip = buildZip([
      { name: "report/summary.md", data: bytes(100) },
      { name: "report/data.csv", data: bytes(50) },
      { name: "report/" },
    ]);
    expect(isZip(zip)).toBe(true);
    expect(inspectZip(zip, LIMITS)).toEqual({ ok: true, entries: 3, unpacked: 150 });
  });

  it("refuses names that leave the folder, with either separator", () => {
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
      expect(inspectZip(zip, LIMITS), name).toEqual({
        ok: false,
        why: "a file name leaves the folder",
      });
    }
    expect(safeEntryName("a..b/c")).toBe(true);
  });

  it("refuses a bomb: a listing that unpacks over the limit, too many entries, or overlapping data", () => {
    const bomb = buildZip([{ name: "big.bin", data: bytes(10), claimedSize: 2 * 1024 * 1024 }]);
    expect(inspectZip(bomb, LIMITS)).toEqual({ ok: false, why: "unpacks too large" });
    const huge = buildZip([{ name: "big.bin", data: bytes(10), claimedSize: 0xffffffff }]);
    expect(inspectZip(huge, { ...LIMITS, maxUnpackedBytes: 2 ** 40 })).toMatchObject({
      ok: false,
    });
    const many = buildZip(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt` })));
    expect(inspectZip(many, LIMITS)).toEqual({ ok: false, why: "more than 10 files" });
    const overlap = buildZip([
      { name: "a.txt", data: bytes(40) },
      { name: "b.txt", data: bytes(40), sameDataAs: 0 },
    ]);
    expect(inspectZip(overlap, LIMITS)).toEqual({ ok: false, why: "entries overlap" });
  });

  it("refuses links and broken archives", () => {
    const link = buildZip([{ name: "link", data: bytes(5), mode: 0o120777 }]);
    expect(inspectZip(link, LIMITS)).toEqual({ ok: false, why: "contains a link" });
    expect(inspectZip(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]), LIMITS)).toEqual({
      ok: false,
      why: "no zip directory",
    });
    const zip = buildZip([{ name: "a.txt", data: bytes(40) }]);
    const cut = zip.slice();
    // The directory claims to start past where it can.
    new DataView(cut.buffer).setUint32(cut.length - 6, 0x7fff_ffff, true);
    expect(inspectZip(cut, LIMITS)).toMatchObject({ ok: false });
  });
});
