// Her room's Live2D figure (docs/design/her-room.md §7.3, "Live2D"): what of a model's folder is
// served (only what the manifest names, by hash), how, to whom, and the faces read against a
// fixture model. Live2D's own files are not needed: the model here is made up.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOM_FIGURE_FACES } from "@miyoria/contracts/api";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RoomConfigSchema } from "../src/room/config.js";
import {
  encodingFor,
  FIGURE_IMMUTABLE,
  FigureUnavailable,
  figureOptions,
  planModel,
  prepareFigure,
  RoomFigure,
} from "../src/room/figure.js";
import { FACE_ROWS, resolveFaces } from "../src/room/figure-faces.js";
import { roomRoutes } from "../src/room/routes.js";
import { roomStateOf } from "../src/room/state.js";
import { memberResponse } from "../src/server.js";
import { ALICE, appOf, makeRig } from "./room-rig.js";

let root = "";
let modelDir = "";
let studio = "";
let model = "";

const write = (path: string, data: string | Uint8Array) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, data);
};
const json = (path: string, value: unknown) => write(path, JSON.stringify(value));

async function png(size: number): Promise<Buffer> {
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 200, g: 80, b: 40, alpha: 0.5 },
    },
  })
    .png()
    .toBuffer();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "miyoria-figure-"));
  modelDir = join(root, "models", "她");
  studio = join(root, "studio");
  model = join(modelDir, "她.model3.json");
  json(model, {
    Version: 3,
    FileReferences: {
      Moc: "她.moc3",
      Textures: ["她.64/texture_00.png", "她.64/texture_01.png"],
      Physics: "她.physics3.json",
      DisplayInfo: "她.cdi3.json",
    },
    Groups: [
      { Target: "Parameter", Name: "EyeBlink", Ids: ["ParamEyeLOpen", "ParamEyeROpen"] },
      { Target: "Parameter", Name: "LipSync", Ids: [] },
    ],
  });
  write(join(modelDir, "她.moc3"), new Uint8Array(4096).fill(7));
  write(join(modelDir, "她.64", "texture_00.png"), await png(64));
  write(join(modelDir, "她.64", "texture_01.png"), await png(32));
  json(join(modelDir, "她.physics3.json"), { Version: 3, PhysicsSettings: [] });
  json(join(modelDir, "她.cdi3.json"), {
    Parameters: [
      "AngleX",
      "AngleY",
      "AngleZ",
      "PositionX",
      "ParamEyeBallX",
      "ParamEyeBallY",
      "ParamBreath",
      "ParamEyeLOpen",
      "ParamEyeROpen",
      "ParamMouthOpenY",
      "ParamMouthForm",
      "EyeSmile",
      "key7",
    ].map((Id) => ({ Id, GroupId: "", Name: Id })),
  });
  // VTube Studio's: the blush is a hotkey's file in `Exp3/`; the black face is not there at all.
  json(join(modelDir, "Exp3", "脸红.exp3.json"), {
    Type: "Live2D Expression",
    Parameters: [
      { Id: "key7", Value: 1, Blend: "Add" },
      { Id: "NotOnThisModel", Value: 1, Blend: "Add" },
    ],
  });
  json(join(modelDir, "Animation", "IDLE.motion3.json"), { Version: 3, Meta: {}, Curves: [] });
  json(join(modelDir, "她.vtube.json"), {
    FileReferences: { Model: "她.model3.json", IdleAnimation: "IDLE.motion3.json" },
  });
  write(join(modelDir, "她.vtube.json.miyoria-backup"), "{}");
  write(join(modelDir, "secret.txt"), "not for anyone");
  write(join(root, "models", "outside.moc3"), "outside");
  write(join(studio, "dist", "figure", "figure.js"), "export function mount() {}\n".repeat(50));
  write(join(studio, "vendor", "live2dcubismcore.min.js"), "var Live2DCubismCore;\n".repeat(50));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const logs: string[] = [];
const log = {
  info: (_: object, msg: string) => logs.push(`info: ${msg}`),
  warn: (_: object, msg: string) => logs.push(`warn: ${msg}`),
};

function figure(over: { model?: string; studio?: string; sizes?: number[]; cache?: string } = {}) {
  return new RoomFigure({
    config: { figure: "live2d", figure_textures: over.sizes ?? [32, 64] },
    model: over.model ?? model,
    studio: over.studio ?? studio,
    cache: over.cache ?? join(root, "cache"),
    log,
  });
}

describe("her figure's model", () => {
  it("reads the model, its idle motion from VTube Studio's settings, and the faces it can show", async () => {
    const plan = await planModel(model);
    expect(plan.moc).toMatch(/她\.moc3$/);
    expect(plan.textures).toHaveLength(2);
    expect(plan.idle).toMatch(/IDLE\.motion3\.json$/);
    expect(plan.rig).toMatchObject({
      angleX: "AngleX",
      bodyX: "PositionX",
      blink: ["ParamEyeLOpen", "ParamEyeROpen"],
      // The model names no lip sync parameters: the usual ones it has.
      mouth: ["ParamMouthOpenY"],
    });
    // The blush's file is there: its toggle, and nothing the model does not have.
    expect(plan.faces.embarrassed).toContainEqual({ id: "key7", value: 1, blend: "add" });
    expect(plan.faces.embarrassed?.some((p) => p.id === "NotOnThisModel")).toBe(false);
    // The black face's file is not: the row goes on with what fits.
    expect(plan.faces.annoyed?.every((p) => p.id !== "key1")).toBe(true);
    expect(plan.faces.annoyed).toContainEqual({ id: "ParamMouthForm", value: -0.4, blend: "set" });
    expect(Object.keys(plan.faces).sort()).toEqual([...ROOM_FIGURE_FACES].sort());
  });

  it("has a row for every face the page can ask for, and reads each kind of blend", async () => {
    expect(Object.keys(FACE_ROWS).sort()).toEqual([...ROOM_FIGURE_FACES].sort());
    const faces = await resolveFaces(
      async (name) =>
        name === "x.exp3.json"
          ? {
              Parameters: [
                { Id: "a", Value: 1, Blend: "Multiply" },
                { Id: "b", Value: 2, Blend: "Overwrite" },
                { Id: "c", Value: 3 },
                { Id: 4, Value: "bad" },
              ],
            }
          : null,
      null,
      { neutral: { expressions: ["x.exp3.json", "gone.exp3.json"], add: { d: 1 } } },
    );
    expect(faces.neutral).toEqual([
      { id: "a", value: 1, blend: "mul" },
      { id: "b", value: 2, blend: "set" },
      { id: "c", value: 3, blend: "add" },
      { id: "d", value: 1, blend: "add" },
    ]);
  });

  it("refuses a model whose files climb out of its folder or are not what they claim", async () => {
    const climbing = join(modelDir, "climb.model3.json");
    json(climbing, {
      FileReferences: { Moc: "../outside.moc3", Textures: ["她.64/texture_00.png"] },
    });
    await expect(planModel(climbing)).rejects.toBeInstanceOf(FigureUnavailable);
    const wrongKind = join(modelDir, "kind.model3.json");
    json(wrongKind, { FileReferences: { Moc: "她.moc3", Textures: ["secret.txt"] } });
    await expect(planModel(wrongKind)).rejects.toThrow(/texture/);
    const absolute = join(modelDir, "abs.model3.json");
    json(absolute, {
      FileReferences: { Moc: join(modelDir, "她.moc3"), Textures: ["她.64/texture_00.png"] },
    });
    await expect(planModel(absolute)).rejects.toBeInstanceOf(FigureUnavailable);
    await expect(planModel(join(modelDir, "secret.txt"))).rejects.toBeInstanceOf(FigureUnavailable);
  });
});

describe("her figure's files", () => {
  it("copies only what the page loads, the textures made smaller, and names them by hash", async () => {
    const ready = await prepareFigure({ model, studio, cache: join(root, "c1"), sizes: [32, 64] });
    const names = [...ready.files.keys()];
    expect(
      names.every((n) => /^(figure|worker|core|moc|physics|idle|tex)-[0-9a-f]{20}/.test(n)),
    ).toBe(true);
    expect(names.some((n) => /vtube|secret|cdi|exp3|backup/.test(n))).toBe(false);
    const m = ready.manifest;
    expect(m.sizes).toEqual([32, 64]);
    // The full-size set is the model's own PNGs; the smaller one WebP, every texture by the same scale.
    expect(m.textures["64"]?.every((u) => u.endsWith(".png"))).toBe(true);
    expect(m.textures["32"]?.every((u) => u.endsWith("-32.webp"))).toBe(true);
    const small = [...ready.files.entries()].filter(([n]) => n.endsWith("-32.webp"));
    const dims = await Promise.all(small.map(([, f]) => sharp(readFileSync(f.path)).metadata()));
    expect(dims.map((d) => d.width).sort()).toEqual([16, 32]);
    expect(JSON.stringify(m)).not.toContain(modelDir.replaceAll("\\", "\\\\"));
    expect(m.framing.top).toBeGreaterThan(m.framing.bottom);
  });

  it("names the worker's script when the build has one, and draws without it otherwise", async () => {
    const without = await prepareFigure({ model, studio, cache: join(root, "w0"), sizes: [32] });
    expect(without.manifest.worker).toBeNull();
    const built = join(root, "studio-worker");
    cpSync(studio, built, { recursive: true });
    writeFileSync(
      join(built, "dist", "figure", "figure-worker.js"),
      "postMessage({t:'hello',ok:false});",
    );
    const ready = await prepareFigure({
      model,
      studio: built,
      cache: join(root, "w1"),
      sizes: [32],
    });
    expect(ready.manifest.worker).toMatch(/\/figure\/worker-[0-9a-f]{20}\.js$/);
    const name = (ready.manifest.worker as string).split("/").pop() as string;
    expect(ready.files.get(name)?.type).toBe("text/javascript; charset=utf-8");
  });

  it("serves a named file a year with its compressed copy, and nothing else at all", async () => {
    const f = figure({ cache: join(root, "c2") });
    await f.prepare();
    const state = f.state();
    expect(state?.manifest).toMatch(/^\/api\/member\/room\/figure\?v=[0-9a-f]{16}$/);
    const manifest = (await f.manifest(undefined).json()) as {
      moc: string;
      textures: Record<string, string[]>;
    };
    const moc = manifest.moc.split("/").pop() as string;
    const res = await f.file(moc, "gzip, br");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(FIGURE_IMMUTABLE);
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("vary")).toBe("accept-encoding");
    await res.body?.cancel();
    const raw = await f.file(moc, undefined);
    expect(raw.headers.get("content-encoding")).toBeNull();
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(new Uint8Array(4096).fill(7));
    const tex = String(manifest.textures["32"]?.[0]).split("/").pop() as string;
    const image = await f.file(tex, "br");
    expect(image.headers.get("content-type")).toBe("image/webp");
    expect(image.headers.get("content-encoding")).toBeNull();
    await image.body?.cancel();
    for (const name of [
      "她.vtube.json",
      "她.vtube.json.miyoria-backup",
      "secret.txt",
      "../secret.txt",
      "..%2F..%2Fsecret.txt",
      "moc-00000000000000000000.moc3",
      `${moc}.br`,
      `${moc}/../../secret.txt`,
      "",
    ]) {
      await expect(f.file(name, "br")).rejects.toMatchObject({ status: 404 });
    }
  });

  it("answers the manifest again only when it changed", async () => {
    const f = figure({ cache: join(root, "c3") });
    await f.prepare();
    const first = f.manifest(undefined);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    const etag = first.headers.get("etag") as string;
    expect(f.manifest(etag).status).toBe(304);
    expect(f.manifest('"other"').status).toBe(200);
  });

  it("shows no figure, said once, when the build, Core or the model is missing", async () => {
    logs.length = 0;
    const noBuild = figure({ studio: join(root, "nowhere"), cache: join(root, "c4") });
    await noBuild.prepare();
    await noBuild.prepare();
    expect(noBuild.state()).toBeNull();
    expect(logs).toEqual([
      expect.stringMatching(/^warn: the room shows no figure: the figure is not built/),
    ]);
    expect(() => noBuild.manifest(undefined)).toThrow();
    logs.length = 0;
    const noModel = figure({ model: "", cache: join(root, "c5") });
    await noModel.prepare();
    expect(noModel.state()).toBeNull();
    expect(logs).toEqual([expect.stringMatching(/^info: .*no model is set/)]);
    logs.length = 0;
    const gone = figure({ model: join(modelDir, "nothing.model3.json"), cache: join(root, "c6") });
    await gone.prepare();
    expect(gone.state()).toBeNull();
    expect(logs[0]).toMatch(/^warn: .*does not exist/);
  });

  it.each(["none", "loops"] as const)(
    'is never made ready with `figure = "%s"`',
    async (figureName) => {
      const f = new RoomFigure({
        config: { figure: figureName, figure_textures: [32] },
        model,
        studio,
        cache: join(root, `c7-${figureName}`),
        log,
      });
      await f.prepare();
      expect(f.state()).toBeNull();
    },
  );

  it('accepts `figure = "none"` and the old `"loops"` in the config', () => {
    expect(RoomConfigSchema.parse({ figure: "none" }).figure).toBe("none");
    expect(RoomConfigSchema.parse({ figure: "loops" }).figure).toBe("loops");
  });

  it("takes the cards' model unless the room names its own, and its folders from the working one", () => {
    const config = RoomConfigSchema.parse({});
    expect(config.figure).toBe("live2d");
    expect(config.figure_textures).toEqual([1024, 2048]);
    const o = figureOptions(config, { model: "m/her.model3.json", studio: "" }, log, root);
    expect(o.model).toBe(join(root, "m", "her.model3.json"));
    expect(o.studio).toBe(join(root, "tools", "card-studio"));
    expect(o.cache).toBe(join(root, "data", "room", "figure"));
    const own = figureOptions(
      RoomConfigSchema.parse({ figure_model: "own.model3.json" }),
      { model: "m/her.model3.json", studio: "s" },
      log,
      root,
    );
    expect(own.model).toBe(join(root, "own.model3.json"));
    expect(figureOptions(config, { model: "", studio: "" }, log, root).model).toBe("");
  });

  it("picks the compressed copy the browser takes", () => {
    const both = { br: "a.br", gzip: "a.gz" };
    expect(encodingFor("gzip, deflate, br, zstd", both)).toBe("br");
    expect(encodingFor("gzip", both)).toBe("gzip");
    expect(encodingFor("br;q=0, gzip", both)).toBe("gzip");
    expect(encodingFor("identity", both)).toBeNull();
    expect(encodingFor(undefined, both)).toBeNull();
    expect(encodingFor("br", { br: null, gzip: null })).toBeNull();
  });
});

describe("her figure's routes", () => {
  async function rig() {
    const r = makeRig();
    const f = figure({ cache: join(root, "c8") });
    await f.prepare();
    r.room.figure = f;
    const as = { account: ALICE };
    const app = appOf(roomRoutes(r.state as never), as);
    return { ...r, f, app };
  }

  it("are member routes, for a session only", async () => {
    const r = await rig();
    const routes = roomRoutes(r.state as never).filter((x) => x.path.includes("/figure"));
    expect(routes.map((x) => `${x.method} ${x.path}`)).toEqual([
      "GET /api/member/room/figure",
      "GET /api/member/room/figure/:name",
    ]);
    expect(routes.every((x) => x.member === true)).toBe(true);
  });

  it("give the manifest and its files to someone the room is open to, and a 404 to anyone else", async () => {
    const r = await rig();
    const res = await r.app.request("/api/member/room/figure");
    expect(res.status).toBe(200);
    const m = (await res.json()) as { moc: string };
    const file = await r.app.request(m.moc, { headers: { "accept-encoding": "gzip" } });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-encoding")).toBe("gzip");
    await file.body?.cancel();
    expect((await r.app.request("/api/member/room/figure/..%2F..%2Fsecret.txt")).status).toBe(404);
    expect((await r.app.request("/api/member/room/figure/她.vtube.json")).status).toBe(404);
    r.blocked.add(ALICE.id);
    expect((await r.app.request("/api/member/room/figure")).status).toBe(404);
    expect((await r.app.request(m.moc)).status).toBe(404);
  });

  it("are a 404 while the room shows no figure", async () => {
    const r = makeRig();
    const app = appOf(roomRoutes(r.state as never), { account: ALICE });
    expect((await app.request("/api/member/room/figure")).status).toBe(404);
    expect(
      (await app.request("/api/member/room/figure/moc-00000000000000000000.moc3")).status,
    ).toBe(404);
  });

  it("count a member's files on a window of their own", async () => {
    const r = await rig();
    const m = (await (await r.app.request("/api/member/room/figure")).json()) as {
      physics: string;
    };
    let last = 0;
    for (let i = 0; i < 241; i++) {
      const res = await r.app.request(m.physics);
      last = res.status;
      await res.body?.cancel();
    }
    expect(last).toBe(429);
    expect(r.admitted.member).toBe(1);
  });

  it("put the manifest in the room's state only for someone the room is open to", async () => {
    const r = await rig();
    const who = {
      member: { account: ALICE, person: null, row: null, hidden: false },
      blocked: false,
      open: true,
    };
    expect(roomStateOf(r.state as never, r.room, who as never).figure?.manifest).toMatch(/\?v=/);
    expect(
      roomStateOf(r.state as never, r.room, { ...who, blocked: true } as never).figure,
    ).toBeNull();
    expect(
      roomStateOf(r.state as never, r.room, { ...who, open: false } as never).figure,
    ).toBeNull();
    r.room.figure = null;
    expect(roomStateOf(r.state as never, r.room, who as never).figure).toBeNull();
  });
});

describe("a member route's caching", () => {
  it("keeps a file's own private, long caching, and stores nothing else", async () => {
    const own = await memberResponse(
      async () => new Response("x", { headers: { "cache-control": FIGURE_IMMUTABLE } }),
    );
    expect(own.headers.get("cache-control")).toBe(FIGURE_IMMUTABLE);
    const shared = await memberResponse(
      async () => new Response("x", { headers: { "cache-control": "public, max-age=60" } }),
    );
    expect(shared.headers.get("cache-control")).toBe("no-store");
    const failed = await memberResponse(
      async () =>
        new Response("x", { status: 404, headers: { "cache-control": FIGURE_IMMUTABLE } }),
    );
    expect(failed.headers.get("cache-control")).toBe("no-store");
    const plain = await memberResponse(async () => new Response("x"));
    expect(plain.headers.get("cache-control")).toBe("no-store");
  });
});
