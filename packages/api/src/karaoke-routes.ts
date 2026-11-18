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
//   no `content-disposition`: the page plays it, it does not offer it as a download.
// * Admin (`karaokeAdmin`): `GET /api/karaoke/results`, the latest results with their flags.
//
// Without the `karaoke` module every route is a `503` that names it.

import { readFile } from "node:fs/promises";
import { KaraokeError, KaraokeKey, type KaraokeService } from "@miyoria/play/karaoke";
import type { AccountRef } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { param, type Route } from "./route.js";
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
  const body = await readFile(found.path);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": found.type,
      "content-length": String(body.byteLength),
      "cross-origin-resource-policy": "same-origin",
    },
  });
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
  ];
}
