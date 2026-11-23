// Builds small zips for the tests, stored or deflated, with ways to lie in the listing.

import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  data?: Uint8Array;
  /** Deflate the data (default: stored). */
  deflate?: boolean;
  /** What both headers claim the entry unpacks to (default: its real size). */
  claimedSize?: number;
  /** Unix mode in the external attributes (e.g. 0o120777 for a link); 0: none. */
  mode?: number;
  /** Point this entry's data at another entry's local header (an overlap). */
  sameDataAs?: number;
  /** Written as a local entry only: the central directory never names it. */
  hidden?: boolean;
  /** General purpose flags of both headers (e.g. 1: encrypted). */
  flags?: number;
  /** The name in the local header, when it differs from the directory's. */
  localName?: string;
  /** Sizes and CRC after the data (flag bit 3), the local header's left at zero. */
  descriptor?: boolean;
  /** The descriptor's unpacked size, when it lies. */
  descriptorSize?: number;
  /** The CRC both headers record (default: the real one). */
  crc?: number;
}

export interface ZipOptions {
  /** The entry count the end record declares (default: the directory's records). */
  declaredCount?: number;
  /** Bytes put between the last entry and the directory. */
  gap?: Uint8Array;
  /** Bytes after the end record. */
  trailing?: Uint8Array;
}

export function buildZip(entries: readonly ZipEntry[], options: ZipOptions = {}): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const offsets: number[] = [];
  const packedOf: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data ?? new Uint8Array();
    const packed = e.deflate === true ? new Uint8Array(deflateRawSync(data)) : data;
    const crc = e.crc ?? (data.length === 0 ? 0 : crc32(data));
    const name = enc.encode(e.localName ?? e.name);
    const flags = (e.flags ?? 0) | (e.descriptor === true ? 8 : 0);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, flags, true);
    h.setUint16(8, e.deflate === true ? 8 : 0, true);
    if (e.descriptor !== true) {
      h.setUint32(14, crc, true);
      h.setUint32(18, packed.length, true);
      h.setUint32(22, e.claimedSize ?? data.length, true);
    }
    h.setUint16(26, name.length, true);
    const parts = [new Uint8Array(h.buffer), name, packed];
    if (e.descriptor === true) {
      const d = new DataView(new ArrayBuffer(16));
      d.setUint32(0, 0x08074b50, true);
      d.setUint32(4, crc, true);
      d.setUint32(8, packed.length, true);
      d.setUint32(12, e.descriptorSize ?? data.length, true);
      parts.push(new Uint8Array(d.buffer));
    }
    const local = concat(parts);
    offsets.push(offset);
    locals.push(local);
    packedOf.push(packed);
    offset += local.length;
  }
  const gap = options.gap ?? new Uint8Array();
  const centrals: Uint8Array[] = [];
  entries.forEach((e, i) => {
    if (e.hidden === true) return;
    const name = enc.encode(e.name);
    const data = e.data ?? new Uint8Array();
    const packed = packedOf[i] as Uint8Array;
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 0x031e, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, (e.flags ?? 0) | (e.descriptor === true ? 8 : 0), true);
    c.setUint16(10, e.deflate === true ? 8 : 0, true);
    c.setUint32(16, e.crc ?? (data.length === 0 ? 0 : crc32(data)), true);
    c.setUint32(20, packed.length, true);
    c.setUint32(24, e.claimedSize ?? data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(38, ((e.mode ?? 0o100644) << 16) >>> 0, true);
    c.setUint32(42, offsets[e.sameDataAs ?? i] as number, true);
    centrals.push(concat([new Uint8Array(c.buffer), name]));
  });
  const directory = concat(centrals);
  const count = options.declaredCount ?? centrals.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, count, true);
  end.setUint16(10, count, true);
  end.setUint32(12, directory.length, true);
  end.setUint32(16, offset + gap.length, true);
  return concat([
    ...locals,
    gap,
    directory,
    new Uint8Array(end.buffer),
    options.trailing ?? new Uint8Array(),
  ]);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
