// `image.make` (tool `image_make`): she draws a picture for the person who asked, on the ComfyUI
// server (the only way pictures are made: ComfyUI's API, nothing else). The picture comes back
// as an artifact made for that person in the place of the turn (docs/design/v6-agent.md), so
// `share` can hand it over, and as a picture she can look at.
//
// It is a work step like her file tools: held by owners, and by members whose bond with her
// reaches `work_min_bond` (`WORK_IMAGE`, a work node). The module offers it only while ComfyUI
// answers (`module.ts`); a call that arrives after it stopped says so honestly instead of
// failing, so she can tell the person.

import { readFile } from "node:fs/promises";
import { type ActionResult, type Capability, defineCapability } from "@miyoria/gate/actions";
import { type ArtifactStore, ArtifactStoreKey } from "@miyoria/store";
import { escapeData, type ImageGen, type ImageJob } from "@miyoria/types";
import { z } from "zod";
import { ImageArtifactError, ingestImageOutput } from "./artifact.js";
import { ImageGenError } from "./service.js";

export const IMAGE_MAKE = "image.make";

/** The node a bond can stand for (`WORK_IMAGE` in `@miyoria/commands`). */
const NODE_IMAGE = "work.image";

/** What the files and the daily limits of her own pictures go by (`ImageSubmitOptions.purpose`). */
export const IMAGE_PURPOSE = "agent";

/** How long one call waits for the picture before it gives up and cancels the job. */
export const DEFAULT_WAIT_MS = 180_000;

/** The largest picture handed to the model to look at; a bigger one is only an artifact. */
const MAX_LOOK_BYTES = 3 * 1024 * 1024;

const SIZES: Readonly<Record<string, readonly [number, number]>> = {
  square: [1024, 1024],
  portrait: [832, 1216],
  landscape: [1216, 832],
};

export const ImageMakeArgsSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  model: z.string().trim().min(1).max(40).optional(),
  variant: z.string().trim().min(1).max(40).optional(),
  size: z.string().trim().min(1).max(20).optional(),
});
export type ImageMakeArgs = z.output<typeof ImageMakeArgsSchema>;

/** `square`, `portrait`, `landscape` or `<width>x<height>`; `null` when it is none of them. */
export function parseSize(size: string): [number, number] | null {
  const word = SIZES[size.toLowerCase()];
  if (word !== undefined) return [word[0], word[1]];
  const m = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i.exec(size);
  return m === null ? null : [Number(m[1]), Number(m[2])];
}

export interface ImageMakeOptions {
  /** The service; `null` while the module is not running. */
  imagegen: () => ImageGen | null;
  /** How long a call waits for the picture (default 3 minutes). */
  waitMs?: number;
}

function refused(code: string, text: string): ActionResult {
  return { text, data: { ok: false, refused: code } };
}

function modelList(imagegen: ImageGen): string {
  return imagegen
    .models()
    .map((m) => `${m.id}(${m.label};variant:${m.variants.join("/")},預設 ${m.default_variant})`)
    .join("、");
}

/** `image.make`, over the image service and the app's artifact store. */
export function imageMakeCapability(options: ImageMakeOptions): Capability<ImageMakeArgs> {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  return defineCapability<ImageMakeArgs>({
    name: IMAGE_MAKE,
    summary: "替開口的人畫一張圖(在 ComfyUI 上生成),存成產物",
    risk: "medium",
    work: true,
    args: ImageMakeArgsSchema,
    permission: NODE_IMAGE,
    tool: {
      name: "image_make",
      meta: { effect: "external", speed: "instant", group: "image" },
      followup: true,
      description:
        "畫一張圖給現在開口要的人:prompt 寫要畫什麼(越具體越好,照模型的習慣寫),用一台跑 ComfyUI 的電腦生成,要等一下。" +
        "畫好會回給你一個產物 id 和那張圖(你看得到);要給對方就用 share,artifact 填這個 id。" +
        "model 和 variant 通常省略(用預設的);size 是 square、portrait、landscape 或 1024x768 這樣的寬x高。" +
        "那台電腦不在、排隊太久或今天的張數用完時會告訴你原因,照原因跟對方說,不要假裝畫了。" +
        "圖是替開口的人做的,只在現在這個頻道或私訊裡能給。",
      properties: {
        prompt: { type: "string", description: "要畫什麼" },
        model: { type: "string", description: "模型(可省略)" },
        variant: { type: "string", description: "模型的版本(可省略)" },
        size: {
          type: "string",
          description: "square、portrait、landscape 或 寬x高,例如 1024x768(可省略)",
        },
      },
      required: ["prompt"],
    },
    describe: (a) => ({ lines: [`生成圖片:${a.prompt.slice(0, 120)}`] }),
    async execute(a, ctx): Promise<ActionResult> {
      const imagegen = options.imagegen();
      if (imagegen === null) return refused("unavailable", "現在沒有生圖的功能,沒辦法畫。");
      const status = await imagegen.status();
      if (!status.reachable) {
        return refused(
          "no_machine",
          "現在連不上跑生圖的那台電腦(ComfyUI 沒開或不在線上),沒辦法畫。跟對方說等那台開了再試。",
        );
      }
      const store: ArtifactStore | undefined = ctx.services.get(ArtifactStoreKey);
      if (!store) return refused("unavailable", "現在沒有產物庫,畫好的圖沒地方存,所以不畫。");
      const { context, requester } = ctx.principal;
      const site = context === null ? null : store.places.at(context, requester, { create: true });
      if (context !== null && site === null) {
        return refused("unknown_place", "我認不出這個地方或這個人,所以不畫。");
      }
      let size: [number, number] | null = null;
      if (a.size !== undefined) {
        size = parseSize(a.size);
        if (size === null) {
          return refused("size", "size 要寫 square、portrait、landscape,或像 1024x768 的寬x高。");
        }
      }
      let job: ImageJob;
      try {
        job = await imagegen.submit(
          {
            prompt: a.prompt,
            ...(a.model === undefined ? {} : { model: a.model }),
            ...(a.variant === undefined ? {} : { variant: a.variant }),
            ...(size === null ? {} : { width: size[0], height: size[1] }),
          },
          { purpose: IMAGE_PURPOSE, priority: "interactive", note: "image_make" },
        );
      } catch (error) {
        if (!(error instanceof ImageGenError)) throw error;
        const limit = error.status === 429;
        const unknown = /model|variant|workflow/i.test(error.message);
        return refused(
          limit ? "limit" : "request",
          limit
            ? `今天畫圖的張數用完了(${escapeData(error.message)})。`
            : `這張圖畫不了:${escapeData(error.message)}${unknown ? `。可以用的模型:${modelList(imagegen)}` : ""}`,
        );
      }
      const waiting = new AbortController();
      const stop = () => waiting.abort(ctx.signal.reason);
      ctx.signal.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(() => waiting.abort(new Error("timeout")), waitMs);
      let done: ImageJob;
      try {
        done = await imagegen.wait(job.id, waiting.signal);
      } catch (error) {
        // Not done in time, or her turn was stopped: the job is cancelled so it does not draw
        // a picture nobody is waiting for.
        await imagegen.cancel(job.id).catch(() => null);
        if (ctx.signal.aborted) throw error;
        return refused(
          "timeout",
          "畫太久了(前面在排隊或那台電腦很忙),先取消了。跟對方說晚一點再試。",
        );
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", stop);
      }
      const output = done.outputs[0];
      if (done.state !== "done" || output === undefined) {
        return refused(
          done.state === "cancelled" ? "cancelled" : "failed",
          done.state === "cancelled"
            ? "這張圖被取消了(例如那台電腦先去做別的事),沒畫成。"
            : `這張圖沒畫成${done.error === null ? "" : `:${escapeData(done.error).slice(0, 200)}`}。`,
        );
      }
      try {
        const artifact = await ingestImageOutput(store, done, output, {
          place: site?.place ?? null,
          made_for: site?.person_id ?? null,
          turn: ctx.request.turn,
          signal: ctx.signal,
        });
        const result: ActionResult = {
          text:
            `畫好了,存成產物 ${artifact.id}(${artifact.mime},${artifact.size} bytes)。` +
            "要給人就用 share,artifact 填這個 id;你也看得到這張圖。",
          data: {
            ok: true,
            artifact_id: artifact.id,
            mime: artifact.mime,
            size: artifact.size,
            job: done.id,
            width: done.request.width,
            height: done.request.height,
          },
        };
        if (output.bytes > MAX_LOOK_BYTES) return result;
        const bytes = await readFile(output.path);
        return {
          ...result,
          images: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${bytes.toString("base64")}`,
                detail: "low",
              },
              alt: `畫好的圖(${a.prompt.slice(0, 40)})`,
            },
          ],
        };
      } catch (error) {
        if (error instanceof ImageArtifactError) {
          return refused("failed", "畫好的圖存不進產物庫,沒辦法給人。");
        }
        // The store takes what it recognises as a picture; anything else it refuses is not hers.
        if ((error as Error).name.startsWith("Artifact")) {
          return refused("failed", "畫好的圖存不進產物庫(類型或大小不收),沒辦法給人。");
        }
        throw error;
      }
    },
  }) as Capability<ImageMakeArgs>;
}
