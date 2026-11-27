// A tar (and tar.gz, tgz, and a single gzipped file) is read the way an unpacker reads it, in
// memory, and nothing is ever written to disk: the same rules as `zip.ts`, for the formats the
// store keeps next to zips. The header of every entry must be a valid one (checksum included),
// the entries must cover the archive end to end with nothing in the padding and nothing after the
// end marker, and these are refused: names that climb out (`..`, absolute, a drive letter), links,
// devices and any other entry that is not a file or a folder, a name that is there twice, more
// entries or more unpacked bytes than the limits. A gzip is inflated under the same byte cap
// (so a small file that unpacks to a mountain is stopped at the cap), must hold exactly one gzip
// member with nothing after it, and what it holds is a tar (read as one) or one file.
//
// The reader is written here, not taken from a package: the strictness above is the point, and
// `tar-stream` is not a dependency of this package.

import { createGunzip } from "node:zlib";
import { TextCheck } from "@miyoria/store";
import {
  safeEntryName,
  type ZipBlock,
  type ZipLimits,
  type ZipTextScan,
  type ZipVerdict,
} from "./zip.js";

const BLOCK = 512;

/** Whether `bytes` starts like a gzip stream (magic and the deflate method). */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;
}

/** Whether `bytes` starts like a POSIX tar: a first header with the `ustar` magic. */
export function isTar(bytes: Uint8Array): boolean {
  if (bytes.length < BLOCK) return false;
  const magic = String.fromCharCode(...bytes.subarray(257, 262));
  return magic === "ustar";
}

/** Compressed archives it cannot look inside: 7z, rar, xz, bzip2, zstd, lzip (by their magic). */
const UNREADABLE: readonly (readonly number[])[] = [
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], // rar
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // xz
  [0x42, 0x5a, 0x68], // bzip2
  [0x28, 0xb5, 0x2f, 0xfd], // zstd
  [0x4c, 0x5a, 0x49, 0x50], // lzip
];

/** The archive formats it cannot read the inside of: told to the person, who can use zip. */
export function isUnreadableArchive(bytes: Uint8Array): boolean {
  return UNREADABLE.some(
    (magic) => bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b),
  );
}

/** What she says when she is handed one of those. */
export const UNREADABLE_ARCHIVE = "這種壓縮檔我沒辦法先檢查裡面,改用 zip";

function text0(bytes: Uint8Array, from: number, to: number): string {
  let end = from;
  while (end < to && bytes[end] !== 0) end++;
  return new TextDecoder("utf-8").decode(bytes.subarray(from, end));
}

/** An octal field; `null` when it holds anything else (a base-256 size is not taken). */
function octal(bytes: Uint8Array, from: number, to: number): number | null {
  const raw = text0(bytes, from, to)
    .replace(/[ \0]+$/g, "")
    .replace(/^ +/, "");
  if (raw === "") return 0;
  return /^[0-7]+$/.test(raw) ? Number.parseInt(raw, 8) : null;
}

function validChecksum(header: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  return octal(header, 148, 156) === sum;
}

function allZero(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (bytes[i] !== 0) return false;
  return true;
}

/** `key=value` records of a pax header (`<length> <key>=<value>\n`), the ones read here. */
function paxRecords(data: Uint8Array): Map<string, string> | null {
  const out = new Map<string, string>();
  let at = 0;
  while (at < data.length) {
    let space = at;
    while (space < data.length && data[space] !== 0x20) space++;
    const length = Number.parseInt(new TextDecoder().decode(data.subarray(at, space)), 10);
    if (!Number.isFinite(length) || length <= space - at + 1 || at + length > data.length)
      return null;
    const record = new TextDecoder("utf-8").decode(data.subarray(space + 1, at + length - 1));
    const eq = record.indexOf("=");
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    at += length;
  }
  return out;
}

/**
 * The tar against `limits`, read in memory (see the top of the file); `scan` reads each regular
 * file that is text, as `inspectZip` does.
 */
export function inspectTar(bytes: Uint8Array, limits: ZipLimits, scan?: ZipTextScan): ZipVerdict {
  const refuse = (why: string, entry?: string): ZipVerdict => ({
    ok: false,
    why,
    ...(entry === undefined ? {} : { entry }),
  });
  const n = bytes.length;
  if (n === 0 || n % BLOCK !== 0) return refuse("not a whole number of tar blocks");
  const names = new Set<string>();
  let entries = 0;
  let unpacked = 0;
  let at = 0;
  // What a pax or GNU long-name header says about the entry after it.
  let nextName: string | null = null;
  let block: ZipBlock | null = null;
  let blockEntry: string | null = null;
  while (at < n) {
    const header = bytes.subarray(at, at + BLOCK);
    if (allZero(header, 0, BLOCK)) {
      // The end marker: nothing but zeros may follow, however many blocks.
      if (!allZero(bytes, at, n)) return refuse("data after the end of the tar");
      at = n;
      break;
    }
    if (!validChecksum(header)) return refuse("a tar header is broken");
    const size = octal(header, 124, 136);
    if (size === null) return refuse("a size it cannot read");
    const flag = String.fromCharCode(header[156] ?? 0x30);
    const posix =
      String.fromCharCode(...header.subarray(257, 262)) === "ustar" && header[262] === 0;
    const prefix = posix ? text0(header, 345, 500) : "";
    let name = text0(header, 0, 100);
    if (prefix !== "") name = `${prefix}/${name}`;
    const dataStart = at + BLOCK;
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (dataStart + padded > n) return refuse("a tar entry runs past the end");
    const data = bytes.subarray(dataStart, dataStart + size);
    // Whatever pads an entry to the block is zeros: nothing hides in it.
    if (!allZero(bytes, dataStart + size, dataStart + padded))
      return refuse("data hidden in a tar entry's padding");
    at = dataStart + padded;

    if (flag === "x") {
      const records = paxRecords(data);
      if (records === null) return refuse("a tar extended header is broken");
      const path = records.get("path");
      if (path !== undefined) nextName = path;
      // A size here would override the header's, which the padding was read with.
      if (records.has("size")) return refuse("a size it cannot check");
      continue;
    }
    if (flag === "g" || flag === "K") continue;
    if (flag === "L") {
      nextName = text0(data, 0, data.length);
      continue;
    }
    if (nextName !== null) name = nextName;
    nextName = null;

    if (flag === "1" || flag === "2") return refuse("contains a link", name);
    const regular = flag === "0" || flag === "\0" || flag === "7";
    if (!regular && flag !== "5") return refuse("an entry that is not a file or a folder", name);
    if (name === "" || !safeEntryName(name)) return refuse("a file name leaves the folder", name);
    const key = name.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (names.has(key)) return refuse("a file name is there twice", name);
    names.add(key);
    entries++;
    if (entries > limits.maxEntries) return refuse(`more than ${limits.maxEntries} files`);
    if (regular) {
      unpacked += size;
      if (unpacked > limits.maxUnpackedBytes) return refuse("unpacks too large");
      if (scan !== undefined && block === null) {
        const check = new TextCheck();
        check.push(data);
        if (check.end()) {
          const found = scan(new TextDecoder("utf-8").decode(data), name);
          if (found !== null) {
            block = found;
            blockEntry = name;
          }
        }
      }
    }
  }
  if (nextName !== null) return refuse("a tar extended header has no entry after it");
  if (block !== null) {
    return { ok: false, why: "holds what the output checks block", block, entry: blockEntry ?? "" };
  }
  return { ok: true, entries, unpacked };
}

/** Inflates a gzip under `maxBytes`: the bytes, or why not. */
function gunzipCapped(bytes: Uint8Array, maxBytes: number): Promise<Buffer | string> {
  return new Promise((resolve) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (out: Buffer | string) => {
      if (settled) return;
      settled = true;
      gunzip.destroy();
      resolve(out);
    };
    gunzip.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) finish("unpacks too large");
      else chunks.push(chunk);
    });
    gunzip.on("error", () => finish("broken compressed data"));
    gunzip.on("end", () => {
      // Everything handed in was part of the stream: nothing trails the gzip.
      if (gunzip.bytesWritten !== bytes.length) finish("data after the end of the gzip");
      else finish(Buffer.concat(chunks));
    });
    gunzip.end(bytes);
  });
}

/**
 * A gzip file against `limits`: inflated under the byte cap, then read as a tar when it is one,
 * else as a single file (a text one goes through `scan`).
 */
export async function inspectGzip(
  bytes: Uint8Array,
  limits: ZipLimits,
  scan?: ZipTextScan,
): Promise<ZipVerdict> {
  const out = await gunzipCapped(bytes, limits.maxUnpackedBytes);
  if (typeof out === "string") return { ok: false, why: out };
  if (isTar(out)) return inspectTar(out, limits, scan);
  if (scan !== undefined) {
    const check = new TextCheck();
    check.push(out);
    if (check.end()) {
      const block = scan(new TextDecoder("utf-8").decode(out), "(gz)");
      if (block !== null) {
        return { ok: false, why: "holds what the output checks block", block, entry: "(gz)" };
      }
    }
  }
  return { ok: true, entries: 1, unpacked: out.length };
}
