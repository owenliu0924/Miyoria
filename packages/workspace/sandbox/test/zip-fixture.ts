// Builds small stored (uncompressed) zips for the tests, with ways to lie in the listing.

export interface ZipEntry {
  name: string;
  data?: Uint8Array;
  /** What the central directory claims the entry unpacks to (default: its real size). */
  claimedSize?: number;
  /** Unix mode in the external attributes (e.g. 0o120777 for a link). */
  mode?: number;
  /** Point this entry's data at another entry's local header (an overlap). */
  sameDataAs?: number;
}

export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = e.data ?? new Uint8Array();
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true);
    const local = concat([new Uint8Array(h.buffer), name, data]);
    offsets.push(offset);
    locals.push(local);
    offset += local.length;
  }
  const centrals: Uint8Array[] = [];
  entries.forEach((e, i) => {
    const name = enc.encode(e.name);
    const data = e.data ?? new Uint8Array();
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 0x031e, true);
    c.setUint16(6, 20, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, e.claimedSize ?? data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(38, ((e.mode ?? 0o100644) << 16) >>> 0, true);
    c.setUint32(42, offsets[e.sameDataAs ?? i] as number, true);
    centrals.push(concat([new Uint8Array(c.buffer), name]));
  });
  const directory = concat(centrals);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directory.length, true);
  end.setUint32(16, offset, true);
  return concat([...locals, directory, new Uint8Array(end.buffer)]);
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
