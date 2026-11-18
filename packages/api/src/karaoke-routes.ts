// Karaoke's routes (docs/design/karaoke.md 「做了什麼(第一步)」), over `KaraokeKey`:
//
// * Member (`karaoke` group, a session, limited per account): `GET /api/member/karaoke`,
//   `POST /api/member/karaoke/songs` `{ text }`, `GET /api/member/karaoke/songs/{id}`,
//   `POST /api/member/karaoke/songs/{id}/sessions`, `POST /api/member/karaoke/sessions/{id}/result`,
//   `GET /api/member/karaoke/sessions/{id}`. The person is the session's; a refusal is its status
//   and sentence.
// * The files of a session (`GET /api/member/karaoke/files/:session/:name?exp=&sig=`): a plain
//   member route, since it is not JSON. It needs the member's session cookie as well as the
//   link's signature, which is bound to the session, the file, the account and a time ten minutes
//   on. Anything wrong is the same 404. The answer is `no-store` (every member answer is) and has
//   no `content-disposition`: the page plays it, it does not offer it as a download. One byte range
//   (`Range: bytes=a-b`) is answered with 206, so the background video can be read as it plays.
// * The recording of a session (`POST /api/member/karaoke/sessions/:id/voice?offset_ms=`, step 3):
//   the raw recording as the body (`audio/webm`, `audio/ogg`, `audio/mp4`), at most
//   `KARAOKE_VOICE_MAX_BYTES`, read with that cap and kept only in memory; one per session, after
//   its result. `202 {state}`: a song worker reads it and Core scores it in the background.
// * Admin (`karaokeAdmin`): `GET /api/karaoke/results`, the latest results with their flags.
//
// Without the `karaoke` module every route is a `503` that names it.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { KARAOKE_VOICE_MAX_BYTES } from "@miyoria/contracts/workers";
import { KaraokeError, KaraokeKey, type KaraokeService } from "@miyoria/play/karaoke";
import type { AccountRef } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { json, param, type Route } from "./route.js";
import type { SessionRecord } from "./session.js";
import type { ApiContext, ApiState } from "./state.js";

function service(state: ApiState): KaraokeService {
  return state.service(KaraokeKey, "karaoke module");
}

function memberOf(c: ApiContext): SessionRecord {
  return c.get("member") as SessionRecord;
}

function accountOf(c: ApiContext): AccountRef {
  return memberOf(c).account;
}

/** Runs `fn`, a refusal of the service as its status and sentence. */
async function refusals<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof KaraokeError) throw new ApiError(error.status, error.message);
    throw error;
  }
}

export const karaokeRpc = {
  overview: os.karaoke.overview.handler(({ context: { state, c } }) =>
    refusals(() => service(state).overview(accountOf(c))),
  ),
  request: os.karaoke.request.handler(({ input, context: { state, c } }) =>
    refusals(() => service(state).request(accountOf(c), input.body.text)),
  ),
  song: os.karaoke.song.handler(({ input, context: { state, c } }) =>
    refusals(() => service(state).song(accountOf(c), input.params.id)),
  ),
  start: os.karaoke.start.handler(({ input, context: { state, c } }) =>
    refusals(() =>
      service(state).start(accountOf(c), memberOf(c).name, input.params.id, input.body?.shift ?? 0),
    ),
  ),
  submit: os.karaoke.submit.handler(({ input, context: { state, c } }) =>
    refusals(() => service(state).submit(accountOf(c), input.params.id, input.body)),
  ),
  result: os.karaoke.result.handler(({ input, context: { state, c } }) =>
    refusals(() => service(state).result(accountOf(c), input.params.id)),
  ),
};

export const karaokeAdminRpc = {
  results: os.karaokeAdmin.results.handler(({ context: { state } }) =>
    service(state).adminResults(),
  ),
};

/** `GET /api/member/karaoke/files/:session/:name`. */
async function file(state: ApiState, c: ApiContext): Promise<Response> {
  const found = await service(state).file(
    accountOf(c),
    param(c, "session"),
    param(c, "name"),
    c.req.query("exp"),
    c.req.query("sig"),
  );
  if (found === null) throw ApiError.notFound("no such file");
  const size = (await stat(found.path)).size;
  const headers: Record<string, string> = {
    "content-type": found.type,
    "accept-ranges": "bytes",
    "cross-origin-resource-policy": "same-origin",
  };
  const range = byteRange(c.req.header("range"), size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${size}` },
    });
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const body =
    size === 0
      ? null
      : (Readable.toWeb(createReadStream(found.path, { start, end })) as ReadableStream);
  return new Response(body, {
    status: range === null ? 200 : 206,
    headers: {
      ...headers,
      "content-length": String(size === 0 ? 0 : end - start + 1),
      ...(range === null ? {} : { "content-range": `bytes ${start}-${end}/${size}` }),
    },
  });
}

/**
 * One byte range of a `Range` header over `size` bytes: `null` for none (or one this does not
 * serve, like several ranges: the whole file then), `"unsatisfiable"` for one past the end.
 * (`range-parser` does this too, but is not a dependency of this package.)
 */
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return null;
  const [, from = "", to = ""] = m;
  if (from === "" && to === "") return null;
  let start: number;
  let end: number;
  if (from === "") {
    // The last `to` bytes.
    const n = Number(to);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/** The request's body, up to `max` bytes; `null` when it is longer. */
async function bodyUpTo(c: ApiContext, max: number): Promise<Uint8Array | null> {
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  const stream = c.req.raw.body;
  if (stream === null) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  chunks.length = 0;
  return out;
}

/** `POST /api/member/karaoke/sessions/:id/voice?offset_ms=`. */
async function voice(state: ApiState, c: ApiContext): Promise<Response> {
  const karaoke = service(state);
  const offset = Number(c.req.query("offset_ms") ?? "0");
  const bytes = await bodyUpTo(c, KARAOKE_VOICE_MAX_BYTES);
  if (bytes === null) throw new ApiError(413, "錄音太大了");
  const accepted = await refusals(() =>
    karaoke.voice(
      accountOf(c),
      param(c, "id"),
      bytes,
      c.req.header("content-type") ?? "",
      Number.isFinite(offset) ? Math.round(offset) : Number.NaN,
    ),
  );
  return json(accepted, 202);
}

/** The member route of karaoke that is not on the route table. None when the public side is off. */
export function karaokeRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  return [
    {
      method: "GET",
      path: "/api/member/karaoke/files/:session/:name",
      member: true,
      handler: (c) => file(state, c),
    },
    {
      method: "POST",
      path: "/api/member/karaoke/sessions/:id/voice",
      member: true,
      handler: (c) => voice(state, c),
    },
  ];
}
