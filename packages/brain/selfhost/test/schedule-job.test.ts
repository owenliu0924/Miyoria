// A schedule that starts a job (v6): when it comes due the job starts for the person who asked,
// on their account (their quota, folder and bond), instead of only waking her; one that cannot
// start wakes her with the reason.

import { WORK_DELEGATE } from "@miyoria/gate/actions";
import { SqliteStore } from "@miyoria/store";
import { afterEach, describe, expect, it } from "vitest";
import { initiativeTables, type SelfHost } from "../src/index.js";
import type { ScheduledJobs } from "../src/initiative.js";
import type { ScheduleJob } from "../src/initiative-schema.js";
import { scheduleNode } from "../src/schedule-tools.js";
import { account, channel, Rig, says, stopRigs, textOf, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");
const MIN = 60_000;
const JOB: ScheduleJob = { kind: "worker", goal: "把 notes 整理成一份週報", budget: null };

function host(rig: Rig): SelfHost {
  if (rig.host === null) throw new Error("no host");
  return rig.host;
}

function fakeJobs(refuse: { code: string; text: string } | null = null) {
  const started: Parameters<ScheduledJobs["start"]>[0][] = [];
  const jobs: ScheduledJobs = {
    start(spec) {
      started.push(spec);
      return refuse === null
        ? ({ ok: true, state: "running", ahead: 0, text: "開始了", job: {} } as never)
        : { ok: false, ...refuse };
    },
  };
  return { jobs, started };
}

function setJob(rig: Rig, asker = account("amy")) {
  return host(rig).initiative.book.set({
    when: { due: Date.now() + 30 * MIN, daily: null },
    note: "每週整理",
    context: C1,
    asker,
    job: JOB,
  });
}

async function tick(rig: Rig): Promise<void> {
  await host(rig).initiative.tick();
  await new Promise((r) => setTimeout(r, 20));
}

describe("a schedule with a job", () => {
  it("starts the job for the person who asked and does not wake her", async () => {
    const rig = await Rig.create();
    const { jobs, started } = fakeJobs();
    host(rig).initiative.useJobs(jobs);
    const row = setJob(rig);
    expect(row.job).toEqual(JOB);
    rig.shift = 31 * MIN;
    await tick(rig);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      kind: "worker",
      goal: JOB.goal,
      budget: null,
      context: C1,
      from: { account: account("amy") },
    });
    expect(rig.model.requests).toHaveLength(0);
    expect(host(rig).initiative.book.open()).toHaveLength(0);
  });

  it("wakes her with the reason when the job cannot start (their quota is full)", async () => {
    const rig = await Rig.create();
    const { jobs, started } = fakeJobs({ code: "quota", text: "amy 今天的額度用完了" });
    host(rig).initiative.useJobs(jobs);
    rig.model.push(says("amy,今天的額度用完了,晚點再幫你整理"));
    setJob(rig);
    rig.shift = 31 * MIN;
    await tick(rig);
    await until(() => rig.model.requests.length === 1, 3_000, "the wake");
    expect(started).toHaveLength(1);
    expect(textOf(rig.model.requests[0])).toContain("排好要開的工作沒開成:amy 今天的額度用完了");
  });

  it("wakes her when there is no way to start a job", async () => {
    const rig = await Rig.create();
    // The host hands its delegator over; without one the schedule cannot start anything.
    host(rig).initiative.useJobs(undefined);
    rig.model.push(says("好"));
    setJob(rig);
    rig.shift = 31 * MIN;
    await tick(rig);
    await until(() => rig.model.requests.length === 1, 3_000, "the wake");
    expect(textOf(rig.model.requests[0])).toContain("現在沒辦法開工作");
  });

  it("a daily one starts its job each day", async () => {
    const rig = await Rig.create();
    const { jobs, started } = fakeJobs();
    host(rig).initiative.useJobs(jobs);
    const book = host(rig).initiative.book;
    const when = book.when("daily 08:00");
    if (when === null) throw new Error("unreadable");
    book.set({ when, note: "每天整理", context: C1, asker: account("amy"), job: JOB });
    rig.shift = when.due - Date.now() + MIN;
    await tick(rig);
    rig.shift += 24 * 60 * MIN;
    await tick(rig);
    expect(started).toHaveLength(2);
  });
});

describe("the schedule tool with a job", () => {
  it("keeps the job with the schedule; a worker needs the delegate node", async () => {
    const rig = await Rig.create();
    const entry = rig.tools.entry("schedule");
    expect(entry?.tool.permissionFor?.({ when: "1h", note: "x", job: { ...JOB } })).toBe(
      WORK_DELEGATE,
    );
    expect(
      entry?.tool.permissionFor?.({ when: "1h", note: "x", job: { ...JOB, kind: "research" } }),
    ).toBeNull();
    expect(scheduleNode({ when: "1h", note: "x" })).toBeNull();
    expect(entry?.tool.spec.description).toContain("job");
    await expect(
      entry?.tool.call(
        {
          turn: "t",
          context: C1,
          account: account("amy"),
          principal: { kind: "user", requester: account("amy"), context: C1 } as never,
          message: { context: C1, id: "m" },
          priority: "direct",
          signal: new AbortController().signal,
        },
        { when: "1h", note: "x", job: { kind: "worker", goal: "  " } },
      ),
    ).rejects.toThrow("goal");
    expect(host(rig).initiative.book.open()).toHaveLength(0);
  });
});

describe("the schedules table", () => {
  it("round-trips a job and reads one without", async () => {
    const db = await SqliteStore.open(":memory:", { plugins: [initiativeTables] });
    const tables = db.plugin(initiativeTables);
    const base = {
      due: Date.now() + MIN,
      daily: null,
      context: C1,
      person: null,
      for_account: account("amy"),
      source: "schedule" as const,
      at: Date.now(),
    };
    tables.addSchedule({ ...base, id: "A", note: "有工作", job: JOB });
    tables.addSchedule({ ...base, id: "B", note: "沒有" });
    expect(tables.schedule("A")?.job).toEqual(JOB);
    expect(tables.schedule("B")?.job).toBeNull();
    await db.close();
  });
});
