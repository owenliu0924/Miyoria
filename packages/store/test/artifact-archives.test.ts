// The archive types the store keeps next to zips: gzip, tar, and the zip-based documents that are
// declared as OpenDocument or epub. Decided from the bytes, as every other type.

import { describe, expect, it } from "vitest";
import { ArtifactTypeError, decideType, SNIFF_BYTES, sniff } from "../src/index.js";

const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);

/** The first block of a POSIX tar: the `ustar` magic is at byte 257. */
function tarHead(): Uint8Array {
  const head = new Uint8Array(SNIFF_BYTES);
  head.set(new TextEncoder().encode("a.txt"), 0);
  head.set(new TextEncoder().encode("ustar\0"), 257);
  return head;
}

describe("archive media types", () => {
  it("looks far enough into the head to see a tar", () => {
    expect(SNIFF_BYTES).toBeGreaterThanOrEqual(262);
    expect(sniff(tarHead())).toMatchObject({ mime: "application/x-tar", kind: "document" });
    expect(decideType(tarHead(), false, null).extension).toBe("tar");
    // The head of a shorter file is shorter: no magic there is no tar.
    expect(sniff(tarHead().subarray(0, 200))).toBeNull();
  });

  it("takes gzip by its magic and the aliases that name it", () => {
    const gz = Uint8Array.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0]);
    expect(sniff(gz)).toMatchObject({ mime: "application/gzip", extension: "gz" });
    expect(decideType(gz, false, "application/x-gzip").mime).toBe("application/gzip");
    expect(decideType(tarHead(), false, "application/x-gtar").mime).toBe("application/x-tar");
    expect(() => decideType(gz, false, "application/zip")).toThrow(ArtifactTypeError);
  });

  it("a zip may be declared as an OpenDocument or epub type, and as nothing else", () => {
    expect(decideType(ZIP, false, "application/vnd.oasis.opendocument.spreadsheet")).toMatchObject({
      extension: "ods",
    });
    expect(decideType(ZIP, false, "application/vnd.oasis.opendocument.text").extension).toBe("odt");
    expect(
      decideType(ZIP, false, "application/vnd.oasis.opendocument.presentation").extension,
    ).toBe("odp");
    expect(decideType(ZIP, false, "application/epub+zip").extension).toBe("epub");
    expect(decideType(ZIP, false, null).mime).toBe("application/zip");
    expect(() => decideType(ZIP, false, "application/gzip")).toThrow(ArtifactTypeError);
  });

  it("does not take 7z or rar", () => {
    const sevenZip = Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]);
    const rar = Uint8Array.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0, 1]);
    expect(() => decideType(sevenZip, false, null)).toThrow(ArtifactTypeError);
    expect(() => decideType(rar, false, null)).toThrow(ArtifactTypeError);
  });

  it("looks for the Theora and WebM markers where it always did, not further in", () => {
    const ogg = new Uint8Array(200);
    ogg.set(new TextEncoder().encode("OggS"), 0);
    ogg.set(new TextEncoder().encode("theora"), 150);
    expect(sniff(ogg)?.mime).toBe("audio/ogg");
  });
});
