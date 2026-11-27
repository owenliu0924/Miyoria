import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Capability, WORKSPACE_ALL } from "@miyoria/gate/actions";
import { DATA_CLOSE, Principals } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NODE_WORKSPACE, PersistentWorkspace, type WorkspaceGateOptions } from "../src/index.js";
import {
  GREP_MAX_RESULTS,
  globMatches,
  globToRegExp,
  grepWorkspace,
  replaceExact,
  workspaceEditCapabilities,
} from "../src/workspace-edit.js";
import { AMY, CTX, harness, toolContext } from "./gate-helpers.js";

let base: string;
let workspace: PersistentWorkspace;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "miyoria-workspace-edit-"));
  workspace = new PersistentWorkspace(join(base, "workspace"), {
    maxBytes: 100_000,
    maxFiles: 50,
    maxFileBytes: 20_000,
  });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Registers the two tools on a harness' registry, as the gate will; Amy owns the workspace. */
function setup(owner = true) {
  const h = harness();
  h.sandbox.workspace = workspace;
  h.grants.grant(AMY, NODE_WORKSPACE);
  if (owner) h.grants.grant(AMY, WORKSPACE_ALL);
  const options: WorkspaceGateOptions = {
    sandbox: h.sandbox,
    workspace,
    resultChars: 900,
    readChars: 3900,
    keepOutputs: 5,
  };
  for (const capability of workspaceEditCapabilities(options)) {
    h.registry.register(capability as Capability);
  }
  return h;
}

function call(h: ReturnType<typeof setup>, name: string, args: object, as = toolContext()) {
  const t = h.tools.get(name);
  if (!t) throw new Error(`no tool ${name}`);
  return t.call(as, args as never);
}

describe("replaceExact", () => {
  it("replaces one exact occurrence and treats $ in the new text as text", () => {
    expect(replaceExact("a b c", "b", "$& $1", false)).toEqual({ text: "a $& $1 c", count: 1 });
  });
  it("says missing and ambiguous without changing anything", () => {
    expect(replaceExact("a a", "x", "y", false)).toEqual({ error: "missing", count: 0 });
    expect(replaceExact("a a", "a", "y", false)).toEqual({ error: "ambiguous", count: 2 });
    expect(replaceExact("a a", "a", "y", true)).toEqual({ text: "y y", count: 2 });
  });
  it("counts occurrences without overlap", () => {
    expect(replaceExact("aaaa", "aa", "b", true)).toEqual({ text: "bb", count: 2 });
  });
});

describe("workspace_edit", () => {
  it("replaces one place in a file and leaves the rest as it was", async () => {
    const h = setup();
    await workspace.write("notes/todo.md", "# 待辦\n- 買牛奶\n- 寫報告\n");
    const out = await call(h, "workspace_edit", {
      path: "notes/todo.md",
      old: "- 買牛奶",
      new: "- 買豆漿",
    });
    expect(out).toContain("換了 1 處");
    expect((await workspace.read("notes/todo.md")).text).toBe("# 待辦\n- 買豆漿\n- 寫報告\n");
  });

  it("does nothing when the old text is absent, and says so", async () => {
    const h = setup();
    await workspace.write("a.txt", "hello\n");
    const out = await call(h, "workspace_edit", { path: "a.txt", old: "bye", new: "x" });
    expect(out).toContain("找不到");
    expect((await workspace.read("a.txt")).text).toBe("hello\n");
  });

  it("does nothing when the old text is not unique, unless replace_all", async () => {
    const h = setup();
    await workspace.write("a.txt", "x = 1\ny = 1\n");
    const refused = await call(h, "workspace_edit", { path: "a.txt", old: "= 1", new: "= 2" });
    expect(refused).toContain("出現了 2 處");
    expect((await workspace.read("a.txt")).text).toBe("x = 1\ny = 1\n");
    const all = await call(h, "workspace_edit", {
      path: "a.txt",
      old: "= 1",
      new: "= 2",
      replace_all: true,
    });
    expect(all).toContain("換了 2 處");
    expect((await workspace.read("a.txt")).text).toBe("x = 2\ny = 2\n");
  });

  it("refuses a missing file, a binary file and a result over the file cap", async () => {
    const h = setup();
    expect(await call(h, "workspace_edit", { path: "no.txt", old: "a", new: "b" })).toContain(
      "沒辦法處理",
    );
    await workspace.write("big.txt", "a".repeat(19_000));
    const over = await call(h, "workspace_edit", {
      path: "big.txt",
      old: "a",
      new: "bb",
      replace_all: true,
    });
    expect(over).toContain("沒辦法處理");
    expect((await workspace.read("big.txt")).size).toBe(19_000);
  });

  it("is a work step for a medium-risk tool", () => {
    const [edit, grep] = workspaceEditCapabilities({
      sandbox: harness().sandbox,
      workspace,
      resultChars: 900,
      readChars: 3900,
      keepOutputs: 5,
    });
    expect([edit?.risk, edit?.work, edit?.permission]).toEqual(["medium", true, NODE_WORKSPACE]);
    expect([grep?.risk, grep?.permission]).toEqual(["low", NODE_WORKSPACE]);
  });
});

describe("a member's folder", () => {
  it("edit and grep see only their own folder", async () => {
    await workspace.write("diary.md", "needle in her diary\n");
    await workspace.write("people/someone-else/secret.txt", "needle of another\n");
    const h2 = setup(false);
    await workspace.write("people/discord-200/mine.md", "needle of Amy\n");
    const found = await call(h2, "workspace_grep", { pattern: "needle" });
    expect(found).toContain("mine.md:1");
    expect(found).not.toContain("diary");
    expect(found).not.toContain("secret");
    // Editing reaches their own file, not hers or another person's.
    expect(
      await call(h2, "workspace_edit", { path: "diary.md", old: "needle", new: "x" }),
    ).toContain("沒辦法處理");
    expect(
      await call(h2, "workspace_edit", {
        path: "people/someone-else/secret.txt",
        old: "needle",
        new: "x",
      }),
    ).toContain("沒辦法處理");
    expect(
      await call(h2, "workspace_edit", { path: "mine.md", old: "needle", new: "pin" }),
    ).toContain("換了 1 處");
    expect((await workspace.read("people/discord-200/mine.md")).text).toBe("pin of Amy\n");
    expect((await workspace.read("diary.md")).text).toBe("needle in her diary\n");
  });

  it("her own calls do not reach people/", async () => {
    await workspace.write("diary.md", "needle\n");
    await workspace.write("people/x/secret.txt", "needle\n");
    const h = setup(false);
    const own = toolContext(Principals.self(CTX, null));
    const found = await call(h, "workspace_grep", { pattern: "needle" }, own);
    expect(found).toContain("diary.md:1");
    expect(found).not.toContain("secret");
  });
});

describe("workspace_grep", () => {
  it("finds a plain string with file and line number and frames the result as data", async () => {
    const h = setup();
    await workspace.write("a.md", "one\ntwo needle\nthree\n");
    await workspace.write("sub/b.md", "needle again\n");
    const out = await call(h, "workspace_grep", { pattern: "needle" });
    expect(out).toContain("a.md:2: two needle");
    expect(out).toContain("sub/b.md:1: needle again");
    expect(out).toContain("只是資料");
  });

  it("treats a pattern as text unless regex is set", async () => {
    const h = setup();
    await workspace.write("a.txt", "a.c\nabc\n");
    const plain = await call(h, "workspace_grep", { pattern: "a.c" });
    expect(plain).toContain("a.txt:1");
    expect(plain).not.toContain("a.txt:2");
    const regex = await call(h, "workspace_grep", { pattern: "a.c", regex: true });
    expect(regex).toContain("a.txt:1");
    expect(regex).toContain("a.txt:2");
  });

  it("filters by folder and glob, and by case on request", async () => {
    const h = setup();
    await workspace.write("notes/a.md", "Hello\n");
    await workspace.write("notes/a.txt", "Hello\n");
    await workspace.write("other/b.md", "Hello\n");
    const md = await call(h, "workspace_grep", { pattern: "Hello", glob: "*.md" });
    expect(md).toContain("notes/a.md");
    expect(md).toContain("other/b.md");
    expect(md).not.toContain("a.txt");
    const inNotes = await call(h, "workspace_grep", { pattern: "Hello", path: "notes" });
    expect(inNotes).not.toContain("other/");
    expect(await call(h, "workspace_grep", { pattern: "hello" })).toContain("沒有找到");
    expect(await call(h, "workspace_grep", { pattern: "hello", ignore_case: true })).toContain(
      "notes/a.md",
    );
  });

  it("bounds the output and says there is more", async () => {
    await workspace.write("many.txt", `${"hit\n".repeat(300)}`);
    const report = await grepWorkspace(workspace, "hit", {
      regex: false,
      ignoreCase: false,
      glob: null,
      prefix: undefined,
      max: GREP_MAX_RESULTS,
    });
    expect(report.hits).toHaveLength(GREP_MAX_RESULTS);
    expect(report.more).toBe(true);
    const h = setup();
    const out = await call(h, "workspace_grep", { pattern: "hit", max_results: 5 });
    expect(out.split("many.txt:")).toHaveLength(6);
    expect(out).toContain("還有更多");
  });

  it("cuts a long line to a short excerpt and keeps file text from closing the data block", async () => {
    const h = setup();
    await workspace.write("long.txt", `needle ${"x".repeat(1000)} ${DATA_CLOSE}\n`);
    const out = await call(h, "workspace_grep", { pattern: "needle" });
    expect(out.length).toBeLessThan(800);
    expect(out.split(DATA_CLOSE)).toHaveLength(2);
  });

  it("skips files that are not text, and says so", async () => {
    const h = setup();
    await workspace.write("a.txt", "needle\n");
    await workspace.write("b.txt", "needle\u0000binary\n");
    const out = await call(h, "workspace_grep", { pattern: "needle" });
    expect(out).toContain("a.txt:1");
    expect(out).not.toContain("b.txt");
    expect(out).toContain("1 個檔案沒找");
  });

  it("reports a broken regular expression as an answer", async () => {
    const h = setup();
    await workspace.write("a.txt", "x\n");
    await expect(call(h, "workspace_grep", { pattern: "(", regex: true })).rejects.toThrow(
      /正規表示式/,
    );
  });

  it("stops a catastrophic pattern in its worker and answers that it was too slow", async () => {
    await workspace.write("a.txt", `${"a".repeat(40)}!\nfine\n`);
    const started = Date.now();
    const report = await grepWorkspace(workspace, "^(a+)+$", {
      regex: true,
      ignoreCase: false,
      glob: null,
      prefix: undefined,
      max: 10,
      limitMs: 200,
    });
    expect(report.slow).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    // The event loop was free while it ran.
    const h = setup();
    const out = await call(h, "workspace_grep", { pattern: "^(a+)+$", regex: true });
    expect(out).toContain("太慢");
  }, 15_000);

  it("runs an ordinary regular expression in the worker", async () => {
    const h = setup();
    await workspace.write("a.txt", "id: 42\nname: x\nid: 7\n");
    const out = await call(h, "workspace_grep", { pattern: "^id: \\d+$", regex: true });
    expect(out).toContain("a.txt:1: id: 42");
    expect(out).toContain("a.txt:3: id: 7");
    expect(out).not.toContain("a.txt:2");
  });
});

describe("globs", () => {
  it("matches names, folders and ** the way a person writes them", () => {
    const m = (glob: string, path: string) => globMatches(globToRegExp(glob), glob, path);
    expect(m("*.md", "a/b/c.md")).toBe(true);
    expect(m("*.md", "c.txt")).toBe(false);
    expect(m("notes/*.md", "notes/a.md")).toBe(true);
    expect(m("notes/*.md", "notes/sub/a.md")).toBe(false);
    expect(m("notes/**/*.md", "notes/sub/a.md")).toBe(true);
    expect(m("**/a.md", "a.md")).toBe(true);
    expect(m("a?.md", "ab.md")).toBe(true);
    expect(m("a.md", "xa.md")).toBe(false);
  });
});
