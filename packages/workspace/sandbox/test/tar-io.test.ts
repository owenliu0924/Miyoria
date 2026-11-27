import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractTar, type PackedEntry, packTree, TarError } from "../src/tar-io.js";

const PACK_LIMITS = { maxFiles: 100, maxBytes: 1_000_000, maxFileBytes: 100_000 };
const EXTRACT_LIMITS = { ...PACK_LIMITS, maxDepth: 8 };

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "tar-io-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function folder(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

/** In pieces, so a header or a file is cut at places the reader has to cope with. */
async function* pieces(data: Uint8Array, size = 777): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size);
}

interface Raw {
  name: string;
  type?: "file" | "directory" | "symlink" | "link" | "character-device" | "block-device" | "fifo";
  content?: string;
  linkname?: string;
  size?: number;
}

/** A tar made by hand, so it can hold what `packTree` never writes. */
async function rawTar(entries: Raw[]): Promise<Buffer> {
  const pack = tar.pack();
  const done = collect(pack as unknown as AsyncIterable<Uint8Array>);
  for (const e of entries) {
    const body = Buffer.from(e.content ?? "");
    const type = e.type ?? "file";
    const header = {
      name: e.name,
      type,
      mode: 0o777,
      mtime: new Date(1_700_000_000_000),
      ...(type === "file" ? { size: e.size ?? body.length } : {}),
      ...(e.linkname === undefined ? {} : { linkname: e.linkname }),
    };
    await new Promise<void>((resolve, reject) => {
      const entry = pack.entry(header, (error) => (error ? reject(error) : resolve()));
      if (type === "file" && body.length > 0) entry.write(body);
      (entry as unknown as { end(): void }).end();
    });
  }
  pack.finalize();
  return done;
}

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (lstatSync(full).isDirectory()) out.push(...listFiles(full, rel));
    else out.push(rel);
  }
  return out;
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("packTree", () => {
  it("packs_files_and_directories_and_reports_them", async () => {
    const src = folder("src");
    mkdirSync(join(src, "a", "b"), { recursive: true });
    mkdirSync(join(src, "empty"));
    writeFileSync(join(src, "top.txt"), "hello");
    writeFileSync(join(src, "a", "b", "deep.txt"), "deep");
    writeFileSync(join(src, "zero"), "");
    utimesSync(join(src, "top.txt"), 1_700_000_000, 1_700_000_000);

    const { stream, done } = packTree(src, { limits: PACK_LIMITS });
    const data = await collect(stream);
    const result = await done;

    expect(result.entries.map((e) => e.path)).toEqual(["a/b/deep.txt", "top.txt", "zero"]);
    expect(result.entries.find((e) => e.path === "top.txt")).toEqual({
      path: "top.txt",
      size: 5,
      sha256: sha("hello"),
      mtime_ms: 1_700_000_000_000,
    });
    expect(result.skipped).toEqual([]);
    expect(result.bytes).toBe(data.length);
    expect(result.sha256).toBe(createHash("sha256").update(data).digest("hex"));

    const dst = folder("dst");
    const out = await extractTar(pieces(data), dst, { limits: EXTRACT_LIMITS });
    expect(listFiles(dst)).toEqual(["a/b/deep.txt", "top.txt", "zero"]);
    expect(existsSync(join(dst, "empty"))).toBe(true);
    expect(readFileSync(join(dst, "a", "b", "deep.txt"), "utf8")).toBe("deep");
    expect(out.skipped).toEqual([]);
    expect(out.conflicts).toEqual([]);
  });

  it("round_trips_with_gzip_and_the_manifests_agree", async () => {
    const src = folder("src");
    writeFileSync(join(src, "one.txt"), "x".repeat(50_000));
    writeFileSync(join(src, "two.bin"), Buffer.from([0, 1, 2, 255]));

    const { stream, done } = packTree(src, { gzip: true, limits: PACK_LIMITS });
    const data = await collect(stream);
    const packed = await done;
    expect(data[0]).toBe(0x1f);
    expect(data[1]).toBe(0x8b);
    expect(data.length).toBeLessThan(5_000);

    const dst = folder("dst");
    const out = await extractTar(pieces(data), dst, { gzip: true, limits: EXTRACT_LIMITS });
    const byPath = (list: PackedEntry[]) =>
      list.map((e) => [e.path, e.size, e.sha256, e.mtime_ms]).sort();
    expect(byPath(out.written)).toEqual(byPath(packed.entries));
    expect(readFileSync(join(dst, "two.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it("leaves_out_what_skip_says_and_names_nothing_for_it", async () => {
    const src = folder("src");
    mkdirSync(join(src, "people", "x"), { recursive: true });
    writeFileSync(join(src, "people", "x", "secret.txt"), "no");
    writeFileSync(join(src, "keep.txt"), "yes");
    const { stream, done } = packTree(src, {
      skip: (path) => path === "people",
      limits: PACK_LIMITS,
    });
    await collect(stream);
    const result = await done;
    expect(result.entries.map((e) => e.path)).toEqual(["keep.txt"]);
    expect(result.skipped).toEqual([]);
  });

  it("does_not_follow_links_and_says_so", async () => {
    const src = folder("src");
    const outside = folder("outside");
    writeFileSync(join(outside, "secret.txt"), "secret");
    writeFileSync(join(src, "real.txt"), "real");
    try {
      symlinkSync(join(outside, "secret.txt"), join(src, "file-link"));
      symlinkSync(outside, join(src, "dir-link"), "dir");
    } catch {
      return; // a machine that does not let this user make links
    }
    const { stream, done } = packTree(src, { limits: PACK_LIMITS });
    await collect(stream);
    const result = await done;
    expect(result.entries.map((e) => e.path)).toEqual(["real.txt"]);
    expect(result.skipped.map((s) => [s.path, s.why]).sort()).toEqual([
      ["dir-link", "link"],
      ["file-link", "link"],
    ]);
  });

  it("keeps_the_first_of_two_names_that_differ_only_in_case", async () => {
    const src = folder("src");
    writeFileSync(join(src, "Name.txt"), "one");
    // A file system that ignores case has only one of them; there is nothing to test there.
    writeFileSync(join(src, "name.TXT"), "two");
    if (readdirSync(src).length < 2) return;
    const { stream, done } = packTree(src, { limits: PACK_LIMITS });
    await collect(stream);
    const result = await done;
    expect(result.entries.map((e) => e.path)).toEqual(["Name.txt"]);
    expect(result.skipped.map((s) => s.path)).toEqual(["name.TXT"]);
  });

  it("skips_a_file_over_the_file_limit_and_a_name_that_is_not_allowed", async () => {
    const src = folder("src");
    writeFileSync(join(src, "big.bin"), Buffer.alloc(2_000));
    writeFileSync(join(src, "ok.txt"), "ok");
    writeFileSync(join(src, "bad ."), "x");
    const { stream, done } = packTree(src, {
      limits: { ...PACK_LIMITS, maxFileBytes: 1_000 },
    });
    await collect(stream);
    const result = await done;
    expect(result.entries.map((e) => e.path)).toEqual(["ok.txt"]);
    expect(result.skipped.map((s) => s.path).sort()).toEqual(["bad .", "big.bin"]);
  });

  it("fails_before_giving_any_bytes_when_there_are_too_many_files_or_bytes", async () => {
    const src = folder("src");
    for (let i = 0; i < 5; i++) writeFileSync(join(src, `f${i}.txt`), "12345");
    const tooMany = packTree(src, { limits: { ...PACK_LIMITS, maxFiles: 4 } });
    await expect(collect(tooMany.stream)).rejects.toMatchObject({ code: "too_many_files" });
    await expect(tooMany.done).rejects.toBeInstanceOf(TarError);

    const tooBig = packTree(src, { limits: { ...PACK_LIMITS, maxBytes: 24 } });
    await expect(collect(tooBig.stream)).rejects.toMatchObject({ code: "too_large" });
  });

  it("rejects_a_directory_that_is_not_one", async () => {
    const src = folder("src");
    writeFileSync(join(src, "file"), "x");
    const { stream } = packTree(join(src, "file"), { limits: PACK_LIMITS });
    await expect(collect(stream)).rejects.toBeInstanceOf(Error);
  });
});

describe("extractTar", () => {
  async function extract(
    data: Buffer,
    options: Partial<Parameters<typeof extractTar>[2]> = {},
    dir = folder("dst"),
  ) {
    return {
      dir,
      ...(await extractTar(pieces(data), dir, { limits: EXTRACT_LIMITS, ...options })),
    };
  }

  it("refuses_paths_that_climb_or_are_absolute_or_have_a_drive_or_a_backslash", async () => {
    const names = [
      "../escape.txt",
      "a/../../escape.txt",
      "/etc/passwd",
      "C:/Windows/x.txt",
      "C:\\x.txt",
      "dir\\file.txt",
      "a/./b.txt",
      "con.txt",
      "name:stream",
      "trail.",
    ];
    const data = await rawTar([
      ...names.map((name) => ({ name, content: "bad" })),
      { name: "fine.txt", content: "good" },
    ]);
    const out = await extract(data);
    expect(listFiles(out.dir)).toEqual(["fine.txt"]);
    expect(out.skipped.map((s) => s.path).sort()).toEqual(names.map((n) => n.slice(0, 200)).sort());
    expect(existsSync(join(base, "escape.txt"))).toBe(false);
  });

  it("accepts_a_leading_dot_slash_and_ignores_the_root_entry", async () => {
    const data = await rawTar([
      { name: "./", type: "directory" },
      { name: "./sub/", type: "directory" },
      { name: "./sub/a.txt", content: "a" },
    ]);
    const out = await extract(data);
    expect(listFiles(out.dir)).toEqual(["sub/a.txt"]);
    expect(out.skipped).toEqual([]);
  });

  it("leaves_links_and_devices_out", async () => {
    const data = await rawTar([
      { name: "sym", type: "symlink", linkname: "/etc/passwd" },
      { name: "hard", type: "link", linkname: "fine.txt" },
      { name: "dev", type: "character-device" },
      { name: "blk", type: "block-device" },
      { name: "pipe", type: "fifo" },
      { name: "fine.txt", content: "fine" },
    ]);
    const out = await extract(data);
    expect(listFiles(out.dir)).toEqual(["fine.txt"]);
    expect(out.skipped.map((s) => [s.path, s.why]).sort()).toEqual([
      ["blk", "not a regular file"],
      ["dev", "not a regular file"],
      ["hard", "link"],
      ["pipe", "not a regular file"],
      ["sym", "link"],
    ]);
  });

  it("does_not_write_through_a_link_that_is_already_in_the_folder", async () => {
    const dst = folder("dst");
    const outside = folder("outside");
    try {
      symlinkSync(outside, join(dst, "door"), "dir");
    } catch {
      return;
    }
    const data = await rawTar([{ name: "door/pwned.txt", content: "x" }]);
    const out = await extract(data, {}, dst);
    expect(out.skipped).toEqual([{ path: "door/pwned.txt", why: "link in the way" }]);
    expect(existsSync(join(outside, "pwned.txt"))).toBe(false);
  });

  it("replaces_a_link_at_the_path_of_a_file_instead_of_writing_through_it", async () => {
    const dst = folder("dst");
    const outside = folder("outside");
    writeFileSync(join(outside, "target.txt"), "original");
    try {
      symlinkSync(join(outside, "target.txt"), join(dst, "f.txt"));
    } catch {
      return;
    }
    const out = await extract(await rawTar([{ name: "f.txt", content: "new" }]), {}, dst);
    expect(out.written.map((e) => e.path)).toEqual(["f.txt"]);
    expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("original");
    expect(lstatSync(join(dst, "f.txt")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dst, "f.txt"), "utf8")).toBe("new");
  });

  it("refuses_a_path_that_is_too_deep", async () => {
    const data = await rawTar([
      { name: "a/b/c/d.txt", content: "ok" },
      { name: "a/b/c/d/e/f/g/h/i.txt", content: "deep" },
    ]);
    const out = await extract(data, { limits: { ...EXTRACT_LIMITS, maxDepth: 4 } });
    expect(listFiles(out.dir)).toEqual(["a/b/c/d.txt"]);
    expect(out.skipped).toEqual([{ path: "a/b/c/d/e/f/g/h/i.txt", why: "too deep" }]);
  });

  it("refuses_a_file_over_the_file_limit_but_goes_on", async () => {
    const data = await rawTar([
      { name: "big.bin", content: "x".repeat(300) },
      { name: "small.txt", content: "s" },
    ]);
    const out = await extract(data, { limits: { ...EXTRACT_LIMITS, maxFileBytes: 100 } });
    expect(listFiles(out.dir)).toEqual(["small.txt"]);
    expect(out.skipped).toEqual([{ path: "big.bin", why: "file too large" }]);
  });

  it("fails_on_too_many_files_and_on_too_many_bytes", async () => {
    const many = await rawTar(
      Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, content: "1" })),
    );
    await expect(
      extract(many, { limits: { ...EXTRACT_LIMITS, maxFiles: 5 } }),
    ).rejects.toMatchObject({ code: "too_many_files" });

    const heavy = await rawTar([
      { name: "a", content: "x".repeat(60) },
      { name: "b", content: "x".repeat(60) },
    ]);
    await expect(
      extract(heavy, { limits: { ...EXTRACT_LIMITS, maxBytes: 100 } }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("counts_directories_and_left_out_entries_against_the_entry_limit", async () => {
    // maxFiles 5 allows 5 files and 10 folders, what `packTree` itself can write.
    const limits = { ...EXTRACT_LIMITS, maxFiles: 5 };
    const fits = await rawTar([
      ...Array.from({ length: 10 }, (_, i) => ({ name: `d${i}/`, type: "directory" as const })),
      ...Array.from({ length: 5 }, (_, i) => ({ name: `d${i}/f.txt`, content: "1" })),
    ]);
    expect((await extract(fits, { limits })).written).toHaveLength(5);

    const folders = await rawTar(
      Array.from({ length: 16 }, (_, i) => ({ name: `d${i}/`, type: "directory" as const })),
    );
    const dst = folder("folders");
    await expect(extract(folders, { limits }, dst)).rejects.toMatchObject({
      code: "too_many_files",
    });
    expect(readdirSync(dst).length).toBeLessThanOrEqual(15);

    const links = await rawTar(
      Array.from({ length: 16 }, (_, i) => ({
        name: `l${i}`,
        type: "symlink" as const,
        linkname: "x",
      })),
    );
    await expect(extract(links, { limits })).rejects.toMatchObject({ code: "too_many_files" });
  });

  it("stops_a_gzip_bomb_by_what_it_unpacks_to", async () => {
    const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(100_000);
    await expect(
      extract(bomb, { gzip: true, limits: { ...EXTRACT_LIMITS, maxBytes: 1_000, maxFiles: 2 } }),
    ).rejects.toMatchObject({ code: "too_large" });
  });

  it("refuses_names_that_differ_only_in_case_keeping_the_first", async () => {
    const data = await rawTar([
      { name: "Report.txt", content: "first" },
      { name: "report.TXT", content: "second" },
      { name: "Dir/a.txt", content: "a" },
      { name: "dir/b.txt", content: "b" },
    ]);
    const out = await extract(data);
    expect(readFileSync(join(out.dir, "Report.txt"), "utf8")).toBe("first");
    expect(out.skipped.map((s) => s.path)).toEqual(["report.TXT"]);
    expect(out.written.map((e) => e.path)).toEqual(["Report.txt", "Dir/a.txt", "dir/b.txt"]);
  });

  it("does_not_take_the_modes_in_the_tar", async () => {
    const data = await rawTar([{ name: "run.sh", content: "#!/bin/sh" }]);
    const out = await extract(data);
    if (process.platform !== "win32") {
      expect(lstatSync(join(out.dir, "run.sh")).mode & 0o777).toBe(0o644);
    }
  });

  it("keeps_the_modification_time", async () => {
    const out = await extract(await rawTar([{ name: "t.txt", content: "t" }]));
    expect(lstatSync(join(out.dir, "t.txt")).mtimeMs).toBe(1_700_000_000_000);
    expect(out.written[0]?.mtime_ms).toBe(1_700_000_000_000);
  });

  it("replaces_an_existing_file_by_default", async () => {
    const dst = folder("dst");
    writeFileSync(join(dst, "a.txt"), "old");
    const out = await extract(await rawTar([{ name: "a.txt", content: "new" }]), {}, dst);
    expect(readFileSync(join(dst, "a.txt"), "utf8")).toBe("new");
    expect(out.conflicts).toEqual([]);
    expect(listFiles(dst)).toEqual(["a.txt"]);
  });

  it("moves_the_old_file_aside_when_asked_and_lists_it", async () => {
    const dst = folder("dst");
    writeFileSync(join(dst, "a.txt"), "mine");
    writeFileSync(join(dst, "b.txt"), "mine too");
    const out = await extract(
      await rawTar([
        { name: "a.txt", content: "theirs" },
        { name: "b.txt", content: "theirs too" },
      ]),
      {
        onExisting: (path) => (path === "a.txt" ? "keep-as-conflict" : "replace"),
        now: () => Date.UTC(2026, 10, 27, 10, 15, 30),
      },
      dst,
    );
    expect(out.conflicts).toEqual(["a.txt.conflict-20261127T101530Z"]);
    expect(readFileSync(join(dst, "a.txt"), "utf8")).toBe("theirs");
    expect(readFileSync(join(dst, "a.txt.conflict-20261127T101530Z"), "utf8")).toBe("mine");
    expect(readFileSync(join(dst, "b.txt"), "utf8")).toBe("theirs too");
  });

  it("does_not_overwrite_a_directory_with_a_file", async () => {
    const dst = folder("dst");
    mkdirSync(join(dst, "d"));
    const out = await extract(await rawTar([{ name: "d", content: "file" }]), {}, dst);
    expect(out.skipped).toEqual([{ path: "d", why: "a directory is in the way" }]);
  });

  it("rejects_what_is_not_a_tar", async () => {
    const dst = folder("dst");
    await expect(
      extractTar(pieces(Buffer.from("this is not a tar file at all".repeat(100))), dst, {
        limits: EXTRACT_LIMITS,
      }),
    ).rejects.toBeInstanceOf(TarError);
    await expect(
      extractTar(pieces(Buffer.from("not gzip either")), dst, {
        gzip: true,
        limits: EXTRACT_LIMITS,
      }),
    ).rejects.toBeInstanceOf(TarError);
  });

  it("rejects_a_tar_that_ends_in_the_middle_of_a_file", async () => {
    const data = await rawTar([{ name: "a.txt", content: "x".repeat(2000) }]);
    const dst = folder("dst");
    await expect(
      extractTar(pieces(data.subarray(0, 1200)), dst, { limits: EXTRACT_LIMITS }),
    ).rejects.toBeInstanceOf(TarError);
    expect(existsSync(join(dst, "a.txt"))).toBe(false);
  });
});
