// A zip (and docx, xlsx, pptx, which are zips) is read the way an unpacker reads it, in memory,
// and nothing is ever written to disk. The central directory is not trusted alone: every local
// file header must belong to exactly one directory record with the same name, flags, method and
// sizes, and the entries, the directory and its end record must cover the archive end to end with
// no gap (where a hidden entry could sit) and no overlap (the bombs that reuse one compressed
// block). Deflated data is really inflated, under a running byte cap, so a record that understates
// what an entry unpacks to is caught; the output is counted and dropped, except a text entry's,
// which a caller may scan (`ZipTextScan`). Refused besides: names that climb out (`..`, absolute,
// a drive letter), links, more entries or more unpacked bytes than the limits, zip64, encryption,
// archives split over disks, compression other than stored and deflate, and data descriptors that
// do not match their record.

import { createInflateRaw } from "node:zlib";
import { TextCheck } from "@miyoria/store";

/**
 * The archive family the store keeps. The zips (by declared type; the bytes are a zip either way)
 * are read by `inspectZip`, a tar and a gzip by `tar.ts`; every one of them is read whole before
 * it goes out, which is what a caller checking membership of this list relies on.
 */
export const ZIP_MIMES: readonly string[] = [
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/epub+zip",
  "application/x-tar",
  "application/gzip",
];

/** Starts like a zip: a local file header, or the end record of an empty archive. */
export function isZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

export interface ZipLimits {
  /** All entries together, unpacked, in bytes. */
  maxUnpackedBytes: number;
  maxEntries: number;
}

/** What a scan of a text entry found: the rule it trips, and what kind of rule. */
export interface ZipBlock {
  code: string;
  rule: string;
}

/**
 * Called with the text of each entry that is text (`name` is the entry's); a block refuses the
 * whole zip. An Office XML part is also passed with its tags taken out, so a value split over
 * several runs of text is seen whole.
 */
export type ZipTextScan = (text: string, name: string) => ZipBlock | null;

export type ZipVerdict =
  | { ok: true; entries: number; unpacked: number }
  | { ok: false; why: string; block?: ZipBlock; entry?: string };

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const ZIP64_EXTRA = 0x0001;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
/** Flag bits: encrypted, has a data descriptor, strong encryption, UTF-8 name, masked directory. */
const F_ENCRYPTED = 1 << 0;
const F_DESCRIPTOR = 1 << 3;
const F_STRONG = 1 << 6;
const F_UTF8 = 1 << 11;
const F_MASKED = 1 << 13;
const STORED = 0;
const DEFLATE = 8;

/** Whether an entry name stays inside the folder it is unpacked into. */
export function safeEntryName(name: string): boolean {
  if (name === "" || name.includes("\0")) return false;
  if (/^[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) return false;
  return !name.split(/[\\/]/).some((part) => part === "..");
}

interface Entry {
  name: string;
  method: number;
  plain: number;
  /** Where its compressed data is. */
  start: number;
  packed: number;
}

type Listed = { ok: true; entries: Entry[]; unpacked: number } | { ok: false; why: string };

/**
 * The archive against `limits`, read in memory: its structure first, then every entry's data
 * (deflate inflated and counted, never kept but for a text entry `scan` reads).
 */
export async function inspectZip(
  bytes: Uint8Array,
  limits: ZipLimits,
  scan?: ZipTextScan,
): Promise<ZipVerdict> {
  let listed: Listed;
  try {
    listed = structure(bytes, limits);
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, why: "broken zip directory" };
    throw error;
  }
  if (!listed.ok) return listed;
  for (const e of listed.entries) {
    const data = bytes.subarray(e.start, e.start + e.packed);
    const out =
      e.method === DEFLATE
        ? await inflateCapped(data, e.plain, scan !== undefined)
        : stored(data, scan !== undefined);
    if (!out.ok) return { ok: false, why: out.why, entry: e.name };
    if (scan === undefined || out.text === null) continue;
    const block = scanEntry(scan, out.text, e.name);
    if (block !== null)
      return { ok: false, why: "holds what the output checks block", block, entry: e.name };
  }
  return { ok: true, entries: listed.entries.length, unpacked: listed.unpacked };
}

function structure(bytes: Uint8Array, limits: ZipLimits): Listed {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const refuse = (why: string): Listed => ({ ok: false, why });
  const n = bytes.length;

  // The end record is in the last 22 + 65535 (comment) bytes, and its comment reaches the end.
  let eocd = -1;
  let signature = false;
  for (let at = n - 22; at >= Math.max(0, n - 22 - U16_MAX); at--) {
    if (u32(at) !== EOCD) continue;
    signature = true;
    if (at + 22 + u16(at + 20) === n) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return refuse(signature ? "data after the zip directory" : "no zip directory");
  const disk = u16(eocd + 4);
  const directoryDisk = u16(eocd + 6);
  const onDisk = u16(eocd + 8);
  const count = u16(eocd + 10);
  const size = u32(eocd + 12);
  const offset = u32(eocd + 16);
  if (
    count === U16_MAX ||
    size === U32_MAX ||
    offset === U32_MAX ||
    (eocd >= 20 && u32(eocd - 20) === ZIP64_LOCATOR)
  ) {
    return refuse("zip64 is not taken");
  }
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== count) return refuse("split over disks");
  if (count > limits.maxEntries) return refuse(`more than ${limits.maxEntries} files`);
  // The directory sits right before its end record: nothing hides between them.
  if (offset + size !== eocd) return refuse("the zip directory does not fit");

  interface Record extends Entry {
    flags: number;
    crc: number;
    local: number;
    nameBytes: Uint8Array;
  }
  const records: Record[] = [];
  const names = new Set<string>();
  let unpacked = 0;
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || u32(at) !== CENTRAL) return refuse("broken zip directory");
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc = u32(at + 16);
    const packed = u32(at + 20);
    const plain = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const startDisk = u16(at + 34);
    const mode = u32(at + 38) >>> 16;
    const local = u32(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) return refuse("broken zip directory");
    const extra = bytes.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    if (packed === U32_MAX || plain === U32_MAX || local === U32_MAX || hasZip64(extra)) {
      return refuse("zip64 is not taken");
    }
    if (startDisk !== 0) return refuse("split over disks");
    if ((flags & (F_ENCRYPTED | F_STRONG | F_MASKED)) !== 0) return refuse("encrypted");
    if (method !== STORED && method !== DEFLATE) return refuse("a compression it cannot check");
    if (method === STORED && packed !== plain) return refuse("sizes do not match");
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    const name = entryName(nameBytes, flags);
    if (name === null) return refuse("a file name is not readable");
    if (!safeEntryName(name)) return refuse("a file name leaves the folder");
    if ((mode & S_IFMT) === S_IFLNK) return refuse("contains a link");
    const key = name.replaceAll("\\", "/");
    if (names.has(key)) return refuse("a file name is there twice");
    names.add(key);
    unpacked += plain;
    if (unpacked > limits.maxUnpackedBytes) return refuse("unpacks too large");
    records.push({ name, method, plain, start: 0, packed, flags, crc, local, nameBytes });
    at = next;
  }
  // More records than the end record declares are not skipped over.
  if (at !== eocd) return refuse("the zip directory holds more than it lists");

  // Every byte before the directory belongs to exactly one entry, in order.
  records.sort((a, b) => a.local - b.local);
  let cursor = 0;
  for (const r of records) {
    if (r.local > cursor) return refuse("a part of the archive is not in its directory");
    if (r.local < cursor) return refuse("entries overlap");
    if (r.local + 30 > offset || u32(r.local) !== LOCAL) return refuse("broken zip entry");
    const flags = u16(r.local + 6);
    const method = u16(r.local + 8);
    const crc = u32(r.local + 14);
    const packed = u32(r.local + 18);
    const plain = u32(r.local + 22);
    const nameLength = u16(r.local + 26);
    const extraLength = u16(r.local + 28);
    const start = r.local + 30 + nameLength + extraLength;
    if (start > offset) return refuse("broken zip entry");
    const nameBytes = bytes.subarray(r.local + 30, r.local + 30 + nameLength);
    if (flags !== r.flags || method !== r.method || !sameBytes(nameBytes, r.nameBytes)) {
      return refuse("a file's header does not match the directory");
    }
    if (hasZip64(bytes.subarray(r.local + 30 + nameLength, start))) {
      return refuse("zip64 is not taken");
    }
    let end = start + r.packed;
    if (end > offset) return refuse("broken zip entry");
    const same = crc === r.crc && packed === r.packed && plain === r.plain;
    if ((flags & F_DESCRIPTOR) === 0) {
      if (!same) return refuse("a file's header does not match the directory");
    } else {
      // The header may leave the sizes at zero; the descriptor after the data must match.
      if (!same && (crc !== 0 || packed !== 0 || plain !== 0)) {
        return refuse("a file's header does not match the directory");
      }
      const fits = (d: number) =>
        d + 12 <= offset && u32(d) === r.crc && u32(d + 4) === r.packed && u32(d + 8) === r.plain;
      if (end + 16 <= offset && u32(end) === DESCRIPTOR && fits(end + 4)) end += 16;
      else if (fits(end)) end += 12;
      else return refuse("a data descriptor does not match the directory");
    }
    r.start = start;
    cursor = end;
  }
  if (cursor !== offset) return refuse("a part of the archive is not in its directory");
  return { ok: true, entries: records, unpacked };
}

/** Whether an extra field holds a zip64 record. */
function hasZip64(extra: Uint8Array): boolean {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  for (let at = 0; at + 4 <= extra.length; ) {
    if (view.getUint16(at, true) === ZIP64_EXTRA) return true;
    at += 4 + view.getUint16(at + 2, true);
  }
  return false;
}

/** An entry's name: UTF-8 when flagged (and valid), else each byte as one character. */
function entryName(bytes: Uint8Array, flags: number): string | null {
  if ((flags & F_UTF8) === 0) return String.fromCharCode(...bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

type Content = { ok: true; text: string | null } | { ok: false; why: string };

/** A stored entry's data: its text when `keep` and it is text. */
function stored(data: Uint8Array, keep: boolean): Content {
  if (!keep) return { ok: true, text: null };
  const check = new TextCheck();
  check.push(data);
  return { ok: true, text: check.end() ? new TextDecoder("utf-8").decode(data) : null };
}

/**
 * Inflates `data`, stopping as soon as it unpacks to more than `plain` bytes (what its record
 * says), so a record that understates an entry costs at most one chunk past that. The output is
 * counted and dropped; with `keep`, a text entry's is kept for the scan.
 */
function inflateCapped(data: Uint8Array, plain: number, keep: boolean): Promise<Content> {
  return new Promise((resolve) => {
    const inflate = createInflateRaw();
    const check = keep ? new TextCheck() : null;
    let chunks: Buffer[] | null = keep ? [] : null;
    let size = 0;
    let settled = false;
    const finish = (out: Content) => {
      if (settled) return;
      settled = true;
      inflate.destroy();
      resolve(out);
    };
    inflate.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > plain) {
        finish({ ok: false, why: "unpacks to more than its record says" });
        return;
      }
      if (check === null || chunks === null) return;
      check.push(chunk);
      if (check.ok) chunks.push(chunk);
      else chunks = null;
    });
    inflate.on("error", () => finish({ ok: false, why: "broken compressed data" }));
    inflate.on("end", () => {
      if (size !== plain) {
        finish({ ok: false, why: "unpacks to less than its record says" });
        return;
      }
      const text =
        check !== null && chunks !== null && check.end()
          ? new TextDecoder("utf-8").decode(Buffer.concat(chunks))
          : null;
      finish({ ok: true, text });
    });
    inflate.end(data);
  });
}

/**
 * The scan of one text entry; an XML part (Office documents keep their text in them) is seen
 * once more without its tags. Base64 and other encodings inside an entry are not decoded: a
 * credential hidden that way is out of reach of this check.
 */
function scanEntry(scan: ZipTextScan, text: string, name: string): ZipBlock | null {
  const found = scan(text, name);
  if (found !== null) return found;
  if (!/\.(?:xml|rels)$/i.test(name)) return null;
  return scan(text.replace(/<[^>]*>/g, ""), name);
}
