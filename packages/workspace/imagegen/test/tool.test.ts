// `image_make`: the picture is made through ImageGen, kept as an artifact made for the person who
// asked in the place of the turn, and handed to her to look at. A fake ImageGen stands in for
// ComfyUI.

import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionResult, ExecContext } from "@miyoria/gate/actions";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { ArtifactStoreKey, SqliteStore } from "@miyoria/store";
import type {
  AccountRef,
  ContextKey,
  ImageGen,
  ImageJob,
  ImageRequestInput,
  ImageSubmitOptions,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMAGE_MAKE, ImageGenError, imageMakeCapability, parseSize } from "../src/index.js";

const PNG = Uint8Array.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...Array(100).fill(9),
]);
const MIA: AccountRef = { platform: "discord", id: "200" };
const ROOM: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };

let base: string;
let store: SqliteStore;
let services: ServiceRegistry;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "miyoria-image-make-"));
  store = await SqliteStore.open(join(base, "a.db"));
  store.persons.resolve(ROOM, { account: MIA, display_name: "Mia" });
  services = new ServiceRegistry();
  services.provide("test", ArtifactStoreKey, store.artifacts as never);
});

afterEach(async () => {
  await store.close();
  rmSync(base, { recursive: true, force: true });
});

class FakeImageGen {
  reachable = true;
  /** How the next submit fails, or the state its job ends in. */
  submitError: Error | null = null;
  endsAs: ImageJob["state"] = "done";
  hang = false;
  readonly submitted: { request: ImageRequestInput; options: ImageSubmitOptions }[] = [];
  readonly cancelled: string[] = [];
  #job: ImageJob | null = null;
  constructor(private readonly dir: string) {}
  models() {
    return [
      { id: "krea2", label: "Krea 2", variants: ["turbo", "raw"], default_variant: "turbo" },
    ] as never;
  }
  async status() {
    return { reachable: this.reachable } as never;
  }
  async submit(request: ImageRequestInput, options: ImageSubmitOptions) {
    if (this.submitError) throw this.submitError;
    this.submitted.push({ request, options });
    const path = join(this.dir, "J1-0.png");
    await writeFile(path, PNG);
    this.#job = {
      id: "J1",
      state: "queued",
      error: this.endsAs === "failed" ? "ComfyUI refused the graph" : null,
      request: { width: request.width ?? 1024, height: request.height ?? 1024 },
      outputs:
        this.endsAs === "done"
          ? [{ path, file: "2026-11/agent/J1-0.png", index: 0, bytes: PNG.length }]
          : [],
    } as unknown as ImageJob;
    return this.#job;
  }
  wait(_id: string, signal?: AbortSignal) {
    if (this.hang) {
      return new Promise<ImageJob>((_, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    }
    if (this.#job === null) throw new Error("no job");
    return Promise.resolve({ ...this.#job, state: this.endsAs });
  }
  async cancel(id: string) {
    this.cancelled.push(id);
    return null;
  }
}

async function make(
  gen: FakeImageGen | null,
  args: object,
  who: AccountRef | null = MIA,
  where: ContextKey | null = ROOM,
  waitMs?: number,
) {
  const cap = imageMakeCapability({
    imagegen: () => gen as unknown as ImageGen | null,
    ...(waitMs === undefined ? {} : { waitMs }),
  });
  const principal = { kind: "user", requester: who, context: where, override: false, actor: null };
  const ctx = {
    principal,
    request: { principal, capability: IMAGE_MAKE, args, turn: "T1" },
    decision: {},
    services,
    signal: new AbortController().signal,
  } as unknown as ExecContext;
  return (await cap.execute(cap.args.parse(args), ctx)) as ActionResult;
}

const refused = (r: { data: unknown }) => (r.data as { refused?: string }).refused;
const artifacts = () => store.artifacts as NonNullable<typeof store.artifacts>;

describe("image_make", () => {
  it("is a medium-risk work step held through the image work node", () => {
    const cap = imageMakeCapability({ imagegen: () => null });
    expect([cap.risk, cap.work, cap.permission, cap.tool?.name]).toEqual([
      "medium",
      true,
      "work.image",
      "image_make",
    ]);
  });

  it("draws, keeps the picture as an artifact made for the asker, and shows it to her", async () => {
    const gen = new FakeImageGen(base);
    const r = await make(gen, { prompt: "一隻鯨魚在海裡", size: "landscape" });
    const data = r.data as { ok: boolean; artifact_id: string };
    expect(data.ok).toBe(true);
    expect(gen.submitted[0]?.request).toMatchObject({
      prompt: "一隻鯨魚在海裡",
      width: 1216,
      height: 832,
    });
    expect(gen.submitted[0]?.options).toMatchObject({ purpose: "agent", priority: "interactive" });
    const a = artifacts().get(data.artifact_id);
    expect(a).toMatchObject({
      source: "imagegen",
      mime: "image/png",
      turn: "T1",
      scope: "room",
    });
    expect(a?.made_for).not.toBeNull();
    expect(r.text).toContain(data.artifact_id);
    expect(r.images).toHaveLength(1);
    expect(r.images?.[0]?.image_url.url).toMatch(/^data:image\/png;base64,/);
  });

  it("says honestly when no ComfyUI machine answers, and draws nothing", async () => {
    const gen = new FakeImageGen(base);
    gen.reachable = false;
    const r = await make(gen, { prompt: "x" });
    expect(refused(r)).toBe("no_machine");
    expect(r.text).toContain("連不上");
    expect(gen.submitted).toHaveLength(0);
    expect(refused(await make(null, { prompt: "x" }))).toBe("unavailable");
  });

  it("gives the reason when the service refuses the request or the day's pictures are used up", async () => {
    const gen = new FakeImageGen(base);
    gen.submitError = new ImageGenError("unknown model `nope`", 400);
    const bad = await make(gen, { prompt: "x", model: "nope" });
    expect(refused(bad)).toBe("request");
    expect(bad.text).toContain("krea2");
    gen.submitError = new ImageGenError("today's 5 `agent` pictures are used up", 429);
    expect(refused(await make(gen, { prompt: "x" }))).toBe("limit");
  });

  it("answers a failed or cancelled job with its reason, and no artifact", async () => {
    const gen = new FakeImageGen(base);
    gen.endsAs = "failed";
    const failed = await make(gen, { prompt: "x" });
    expect(refused(failed)).toBe("failed");
    expect(failed.text).toContain("ComfyUI refused");
    gen.endsAs = "cancelled";
    expect(refused(await make(gen, { prompt: "x" }))).toBe("cancelled");
    expect(artifacts().list({})).toEqual([]);
  });

  it("cancels the job when the wait runs out", async () => {
    const gen = new FakeImageGen(base);
    gen.hang = true;
    const r = await make(gen, { prompt: "x" }, MIA, ROOM, 30);
    expect(refused(r)).toBe("timeout");
    expect(gen.cancelled).toEqual(["J1"]);
  });

  it("refuses a size it cannot read before drawing", async () => {
    const gen = new FakeImageGen(base);
    expect(refused(await make(gen, { prompt: "x", size: "huge" }))).toBe("size");
    expect(gen.submitted).toHaveLength(0);
    expect(parseSize("640x480")).toEqual([640, 480]);
    expect(parseSize("square")).toEqual([1024, 1024]);
    expect(parseSize("big")).toBeNull();
  });
});
