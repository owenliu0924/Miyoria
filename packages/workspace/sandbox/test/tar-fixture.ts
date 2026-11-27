// Builds small tars for the tests, with ways to lie in the headers.

export interface TarEntry {
  name: string;
  data?: Uint8Array;
  /** Type flag: "0" file (default), "5" folder, "2" symlink, "1" hard link, "3" device. */
  flag?: string;
  /** The `x` pax header written before the entry, as `key=value` pairs. */
  pax?: Record<string, string>;
  /** A GNU long name (`L` entry) written before the entry. */
  longName?: string;
  /** Written into the padding after the data. */
  padding?: Uint8Array;
  /** Make the header checksum wrong. */
  badChecksum?: boolean;
}

export interface TarOptions {
  /** Bytes after the two zero blocks. */
  trailing?: Uint8Array;
  /** Leave out the zero blocks that end it. */
  noEnd?: boolean;
}

const enc = new TextEncoder();

function field(text: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  out.set(enc.encode(text).subarray(0, length));
  return out;
}

function header(name: string, size: number, flag: string, bad = false): Uint8Array {
  const h = new Uint8Array(512);
  h.set(field(name, 100), 0);
  h.set(field("0000644\0", 8), 100);
  h.set(field("0000000\0", 8), 108);
  h.set(field("0000000\0", 8), 116);
  h.set(field(`${size.toString(8).padStart(11, "0")}\0`, 12), 124);
  h.set(field("00000000000\0", 12), 136);
  h.fill(0x20, 148, 156);
  h[156] = flag.charCodeAt(0);
  h.set(field("ustar\0", 6), 257);
  h.set(field("00", 2), 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.set(field(`${(bad ? sum + 1 : sum).toString(8).padStart(6, "0")}\0 `, 8), 148);
  return h;
}

function block(name: string, data: Uint8Array, flag: string, padding?: Uint8Array, bad = false) {
  const padded = Math.ceil(data.length / 512) * 512;
  const out = new Uint8Array(512 + padded);
  out.set(header(name, data.length, flag, bad), 0);
  out.set(data, 512);
  if (padding !== undefined) out.set(padding, 512 + data.length);
  return out;
}

function pax(records: Record<string, string>): Uint8Array {
  const parts = Object.entries(records).map(([k, v]) => {
    const body = ` ${k}=${v}\n`;
    let length = body.length + 1;
    while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
    return `${length}${body}`;
  });
  return enc.encode(parts.join(""));
}

export function buildTar(entries: readonly TarEntry[], options: TarOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const e of entries) {
    if (e.pax !== undefined) parts.push(block("PaxHeader", pax(e.pax), "x"));
    if (e.longName !== undefined) {
      parts.push(block("././@LongLink", enc.encode(`${e.longName}\0`), "L"));
    }
    parts.push(block(e.name, e.data ?? new Uint8Array(), e.flag ?? "0", e.padding, e.badChecksum));
  }
  if (options.noEnd !== true) parts.push(new Uint8Array(1024));
  if (options.trailing !== undefined) parts.push(options.trailing);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
