// `RemoteSandbox` and `HttpSandboxClient` against a sandbox service in the test process
// (`fake-service.ts`): choosing a computer and moving on, CPU seconds before and during a run,
// the folder in and back (and everything a hostile computer could send back), sessions, a
// restart of Core, and what she is told when nothing takes the run.

import { mkdtempSync, rmSync } from "node:fs";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import type { WorkCap, WorkPayer, WorkQuota } from "@miyoria/types";
import tar from "tar-stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SandboxConfigSchema } from "../../src/config.js";
import { HttpSandboxClient } from "../../src/remote/client.js";
import { MemorySandboxJobs } from "../../src/remote/jobs-store.js";
import { RemoteSandbox } from "../../src/remote/remote-sandbox.js";
import { SandboxError, SessionClosedError } from "../../src/types.js";
import { ToolsWorkspace } from "../../src/workspace.js";
import { CountedWorkspace } from "../../src/workspace-totals.js";
import { FakeEndpoints, FakeMachine, type Program } from "./fake-service.js";

const MIB = 1024 * 1024;

class FakeQuota implements WorkQuota {
  readonly charged: { person: string; seconds: number }[] = [];
  limitSeconds = Number.POSITIVE_INFINITY;
  payerOf(): WorkPayer | null {
    return null;
  }
  used(person: string) {
    const hour = this.charged.filter((c) => c.person === person).reduce((n, c) => n + c.seconds, 0);
    return { hour, day: hour };
  }
  capped(payer: WorkPayer | null, now: number): WorkCap | null {
    if (payer === null || payer.exempt) return null;
    const used = this.used(payer.person);
    if (used.hour < this.limitSeconds) return null;
    return { which: "hour", until: now + 12 * 60_000, first: true, limit: this.limitSeconds, used };
  }
  charge(payer: WorkPayer | null, _now: number, cpuSeconds: number): void {
    if (payer !== null) this.charged.push({ person: payer.person, seconds: cpuSeconds });
  }
  claimNotice(): boolean {
    return true;
  }
  rules() {
    return { cpuSecondsPerHour: this.limitSeconds, cpuSecondsPerDay: this.limitSeconds };
  }
}

let root: string;
let quota: FakeQuota;
let jobs: MemorySandboxJobs;
let workspace: CountedWorkspace;
let opened: RemoteSandbox[];

beforeEach(() => {
  root = mkdtempSync(join(process.env.TMP ?? tmpdir(), "miyoria-remote-"));
  quota = new FakeQuota();
  jobs = new MemorySandboxJobs();
  workspace = new CountedWorkspace(
    join(root, "core", "workspace"),
    { maxBytes: 64 * MIB, maxFiles: 500, maxFileBytes: 8 * MIB },
    join(root, "core", "ledger.json"),
  );
  opened = [];
});

afterEach(async () => {
  for (const s of opened) await s.close();
  rmSync(root, { recursive: true, force: true });
});

function machine(host: string, o: Partial<ConstructorParameters<typeof FakeMachine>[0]> = {}) {
  return new FakeMachine({ host, root: join(root, "machines"), ...o });
}

/**
 * A sandbox on `machines`. `coreHosts`: which of them are Core's own machine; by default all,
 * so a test that is not about the member list does not have to list them.
 */
function sandboxOn(
  machines: FakeMachine[],
  config: Record<string, unknown> = {},
  coreHosts: readonly string[] = machines.map((m) => m.host),
) {
  const endpoints = new FakeEndpoints(machines);
  const parsed = SandboxConfigSchema.parse({
    workspace: { person_max_mb: 1, person_max_files: 20 },
    ...config,
  });
  const client = new HttpSandboxClient({
    endpoints,
    config: parsed,
    jobs,
    quota: () => quota,
    pollWaitMs: 50,
  });
  const sandbox = new RemoteSandbox(parsed, {
    client,
    workspace,
    tools: new ToolsWorkspace(join(root, "core", "tools"), { maxScripts: 5, maxScriptBytes: 4096 }),
    quota: () => quota,
    jobs,
    coreHosts: () => coreHosts,
  });
  opened.push(sandbox);
  return { sandbox, endpoints, client, config: parsed };
}

const AMY: WorkPayer = { person: "person-amy" };

/** A tar with nothing in it (a sync that only names deletions). */
async function emptyTar(): Promise<Buffer> {
  const pack = tar.pack();
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Writes `text` to `path` in the job's /workspace, as a program would. */
async function put(dir: string, path: string, text: string): Promise<void> {
  await mkdir(join(dir, path, ".."), { recursive: true });
  await writeFile(join(dir, path), text);
}

describe("choosing a computer", () => {
  it("skips_one_not_ready_and_moves_on_from_a_busy_one", async () => {
    const down = machine("down-pc", { ready: false, reason: "沙箱映像檔還沒建好" });
    const busy = machine("busy-pc", { refuseCreate: { status: 429, code: "busy" } });
    const good = machine("good-pc");
    const { sandbox, endpoints } = sandboxOn([down, busy, good]);
    await sandbox.health({ refresh: true });
    const result = await sandbox.run({ language: "python", code: "print(1)" });
    expect(result.host).toBe("good-pc");
    expect(down.jobs.size).toBe(0);
    expect(good.jobs.size).toBe(1);
    // The busy one was reserved and given back; the good one accepted and finished.
    expect(endpoints.reserved.map((r) => [r.host, r.accepted])).toEqual([
      ["busy-pc", false],
      ["good-pc", true],
    ]);
    expect(endpoints.failedHosts).toEqual([]);
    // A run job is closed once it is done.
    const job = [...good.jobs.values()][0];
    expect(job?.view.ended?.reason).toBe("closed");
    expect(job?.create).toMatchObject({ kind: "run", for: "self", payer: null });
  });

  it("tells_why_when_none_takes_it", async () => {
    const strict = machine("friend-pc", { members: false });
    const { sandbox } = sandboxOn([strict]);
    await sandbox.health({ refresh: true });
    const refused = await sandbox
      .run({ language: "shell", code: "ls", for: "member", payer: AMY })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SandboxError);
    expect((refused as SandboxError).kind).toBe("not_accepting");
    expect((refused as SandboxError).message).toContain("都不接成員的工作");

    strict.ready = false;
    strict.reason = "這台的 Docker 沒有回應";
    const health = await sandbox.health({ refresh: true });
    expect(health.available).toBe(false);
    expect(health.error).toContain("friend-pc:這台的 Docker 沒有回應");
    const none = await sandbox.run({ language: "shell", code: "ls" }).catch((e: unknown) => e);
    expect((none as SandboxError).kind).toBe("unavailable");
    expect((none as SandboxError).message).toContain("現在沒有能跑程式的電腦");
  });

  it("hides_who_pays_from_the_computer", async () => {
    const pc = machine("pc");
    const { sandbox } = sandboxOn([pc]);
    await sandbox.health({ refresh: true });
    await sandbox.run({ language: "shell", code: "true", for: "member", payer: AMY });
    const create = [...pc.jobs.values()][0]?.create;
    expect(create?.payer).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(create)).not.toContain("person-amy");
  });
});

describe("CPU seconds", () => {
  it("refuse_a_run_whose_payer_is_at_the_limit_before_anything_opens", async () => {
    const pc = machine("pc");
    const { sandbox } = sandboxOn([pc]);
    await sandbox.health({ refresh: true });
    quota.limitSeconds = 1;
    quota.charged.push({ person: AMY.person, seconds: 5 });
    const refused = await sandbox
      .run({ language: "shell", code: "true", for: "member", payer: AMY })
      .catch((e: unknown) => e);
    expect((refused as SandboxError).kind).toBe("quota");
    expect((refused as SandboxError).message).toBe(
      "你這個小時找我跑的程式有點多,大概 12 分鐘後再來。",
    );
    expect(pc.jobs.size).toBe(0);
  });

  it("are_charged_and_stop_a_run_that_goes_over", async () => {
    const program: Program = async (exec) => {
      // A second of wall time first: on its 2 CPUs a job cannot be charged more than that allows.
      await new Promise((r) => setTimeout(r, 1000));
      exec.cpu(1500);
      // Stopped by Core once the charge passes the limit.
      return { stdout: `stopped:${await exec.stopped}` };
    };
    const pc = machine("pc", { program });
    const { sandbox } = sandboxOn([pc]);
    await sandbox.health({ refresh: true });
    quota.limitSeconds = 1;
    const result = await sandbox.run({
      language: "python",
      code: "while True: pass",
      for: "member",
      payer: AMY,
    });
    expect(result.killed_reason).toBe("quota");
    expect(quota.used(AMY.person).hour).toBeCloseTo(1.5);
  });
});

describe("the folder in and back", () => {
  it("goes_in_and_what_the_program_changed_comes_back", async () => {
    await workspace.write("notes/in.txt", "from core");
    await workspace.write("people/someone/secret.txt", "not hers");
    const program: Program = async (exec) => {
      const seen = await readFile(join(exec.workspace, "notes/in.txt"), "utf8");
      const leaked = await lstat(join(exec.workspace, "people")).then(
        () => true,
        () => false,
      );
      await put(exec.workspace, "out/result.txt", "from the program");
      return { stdout: `${seen}|people:${leaked}` };
    };
    const pc = machine("pc", { program });
    const { sandbox } = sandboxOn([pc]);
    await sandbox.health({ refresh: true });
    const result = await sandbox.run({
      language: "python",
      code: "x",
      mount_workspace: true,
    });
    // Her own run: the whole workspace but the people's folders.
    expect(result.stdout).toBe("from core|people:false");
    expect((await workspace.read("out/result.txt")).text).toBe("from the program");
    expect(result.workspace_removed).toEqual([]);
  });

  it("an_owner_s_run_takes_the_people_s_folders_only_to_a_computer_that_takes_members", async () => {
    await workspace.write("notes/in.txt", "from core");
    await workspace.write("people/amy/secret.txt", "amy's");
    const program: Program = async (exec) => {
      const leaked = await lstat(join(exec.workspace, "people/amy/secret.txt")).then(
        () => true,
        () => false,
      );
      await put(exec.workspace, "people/amy/from-run.txt", "written there");
      return { stdout: `people:${leaked}` };
    };
    for (const [members, seen] of [
      [false, "people:false"],
      [true, "people:true"],
    ] as const) {
      const pc = machine(`pc-${members}`, { members, program });
      const { sandbox } = sandboxOn([pc]);
      await sandbox.health({ refresh: true });
      const result = await sandbox.run({
        language: "python",
        code: "x",
        mount_workspace: true,
        for: "owner",
      });
      expect(result.stdout).toBe(seen);
      // What a computer that never got the folders writes there does not come back.
      expect(await workspace.exists("people/amy/from-run.txt")).toBe(members);
      await sandbox.close();
    }
  });

  it("members_work_goes_only_to_a_computer_core_lets_have_it_whatever_it_says", async () => {
    await workspace.write("people/amy/secret.txt", "amy's");
    const program: Program = async (exec) => {
      const leaked = await lstat(join(exec.workspace, "people/amy/secret.txt")).then(
        () => true,
        () => false,
      );
      return { stdout: `people:${leaked}` };
    };
    // It says it takes members' work, but nobody at Core said it may have it.
    const friend = machine("friend-pc", { members: true, program });
    const { sandbox } = sandboxOn([friend], {}, []);
    await sandbox.health({ refresh: true });
    expect(sandbox.memberHost("friend-pc")).toBe(false);
    const refused = await sandbox
      .run({
        language: "python",
        code: "x",
        mount_workspace: true,
        workspace_folder: "amy",
        for: "member",
        payer: AMY,
      })
      .catch((e: unknown) => e);
    expect((refused as SandboxError).kind).toBe("not_accepting");
    expect((refused as SandboxError).message).toContain("都不接成員的工作");
    expect(friend.jobs.size).toBe(0);
    // An owner's run over everything goes there without the people's folders.
    const owner = await sandbox.run({
      language: "python",
      code: "x",
      mount_workspace: true,
      for: "owner",
    });
    expect(owner.stdout).toBe("people:false");
    await sandbox.close();

    // Listed by the owner: both.
    const listed = sandboxOn([friend], { transfer: { member_hosts: ["Friend-PC"] } }, []);
    await listed.sandbox.health({ refresh: true });
    const run = await listed.sandbox.run({
      language: "python",
      code: "x",
      mount_workspace: true,
      for: "owner",
    });
    expect(run.stdout).toBe("people:true");
    await listed.sandbox.run({
      language: "python",
      code: "x",
      mount_workspace: true,
      workspace_folder: "amy",
      for: "member",
      payer: AMY,
    });
    const member = [...friend.jobs.values()].find((j) => j.create.for === "member");
    expect(member).toBeDefined();
  });

  it("a_member_s_job_opens_only_on_a_listed_computer", async () => {
    const stranger = machine("stranger-pc", { members: true });
    const mine = machine("core-pc", { members: true });
    // Core's own machine needs no listing.
    const { sandbox } = sandboxOn([stranger, mine], {}, ["core-pc"]);
    await sandbox.health({ refresh: true });
    const result = await sandbox.run({
      language: "shell",
      code: "true",
      for: "member",
      payer: AMY,
    });
    expect(result.host).toBe("core-pc");
    expect(stranger.jobs.size).toBe(0);
  });

  it("a_person_s_run_sees_only_their_folder_and_is_held_to_its_caps", async () => {
    await workspace.write("mine.txt", "hers");
    await workspace.write("people/amy/a.txt", "amy's");
    const program: Program = async (exec) => {
      const names = await import("node:fs/promises").then((fs) => fs.readdir(exec.workspace));
      // Over the person's 1 MiB.
      await put(exec.workspace, "big.bin", "x".repeat(2 * MIB));
      return { stdout: names.sort().join(",") };
    };
    const pc = machine("pc", { program });
    const { sandbox } = sandboxOn([pc]);
    await sandbox.health({ refresh: true });
    const result = await sandbox.run({
      language: "python",
      code: "x",
      mount_workspace: true,
      workspace_folder: "amy",
      for: "member",
      payer: AMY,
    });
    expect(result.stdout).toBe("a.txt");
    expect(await workspace.exists("people/amy/big.bin")).toBe(false);
    expect(await workspace.exists("big.bin")).toBe(false);
    expect((await workspace.read("people/amy/a.txt")).text).toBe("amy's");
  });

  it("refuses_everything_a_hostile_computer_sends_outside_the_folder", async () => {
    await workspace.write("people/amy/keep.txt", "keep");
    await workspace.write("people/bob/b.txt", "bob's");
    await writeFile(join(root, "outside.txt"), "outside");
    // A link in her folder that points outside (as if planted): never followed.
    await mkdir(join(workspace.dir, "people", "amy"), { recursive: true });
    await symlink(join(root), join(workspace.dir, "people", "amy", "link"), "junction").catch(
      () => undefined,
    );
    const pack = tar.pack();
    const add = (name: string, body: string, type: "file" | "symlink" = "file") =>
      type === "file"
        ? pack.entry({ name, size: Buffer.byteLength(body) }, body)
        : pack.entry({ name, type: "symlink", linkname: body });
    add("../escaped.txt", "x");
    add("/abs.txt", "x");
    add("C:/drive.txt", "x");
    add("ok\\..\\back.txt", "x");
    add("evil-link", "/etc/passwd", "symlink");
    add("link/through.txt", "x");
    add("good.txt", "fine");
    pack.finalize();
    const gz = pack.pipe(createGzip());
    const chunks: Buffer[] = [];
    for await (const c of gz) chunks.push(c as Buffer);
    const pc = machine("pc");
    pc.hostileSync = {
      tar: Buffer.concat(chunks),
      deleted: ["../outside.txt", "../bob/b.txt", "keep.txt/../../bob/b.txt", "/etc/passwd"],
    };
    const { sandbox } = sandboxOn([pc]);
    await sandbox.health({ refresh: true });
    await sandbox.run({
      language: "python",
      code: "x",
      mount_workspace: true,
      workspace_folder: "amy",
      for: "member",
    });
    expect((await workspace.read("people/amy/good.txt")).text).toBe("fine");
    expect((await workspace.read("people/bob/b.txt")).text).toBe("bob's");
    expect((await workspace.read("people/amy/keep.txt")).text).toBe("keep");
    expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("outside");
    for (const gone of ["escaped.txt", "abs.txt", "through.txt"]) {
      expect(
        await lstat(join(root, gone)).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    }
    expect(await workspace.exists("people/amy/evil-link")).toBe(false);
  });

  it("her_own_run_cannot_reach_people_through_what_comes_back", async () => {
    await workspace.write("people/bob/b.txt", "bob's");
    const pack = tar.pack();
    pack.entry({ name: "people/bob/b.txt", size: 4 }, "evil");
    pack.entry({ name: "PEOPLE/bob/new.txt", size: 4 }, "evil");
    pack.entry({ name: "mine.txt", size: 4 }, "mine");
    pack.finalize();
    const chunks: Buffer[] = [];
    for await (const c of pack) chunks.push(c as Buffer);
    const pc = machine("pc");
    pc.hostileSync = { tar: Buffer.concat(chunks), deleted: ["people/bob/b.txt"] };
    const { sandbox } = sandboxOn([pc]);
    await sandbox.health({ refresh: true });
    await sandbox.run({ language: "python", code: "x", mount_workspace: true });
    expect((await workspace.read("people/bob/b.txt")).text).toBe("bob's");
    expect(await workspace.exists("people/bob/new.txt")).toBe(false);
    expect((await workspace.read("mine.txt")).text).toBe("mine");
  });

  it("a_hostile_list_of_deletions_makes_no_folders_and_is_cut_at_the_file_cap", async () => {
    for (let i = 0; i < 5; i++) await workspace.write(`people/amy/keep-${i}.txt`, "kept");
    await workspace.write("people/amy/gone.txt", "bye");
    const pc = machine("pc");
    // 20 is the person's file cap: the real names after that many are never looked at.
    const deep = Array.from({ length: 19 }, (_, i) => `deep-${i}/a/b/c/d.txt`);
    pc.hostileSync = {
      tar: await emptyTar(),
      deleted: ["gone.txt", ...deep, ...Array.from({ length: 5 }, (_, i) => `keep-${i}.txt`)],
    };
    const { sandbox } = sandboxOn([pc]);
    await sandbox.health({ refresh: true });
    await sandbox.run({
      language: "python",
      code: "x",
      mount_workspace: true,
      workspace_folder: "amy",
      for: "member",
    });
    expect(await workspace.exists("people/amy/gone.txt")).toBe(false);
    for (let i = 0; i < 5; i++)
      expect(await workspace.exists(`people/amy/keep-${i}.txt`)).toBe(true);
    // Resolving where a deletion would land creates nothing on Core's disk.
    expect(await workspace.exists("people/amy/deep-0")).toBe(false);
  });

  it("takes_no_deletions_with_changes_that_were_refused", async () => {
    await workspace.write("people/amy/keep.txt", "kept");
    const pack = tar.pack();
    // Over the person's 20 files: none of the changes is taken.
    for (let i = 0; i < 25; i++) pack.entry({ name: `junk-${i}.txt`, size: 1 }, "x");
    pack.finalize();
    const chunks: Buffer[] = [];
    for await (const c of pack) chunks.push(c as Buffer);
    const pc = machine("pc");
    pc.hostileSync = { tar: Buffer.concat(chunks), deleted: ["keep.txt"] };
    const { sandbox } = sandboxOn([pc]);
    await sandbox.health({ refresh: true });
    await sandbox.run({
      language: "python",
      code: "x",
      mount_workspace: true,
      workspace_folder: "amy",
      for: "member",
    });
    expect(await workspace.exists("people/amy/junk-0.txt")).toBe(false);
    expect((await workspace.read("people/amy/keep.txt")).text).toBe("kept");
  });

  it("says_how_big_a_folder_too_large_to_send_is", async () => {
    await workspace.write("people/amy/a.txt", "a".repeat(600 * 1024));
    await workspace.write("people/amy/b.txt", "b".repeat(600 * 1024));
    const pc = machine("pc");
    const { sandbox } = sandboxOn([pc], {
      transfer: { max_mb: 1 },
      workspace: { person_max_mb: 4, person_max_files: 20 },
    });
    await sandbox.health({ refresh: true });
    const refused = await sandbox
      .run({
        language: "python",
        code: "x",
        mount_workspace: true,
        workspace_folder: "amy",
        for: "member",
      })
      .catch((e: unknown) => e);
    expect((refused as SandboxError).kind).toBe("too_large");
    expect((refused as SandboxError).message).toContain(
      "這個資料夾太大了(2 MB),一次最多送 1 MB 進沙箱",
    );
  });
});

describe("sessions", () => {
  it("keep_one_job_and_carry_her_changes_both_ways", async () => {
    const program: Program = async (exec) => {
      if (exec.code === "write") await put(exec.workspace, "made.txt", "by the program");
      if (exec.code === "both") await put(exec.workspace, "shared.txt", "program's");
      const text = await readFile(join(exec.workspace, "shared.txt"), "utf8").catch(() => "-");
      return { stdout: text };
    };
    const pc = machine("pc", { program });
    const { sandbox } = sandboxOn([pc]);
    await sandbox.health({ refresh: true });
    const first = await sandbox.run({ language: "shell", code: "write", session: "main" });
    expect(first.session).toEqual({ name: "main", created: true, closed: null });
    expect((await workspace.read("made.txt")).text).toBe("by the program");

    // She changes a file on Core's side between runs: it is there in the next one.
    await workspace.write("shared.txt", "hers");
    const second = await sandbox.run({ language: "shell", code: "read", session: "main" });
    expect(second.stdout).toBe("hers");
    expect(second.session?.created).toBe(false);
    expect(pc.jobs.size).toBe(1);
    expect((await sandbox.listSessions()).map((s) => s.name)).toEqual(["main"]);
    // What changed went in alone, not the whole folder again.
    const job = [...pc.jobs.values()][0];
    expect(job?.deletes).toEqual([]);

    // Deleting on Core's side reaches the job too.
    await workspace.remove("made.txt");
    await sandbox.run({ language: "shell", code: "read", session: "main" });
    expect(job?.deletes).toEqual([["made.txt"]]);
  });

  it("keep_her_copy_when_both_sides_changed_a_file", async () => {
    await workspace.write("shared.txt", "before");
    const program: Program = async (exec) => {
      await put(exec.workspace, "shared.txt", "program's");
      // She writes the same file on Core's side while the program runs.
      await workspace.write("shared.txt", "hers, meanwhile");
      return { stdout: "done" };
    };
    const pc = machine("pc", { program });
    const { sandbox } = sandboxOn([pc]);
    await sandbox.health({ refresh: true });
    const result = await sandbox.run({ language: "shell", code: "x", session: "main" });
    expect((await workspace.read("shared.txt")).text).toBe("program's");
    expect(result.workspace_conflicts).toHaveLength(1);
    const kept = result.workspace_conflicts?.[0] as string;
    expect(kept).toMatch(/^shared\.txt\.conflict-\d{8}T\d{6}Z$/);
    expect((await workspace.read(kept)).text).toBe("hers, meanwhile");
  });

  it("are_told_once_when_their_computer_ended_them", async () => {
    const pc = machine("pc");
    const { sandbox } = sandboxOn([pc]);
    await sandbox.health({ refresh: true });
    await sandbox.run({ language: "shell", code: "true", session: "main" });
    const id = [...pc.jobs.keys()][0] as string;
    pc.end(id, "idle");
    await waitFor(async () => (await sandbox.listSessions()).length === 0);
    const told = await sandbox
      .run({ language: "shell", code: "true", session: "main" })
      .catch((e: unknown) => e);
    expect(told).toBeInstanceOf(SessionClosedError);
    expect((told as SessionClosedError).reason).toBe("idle");
    const again = await sandbox.run({ language: "shell", code: "true", session: "main" });
    expect(again.session?.created).toBe(true);
  });

  it("hold_to_the_per_person_limit", async () => {
    const pc = machine("pc");
    const { sandbox } = sandboxOn([pc], {
      sessions: { per_person: 1 },
      workspace: { person_max_mb: 1, person_max_files: 20 },
    });
    await sandbox.health({ refresh: true });
    const base = {
      language: "shell" as const,
      code: "true",
      workspace_folder: "amy",
      for: "member" as const,
    };
    await sandbox.run({ ...base, session: "pabc1234-one" });
    const refused = await sandbox
      .run({ ...base, session: "pabc1234-two" })
      .catch((e: unknown) => e);
    expect((refused as SandboxError).kind).toBe("limit");
  });

  it("are_found_again_after_a_restart_of_core", async () => {
    const pc = machine("pc");
    const first = sandboxOn([pc]);
    await first.sandbox.health({ refresh: true });
    await first.sandbox.run({ language: "shell", code: "true", session: "main", payer: AMY });
    await first.sandbox.run({ language: "shell", code: "true", session: "gone" });
    const goneId = [...pc.jobs.values()].find((j) => j.create.label === "gone")?.id as string;
    await first.sandbox.close();
    opened = opened.filter((s) => s !== first.sandbox);
    // Its computer lost one of them while Core was away.
    pc.jobs.delete(goneId);

    const second = sandboxOn([pc]);
    expect(await second.sandbox.restore()).toBe(1);
    expect((await second.sandbox.listSessions()).map((s) => s.name)).toEqual(["main"]);
    const again = await second.sandbox.run({ language: "shell", code: "true", session: "main" });
    expect(again.session?.created).toBe(false);
    const lost = await second.sandbox
      .run({ language: "shell", code: "true", session: "gone" })
      .catch((e: unknown) => e);
    expect((lost as SessionClosedError).reason).toBe("lost");
    expect(jobs.get(goneId)?.state).toBe("ended");
  });
});

async function waitFor(check: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
