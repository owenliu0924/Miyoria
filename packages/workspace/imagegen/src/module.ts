import { actuatorsFor } from "@miyoria/gate/actions";
import {
  defineManifest,
  errorMessage,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
  sleep,
} from "@miyoria/runtime/kernel";
import {
  Events,
  ImageGenKey,
  type JsonValue,
  parseSongCue,
  parseSongPrepare,
} from "@miyoria/types";
import { ComfyClient } from "./comfy.js";
import { ImageGenConfigSchema } from "./config.js";
import type { EndpointsOption } from "./endpoints.js";
import { ImageGenService } from "./service.js";
import { imageMakeCapability } from "./tool.js";

/** How often the module looks again whether ComfyUI answers, to offer or withdraw `image_make`. */
const RECHECK_MS = 30_000;

/**
 * Module `imagegen` (docs/design/imagegen.md): pictures made on a ComfyUI server. Provides
 * `ImageGen` (`ImageGenKey`) for the other parts of her; it has no commands and nothing a member
 * can call. Off unless `[modules.imagegen] enabled = true`. Listens to the `sing` module's cues
 * so the GPU goes to her songs first. While ComfyUI answers it offers her `image_make` in the
 * app's actuator registry (`tool.ts`) and withdraws it when ComfyUI stops answering, the way the
 * sandbox does for Docker. ComfyUI is the `imagegen` endpoint of Core's registry
 * (`endpoints`); `[modules.imagegen] url` and `headers` are read by Core's wiring, which makes them
 * a static entry.
 */
export class ImageGenModule implements Module {
  static readonly ID = "imagegen";
  readonly manifest = defineManifest(ImageGenModule.ID, "Image generation", {
    icon: "image",
    category: "system",
    description: "Pictures made on a ComfyUI server: Krea 2, MOSS-Image, Anima and workflow files",
    optional: ["sing"],
    configSchema: ImageGenConfigSchema,
  });
  readonly #baseDir: string;
  readonly #endpoints: EndpointsOption | null;
  #service: ImageGenService | null = null;
  #withdraw: (() => void) | null = null;

  constructor(options: { baseDir?: string; endpoints?: EndpointsOption } = {}) {
    this.#baseDir = options.baseDir ?? process.cwd();
    this.#endpoints = options.endpoints ?? null;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(ImageGenConfigSchema);
    const client = new ComfyClient({ endpoints: this.#endpoints?.(ctx.services) ?? null });
    const service = new ImageGenService({
      config,
      baseDir: this.#baseDir,
      client,
      clock: ctx.clock,
      log: ctx.log,
      publish: ctx.publisher,
    });
    await service.load();
    this.#service = service;
    ctx.provide(ImageGenKey, service);

    const songs = ctx.subscribe([Events.SingCue.type, Events.SingPrepare.type]);
    ctx.spawn("songs", async () => {
      for await (const env of songs) {
        const topic = env.type;
        const payload = env.data as JsonValue;
        if (topic === Events.SingCue.type) {
          const cue = parseSongCue(payload);
          if (cue) service.onSongCue(cue);
        } else if (topic === Events.SingPrepare.type) {
          const prepare = parseSongPrepare(payload);
          if (prepare) service.onSongPrepare(prepare);
        }
      }
    });
    ctx.spawn("jobs", (signal) => service.run(signal));
    const actuators = actuatorsFor(ctx);
    const capability = imageMakeCapability({ imagegen: () => this.#service });
    const offer = (reachable: boolean): void => {
      if (reachable && this.#withdraw === null) {
        this.#withdraw = actuators.register(capability);
      } else if (!reachable && this.#withdraw !== null) {
        this.#withdraw();
        this.#withdraw = null;
      }
    };
    ctx.spawn("tool", async (signal) => {
      while (!signal.aborted) {
        try {
          offer((await service.status()).reachable);
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "could not check ComfyUI for image_make");
        }
        try {
          await sleep(RECHECK_MS, signal);
        } catch {
          return;
        }
      }
    });
    ctx.log.info(
      { url: service.comfyui(), models: service.models().map((m) => m.id) },
      "image generation ready",
    );
  }

  async health(): Promise<Health> {
    const service = this.#service;
    if (service === null) return HEALTHY;
    const status = await service.status();
    if (!status.reachable) {
      const url = service.comfyui();
      return {
        status: "degraded",
        reason:
          url === null
            ? "no ComfyUI is known to the endpoint registry"
            : `ComfyUI is not answering at ${url}`,
      };
    }
    return HEALTHY;
  }

  async stop(): Promise<void> {
    this.#withdraw?.();
    this.#withdraw = null;
    this.#service = null;
  }
}
