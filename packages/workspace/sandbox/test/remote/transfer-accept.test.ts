// What comes back from a job is limited: to what that job may change (a browser job hands back its
// downloads, and a reply from its computer naming any other path of the folder is dropped), and
// to the bytes its computer said it would send.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBrowserDownload } from "../../src/browse/sessions.js";
import { counted, receiveWorkspace, type TransferJob, tarCap } from "../../src/remote/transfer.js";
import { packTree } from "../../src/tar-io.js";
import { CountedWorkspace } from "../../src/workspace-totals.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(process.env.TMP ?? tmpdir(), "miyoria-accept-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A job whose computer answers the sync with the files of `dir` and the deletions `deleted`. */
async function jobSending(dir: string, deleted: string[]): Promise<TransferJob> {
  const limits = { maxFiles: 100, maxBytes: 1_000_000, maxFileBytes: 100_000 };
  const packed = packTree(dir, { limits });
  const chunks: Uint8Array[] = [];
  for await (const chunk of packed.stream) chunks.push(chunk);
  const tar = Buffer.concat(chunks);
  const sha256 = createHash("sha256").update(tar).digest("hex");
  return {
    id: "job1",
    host: "lender-pc",
    kind: "browser",
    maxTransferBytes: 1_000_000,
    async sync() {
      return {
        changed: [],
        deleted,
        tar: {
          bytes: tar.byteLength,
          sha256,
          body: async () =>
            (async function* () {
              yield tar;
            })(),
        },
        async done() {},
      };
    },
  } as unknown as TransferJob;
}

describe("receiveWorkspace accept", () => {
  it("takes only a browser's downloads and none of the other paths a computer names", async () => {
    const root = new CountedWorkspace(join(base, "workspace"), {
      maxBytes: 1_000_000,
      maxFiles: 100,
      maxFileBytes: 100_000,
    });
    await root.write("notes/keep.md", "hers");
    await root.write("notes/old.md", "old");
    const sent = join(base, "sent");
    for (const [path, text] of [
      ["downloads/menu.pdf", "pdf"],
      ["notes/keep.md", "overwritten"],
      ["scripts/run.py", "planted"],
    ]) {
      mkdirSync(join(sent, path, ".."), { recursive: true });
      writeFileSync(join(sent, path), text as string);
    }
    const job = await jobSending(sent, ["notes/old.md"]);
    // What Core knows the job holds: her old note as it is, so a deletion of it would be taken.
    const old = statSync(join(base, "workspace", "notes", "old.md"));
    const last = [
      {
        path: "notes/old.md",
        size: old.size,
        sha256: createHash("sha256").update("old").digest("hex"),
        mtime_ms: Math.floor(old.mtimeMs / 1000) * 1000,
      },
    ];
    await receiveWorkspace(
      job,
      { root, scope: { kind: "own" }, folder: null, limits: root.limits },
      last,
      undefined,
      { accept: isBrowserDownload },
    );
    const dir = join(base, "workspace");
    expect(readFileSync(join(dir, "downloads", "menu.pdf"), "utf8")).toBe("pdf");
    expect(readFileSync(join(dir, "notes", "keep.md"), "utf8")).toBe("hers");
    expect(existsSync(join(dir, "scripts", "run.py"))).toBe(false);
    expect(readFileSync(join(dir, "notes", "old.md"), "utf8")).toBe("old");
  });

  it("stops reading a tar past the bytes the computer said, and lets go of the body", async () => {
    const root = new CountedWorkspace(join(base, "workspace"), {
      maxBytes: 1_000_000,
      maxFiles: 100,
      maxFileBytes: 100_000,
    });
    let pieces = 0;
    let released = false;
    const job = {
      id: "job2",
      host: "lender-pc",
      maxTransferBytes: 1_000_000,
      async sync() {
        return {
          changed: [],
          deleted: [],
          tar: {
            bytes: 4096,
            sha256: "0".repeat(64),
            body: async () =>
              (async function* () {
                try {
                  for (;;) {
                    pieces++;
                    yield new Uint8Array(1024);
                  }
                } finally {
                  released = true;
                }
              })(),
          },
          async done() {},
        };
      },
    } as unknown as TransferJob;
    const ws = { root, scope: { kind: "own" } as const, folder: null, limits: root.limits };
    // Zero blocks end a tar: what is unpacked stops there, and the body is let go of, not drained.
    await expect(receiveWorkspace(job, ws, [])).rejects.toThrow(/sandbox/);
    expect(pieces).toBeLessThanOrEqual(6);
    expect(released).toBe(true);
  });

  it("counts a body only up to what was said and then stops it", async () => {
    let pieces = 0;
    let released = false;
    const endless = (async function* () {
      try {
        for (;;) {
          pieces++;
          yield new Uint8Array(1024).fill(0x61);
        }
      } finally {
        released = true;
      }
    })();
    const sink = { hash: createHash("sha256"), bytes: 0 };
    const read = (async () => {
      for await (const _ of counted(endless, sink, 4096)) {
        // Taken as it comes.
      }
    })();
    await expect(read).rejects.toThrow(/more than it said/);
    expect(sink.bytes).toBe(5120);
    expect(pieces).toBe(5);
    expect(released).toBe(true);
  });

  it("does not read a tar larger than the folder could ever take", async () => {
    const root = new CountedWorkspace(join(base, "workspace"), {
      maxBytes: 10_000,
      maxFiles: 5,
      maxFileBytes: 10_000,
    });
    let asked = false;
    const job = {
      id: "job3",
      host: "lender-pc",
      maxTransferBytes: 1_000_000,
      async sync() {
        return {
          changed: [],
          deleted: [],
          tar: {
            bytes: tarCap(root.limits) + 1,
            sha256: "0".repeat(64),
            body: async () => {
              asked = true;
              return (async function* () {})();
            },
          },
          async done() {},
        };
      },
    } as unknown as TransferJob;
    const ws = { root, scope: { kind: "own" } as const, folder: null, limits: root.limits };
    await receiveWorkspace(job, ws, []);
    expect(asked).toBe(false);
  });

  it("a browser download is a file under downloads/, nothing else", () => {
    expect(isBrowserDownload("downloads/menu.pdf")).toBe(true);
    expect(isBrowserDownload("downloads/a/b.txt")).toBe(true);
    for (const path of [
      "downloads",
      "downloads/",
      "notes/a.md",
      "people/x/downloads/a",
      "Downloads/a",
    ]) {
      expect(isBrowserDownload(path), path).toBe(false);
    }
  });
});
