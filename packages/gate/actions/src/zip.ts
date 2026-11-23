// A zip (and docx, xlsx, pptx, which are zips) is judged by its central directory alone: nothing
// is unpacked. Refused: names that climb out (`..`, absolute, a drive letter), links, more
// entries than the limit, a total unpacked size over the limit (zip bombs), entries whose data
// overlap (the bombs that reuse one compressed block), and a listing that does not add up.

/** The zip family the store keeps (by declared type; the bytes are a zip either way). */
export const ZIP_MIMES: readonly string[] = [
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
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

export type ZipVerdict =
  | { ok: true; entries: number; unpacked: number }
  | { ok: false; why: string };

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const U32_MAX = 0xffffffff;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** Whether an entry name stays inside the folder it is unpacked into. */
export function safeEntryName(name: string): boolean {
  if (name === "" || name.includes("\0")) return false;
  if (/^[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) return false;
  return !name.split(/[\\/]/).some((part) => part === "..");
}

/** The archive's listing against `limits`, without unpacking anything. */
export function inspectZip(bytes: Uint8Array, limits: ZipLimits): ZipVerdict {
  try {
    return listing(bytes, limits);
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, why: "broken zip directory" };
    throw error;
  }
}

function listing(bytes: Uint8Array, limits: ZipLimits): ZipVerdict {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  const u64 = (at: number) => Number(view.getBigUint64(at, true));
  const refuse = (why: string): ZipVerdict => ({ ok: false, why });

  // The end record is in the last 22 + 65535 (comment) bytes.
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (u32(at) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return refuse("no zip directory");
  let count = u16(eocd + 10);
  let size = u32(eocd + 12);
  let offset = u32(eocd + 16);
  if (count === 0xffff || size === U32_MAX || offset === U32_MAX) {
    const locator = eocd - 20;
    if (locator < 0 || u32(locator) !== ZIP64_LOCATOR) return refuse("broken zip64 directory");
    const record = u64(locator + 8);
    if (record < 0 || record + 56 > locator || u32(record) !== ZIP64_EOCD) {
      return refuse("broken zip64 directory");
    }
    count = u64(record + 32);
    size = u64(record + 40);
    offset = u64(record + 48);
  }
  if (count > limits.maxEntries) return refuse(`more than ${limits.maxEntries} files`);
  if (offset + size > eocd) return refuse("the zip directory does not fit");

  const spans: { start: number; length: number }[] = [];
  let unpacked = 0;
  let at = offset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > offset + size || u32(at) !== CENTRAL) return refuse("broken zip directory");
    const packed = u32(at + 20);
    const plain = u32(at + 24);
    const nameLength = u16(at + 28);
    const extraLength = u16(at + 30);
    const commentLength = u16(at + 32);
    const mode = u32(at + 38) >>> 16;
    const local = u32(at + 42);
    if (at + 46 + nameLength > offset + size) return refuse("broken zip directory");
    const name = new TextDecoder("utf-8").decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (!safeEntryName(name)) return refuse("a file name leaves the folder");
    if ((mode & S_IFMT) === S_IFLNK) return refuse("contains a link");
    // A size kept in zip64 extras is over 4 GiB: over any limit.
    if (packed === U32_MAX || plain === U32_MAX || local === U32_MAX) {
      return refuse("unpacks too large");
    }
    unpacked += plain;
    if (unpacked > limits.maxUnpackedBytes) return refuse("unpacks too large");
    spans.push({ start: local, length: 30 + nameLength + packed });
    at += 46 + nameLength + extraLength + commentLength;
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    const before = spans[i - 1] as { start: number; length: number };
    if (before.start + before.length > (spans[i] as { start: number }).start) {
      return refuse("entries overlap");
    }
  }
  return { ok: true, entries: count, unpacked };
}
