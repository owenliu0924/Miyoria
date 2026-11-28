// Her faces in the room's Live2D figure (docs/design/her-room.md §7.3, "Live2D"): what each face the
// page asks for (`ROOM_FIGURE_FACES`) is on her model, and which of the model's parameters move her.
//
// The model is DeepSeek-chan (VTube Studio's 大肥鱼). The faces are the stream's (the profile's
// `avatar.toml`, `[emotion.*]`): the same expression files from the model's `Exp3/` (its hotkeys
// in `大肥鱼.vtube.json`) and the same pose, its VTube Studio inputs turned into the model's own
// parameters by the model's input ranges (`ParameterSettings`). Toggles that are a joke on stream
// (the steel basin, the loading ring, swirl eyes for surprise) are left out: a member sees a face
// on every line here.
//
// Every row is checked against the model it is served with (`resolveFaces`): an expression file the
// folder does not have, or a parameter the model does not have (by its `.cdi3.json`), is left out,
// so another model gets what of this fits it and nothing that breaks.

import type { RoomFigureFace } from "@miyoria/contracts/api";

/** One parameter of a face: `set` moves it toward `value`, `mul` scales it, `add` adds to it. */
export interface FaceParam {
  id: string;
  value: number;
  blend: "set" | "mul" | "add";
}

/** A face on the model: its expression files (by name, anywhere in its folder) and parameters. */
export interface FaceRow {
  /** `.exp3.json` file names, as VTube Studio's hotkeys name them. */
  expressions: readonly string[];
  /** Parameters moved toward a value (mouth form, brows, smile). */
  set?: Readonly<Record<string, number>>;
  /** Parameters scaled (the eyes' openness, after blinking). */
  mul?: Readonly<Record<string, number>>;
  /** Parameters added (the head's angle, the eyes' direction). */
  add?: Readonly<Record<string, number>>;
}

/** The pose every other face starts from (`[emotion.neutral]`): a little smile. */
const NEUTRAL: FaceRow = {
  expressions: [],
  set: {
    ParamMouthForm: 0.16,
    ParamBrowLY: 0,
    ParamBrowRY: 0,
    MouthSmile_L: 0.1,
    MouthSmile_R: 0.1,
  },
};

/** One row per face. */
export const FACE_ROWS: Readonly<Record<RoomFigureFace, FaceRow>> = {
  neutral: NEUTRAL,
  happy: {
    expressions: [],
    set: {
      ParamMouthForm: 0.84,
      EyeSmile: 0.75,
      ParamBrowLY: 0.53,
      ParamBrowRY: 0.53,
      MouthSmile_L: 0.55,
      MouthSmile_R: 0.55,
      ParamMouthOpenY: 0.12,
    },
    mul: { ParamEyeLOpen: 0.92, ParamEyeROpen: 0.92 },
    add: { AngleZ: 3, AngleY: 3 },
  },
  smug: {
    expressions: ["屑屑眼.exp3.json"],
    set: {
      ParamMouthForm: 0.56,
      EyeSmile: 0.3,
      ParamBrowLY: 0.33,
      ParamBrowRY: 0.33,
      MouthSmile_L: 0.6,
      MouthSmile_R: 0.1,
      MouthX: 0.31,
      REyeSquint: 0.2,
      LEyeSquint: 0.2,
    },
    mul: { ParamEyeLOpen: 0.72, ParamEyeROpen: 0.76 },
    add: { AngleZ: -3, AngleY: 4.5 },
  },
  annoyed: {
    expressions: ["黑脸.exp3.json"],
    set: {
      ParamMouthForm: -0.4,
      ParamBrowLY: -0.53,
      ParamBrowRY: -0.53,
      REyeSquint: 0.4,
      LEyeSquint: 0.4,
      CheeckPuff: 0.35,
      MouthPuckerWiden: -0.36,
    },
    mul: { ParamEyeLOpen: 0.8, ParamEyeROpen: 0.8 },
    add: { AngleX: 5, AngleY: -1.5 },
  },
  angry: {
    expressions: ["＞＜.exp3.json"],
    set: {
      ParamMouthForm: -0.7,
      ParamBrowLY: -0.87,
      ParamBrowRY: -0.87,
      REyeSquint: 0.3,
      LEyeSquint: 0.3,
      CheeckPuff: 0.55,
    },
    add: { AngleY: -4.5 },
  },
  embarrassed: {
    expressions: ["脸红.exp3.json"],
    set: {
      ParamMouthForm: 0.32,
      EyeSmile: 0.35,
      ParamBrowLY: 0.13,
      ParamBrowRY: 0.13,
      BrowInnerUp: 0.6,
    },
    mul: { ParamEyeLOpen: 0.86, ParamEyeROpen: 0.86 },
    add: { AngleX: -6, AngleY: -6, ParamEyeBallX: 0.42 },
  },
  sad: {
    // The tears run in the model's idle motion once the toggle shows them.
    expressions: ["流泪.exp3.json"],
    set: {
      ParamMouthForm: -0.5,
      ParamBrowLY: -0.33,
      ParamBrowRY: -0.33,
      BrowInnerUp: 0.9,
      MouthSmile_L: 0,
      MouthSmile_R: 0,
    },
    mul: { ParamEyeLOpen: 0.82, ParamEyeROpen: 0.82 },
    add: { AngleY: -7.5, AngleZ: -2, ParamEyeBallY: -0.29 },
  },
  surprised: {
    expressions: [],
    set: {
      ParamMouthForm: -0.1,
      ParamBrowLY: 1,
      ParamBrowRY: 1,
      BrowInnerUp: 0.4,
      ParamMouthOpenY: 0.3,
    },
    mul: { ParamEyeLOpen: 1.25, ParamEyeROpen: 1.25 },
    add: { AngleY: 4.5 },
  },
  thinking: {
    expressions: ["单片眼镜.exp3.json"],
    set: {
      ParamMouthForm: -0.1,
      ParamBrowLY: -0.13,
      ParamBrowRY: -0.13,
      BrowInnerUp: 0.3,
      LEyeSquint: 0.25,
      MouthX: -0.19,
    },
    mul: { ParamEyeLOpen: 0.92, ParamEyeROpen: 0.84 },
    add: { AngleZ: 5, AngleX: 4, ParamEyeBallX: -0.33, ParamEyeBallY: 0.43 },
  },
  /** Working for them (a tool runs) or reading a page: her glasses on, eyes down at the work. */
  working: {
    expressions: ["黑框眼镜.exp3.json"],
    set: { ParamMouthForm: 0, BrowInnerUp: 0.2 },
    mul: { ParamEyeLOpen: 0.9, ParamEyeROpen: 0.9 },
    add: { ParamEyeBallY: -0.3 },
  },
  /** Singing: eyes smiling, the mouth a little open (the voice's level opens it further). */
  singing: {
    expressions: [],
    set: {
      ParamMouthForm: 0.7,
      EyeSmile: 0.6,
      ParamBrowLY: 0.4,
      ParamBrowRY: 0.4,
      MouthSmile_L: 0.4,
      MouthSmile_R: 0.4,
      ParamMouthOpenY: 0.25,
    },
    mul: { ParamEyeLOpen: 0.75, ParamEyeROpen: 0.75 },
    add: { AngleZ: 4 },
  },
};

/** What moves her: the first id of each list the model has is used. */
export const RIG_CANDIDATES = {
  // This model takes its head and body from VTube Studio's inputs (`AngleX` → physics →
  // `ParamAngleX`); a model without them gets the standard parameters.
  angleX: ["AngleX", "ParamAngleX"],
  angleY: ["AngleY", "ParamAngleY"],
  angleZ: ["AngleZ", "ParamAngleZ"],
  bodyX: ["PositionX", "ParamBodyAngleX"],
  eyeX: ["ParamEyeBallX"],
  eyeY: ["ParamEyeBallY"],
  breath: ["ParamBreath"],
} as const;

/** Her mouth's openness, when the model's `LipSync` group names none. */
export const MOUTH_DEFAULT = ["ParamMouthOpenY", "JawOpen"] as const;
/** Her eyes' openness, when the model's `EyeBlink` group names none. */
export const BLINK_DEFAULT = ["ParamEyeLOpen", "ParamEyeROpen"] as const;

/**
 * Her whole figure in model units (the model's canvas is 2 high, y up): from just above her
 * ahoge to just below her soles, as the loops' frames have her, so the page frames her as the
 * loops do (measured against them at 1440 × 900).
 */
export const FIGURE_FRAMING = { top: 0.83, bottom: -0.98 } as const;

/** An `.exp3.json`'s parameters. */
export interface ExpressionFile {
  Parameters?: { Id?: unknown; Value?: unknown; Blend?: unknown }[];
}

/** An expression file's parameters as face parameters (Add, Multiply, Overwrite). */
export function expressionParams(json: ExpressionFile): FaceParam[] {
  const out: FaceParam[] = [];
  for (const p of json.Parameters ?? []) {
    if (typeof p.Id !== "string" || typeof p.Value !== "number" || !Number.isFinite(p.Value)) {
      continue;
    }
    const blend = p.Blend === "Multiply" ? "mul" : p.Blend === "Overwrite" ? "set" : "add";
    out.push({ id: p.Id, value: p.Value, blend });
  }
  return out;
}

/**
 * The faces for a model: each row's expression files read by `readExpression` (by file name;
 * `null`: the model has no such file, and the row goes on without it), then its own parameters.
 * With `params` (the model's parameter ids, from its `.cdi3.json`), anything the model does not
 * have is left out.
 */
export async function resolveFaces(
  readExpression: (name: string) => Promise<ExpressionFile | null>,
  params: ReadonlySet<string> | null,
  rows: Readonly<Record<string, FaceRow>> = FACE_ROWS,
): Promise<Record<string, FaceParam[]>> {
  const has = (id: string) => params === null || params.has(id);
  const faces: Record<string, FaceParam[]> = {};
  for (const [name, row] of Object.entries(rows)) {
    const out: FaceParam[] = [];
    for (const file of row.expressions) {
      const json = await readExpression(file);
      if (json !== null) out.push(...expressionParams(json));
    }
    for (const [blend, table] of [
      ["set", row.set],
      ["mul", row.mul],
      ["add", row.add],
    ] as const) {
      for (const [id, value] of Object.entries(table ?? {})) out.push({ id, value, blend });
    }
    faces[name] = out.filter((p) => has(p.id));
  }
  return faces;
}

/** The rig for a model with `params` (`null`: unknown, the first candidate of each). */
export function resolveRig(
  params: ReadonlySet<string> | null,
  groups: { blink: readonly string[]; mouth: readonly string[] },
) {
  const pick = (ids: readonly string[]) =>
    ids.find((id) => params === null || params.has(id)) ?? (ids[0] as string);
  const known = (ids: readonly string[]) => ids.filter((id) => params === null || params.has(id));
  return {
    angleX: pick(RIG_CANDIDATES.angleX),
    angleY: pick(RIG_CANDIDATES.angleY),
    angleZ: pick(RIG_CANDIDATES.angleZ),
    bodyX: pick(RIG_CANDIDATES.bodyX),
    eyeX: pick(RIG_CANDIDATES.eyeX),
    eyeY: pick(RIG_CANDIDATES.eyeY),
    breath: pick(RIG_CANDIDATES.breath),
    blink: known(groups.blink.length > 0 ? groups.blink : BLINK_DEFAULT),
    mouth: known(groups.mouth.length > 0 ? groups.mouth : MOUTH_DEFAULT),
  };
}
