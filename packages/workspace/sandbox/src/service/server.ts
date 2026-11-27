// The sandbox service's HTTP side (docs/design/v6-sandbox.md §3): `node:http`, a dozen routes,
// JSON or raw bytes. Every request needs the token; every body has a length and a ceiling;
// every refusal is `{ error: { code, message, ... } }` with the status of `SANDBOX_ERROR_STATUS`.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  ExecStartSchema,
  JobCreateSchema,
  ProcStartSchema,
  SANDBOX_ERROR_STATUS,
  type SandboxErrorBody,
  type SandboxInfo,
  SyncStartSchema,
  UploadCommitSchema,
} from "@miyoria/contracts/workers";
import type { z } from "zod";
import { authorized } from "./auth.js";
import { type EventRing, MAX_PAGE_BYTES, MAX_WAIT_MS } from "./events.js";
import { execLogFile, execView, startExec, stopExec } from "./execs.js";
import type { JobManager } from "./jobs.js";
import { procView, readOutput, startProc, stopProc, writeStdin } from "./procs.js";
import { finishSync, startSync, syncTar } from "./syncs.js";
import { commitUpload, MAX_PART_BYTES, parseDeleteList, putPart } from "./uploads.js";
import { ID, log, MIB, ServiceError } from "./util.js";

/** A body over its ceiling is still read and dropped up to this size before the answer. */
const DRAIN_BYTES = 64 * MIB;

/** Largest JSON body. */
export const MAX_JSON_BYTES = 8 * MIB;

export interface ServerDeps {
  jobs: JobManager;
  events: EventRing;
  accepted: readonly Buffer[];
  info(): SandboxInfo;
  health(): {
    status: "ok";
    running: number;
    busy: boolean;
    queued: number;
    ready: boolean;
    reason?: string;
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function sendError(res: ServerResponse, error: ServiceError): void {
  const body: SandboxErrorBody = {
    error: { code: error.code, message: error.message, ...error.extra },
  };
  if (error.code === "unauthorized") res.setHeader("www-authenticate", "Bearer");
  send(res, SANDBOX_ERROR_STATUS[error.code], body);
}

/** The body, which must say its length and stay under `max`. */
async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const header = req.headers["content-length"];
  if (header === undefined) {
    if (req.headers["transfer-encoding"] !== undefined) {
      throw new ServiceError("bad_request", "a body needs content-length");
    }
    return Buffer.alloc(0);
  }
  const length = Number(header);
  if (!Number.isInteger(length) || length < 0)
    throw new ServiceError("bad_request", "bad content-length");
  if (length > max) {
    // Read and dropped (up to a point), so the client sees the answer and not a reset connection.
    if (length <= DRAIN_BYTES) {
      req.resume();
      await new Promise<void>((done) => {
        req.once("end", done);
        req.once("error", done);
        req.once("close", done);
      });
    }
    throw new ServiceError("too_large", `the body is over ${max} bytes`);
  }
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const chunk of req) {
    const part = chunk as Buffer;
    seen += part.length;
    if (seen > length)
      throw new ServiceError("bad_request", "the body is longer than its content-length");
    chunks.push(part);
  }
  if (seen !== length) throw new ServiceError("bad_request", "the body ended early");
  return Buffer.concat(chunks);
}

async function readJson<S extends z.ZodType>(
  req: IncomingMessage,
  schema: S,
): Promise<z.output<S>> {
  const raw = await readBody(req, MAX_JSON_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ServiceError("bad_request", "the body is not JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
    throw new ServiceError("bad_request", issues.join("; "));
  }
  return parsed.data;
}

function id(value: string | undefined, what: string): string {
  if (value === undefined || !ID.test(value))
    throw new ServiceError("bad_request", `bad ${what} id`);
  return value;
}

/** A single `bytes=a-b` range of `size`, or `null` for the whole; throws for a range outside it. */
function rangeOf(header: string | undefined, size: number): { start: number; end: number } | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, a, b] = match as unknown as [string, string, string];
  let start: number;
  let end: number;
  if (a === "") {
    const suffix = Number(b);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (!Number.isSafeInteger(start) || start > end || start >= size) {
    throw new ServiceError("bad_request", "range not satisfiable");
  }
  return { start, end };
}

/** A file with its length, an ETag and `range` (a download that broke resumes where it was). */
async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  etag: string,
  type: string,
): Promise<void> {
  const info = await stat(file).catch(() => null);
  if (info === null || !info.isFile()) throw new ServiceError("not_found", "the file is gone");
  const size = info.size;
  let range: { start: number; end: number } | null = null;
  const ifRange = req.headers["if-range"];
  if (ifRange === undefined || ifRange === `"${etag}"`) {
    try {
      range = rangeOf(req.headers.range, size);
    } catch (error) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      res.end();
      if (error instanceof ServiceError) return;
      throw error;
    }
  }
  const headers: Record<string, string | number> = {
    "content-type": type,
    etag: `"${etag}"`,
    "accept-ranges": "bytes",
    "cache-control": "no-store",
  };
  if (range === null) {
    res.writeHead(200, { ...headers, "content-length": size });
    if (req.method === "HEAD" || size === 0) {
      res.end();
      return;
    }
    createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
    return;
  }
  res.writeHead(206, {
    ...headers,
    "content-length": range.end - range.start + 1,
    "content-range": `bytes ${range.start}-${range.end}/${size}`,
  });
  createReadStream(file, { start: range.start, end: range.end })
    .on("error", () => res.destroy())
    .pipe(res);
}

async function route(deps: ServerDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://sandbox");
  const parts = url.pathname.split("/").filter((p) => p !== "");
  const method = req.method ?? "GET";
  const q = url.searchParams;

  if (method === "GET" && url.pathname === "/health") return send(res, 200, deps.health());
  if (parts[0] !== "v1") throw new ServiceError("not_found", "no such route");
  if (method === "GET" && parts.length === 2 && parts[1] === "info")
    return send(res, 200, deps.info());
  if (method === "GET" && parts.length === 2 && parts[1] === "events") {
    return await events(deps, res, q);
  }
  if (parts[1] !== "jobs") throw new ServiceError("not_found", "no such route");
  if (parts.length === 2) {
    if (method !== "GET") throw new ServiceError("not_found", "no such route");
    return send(res, 200, { jobs: deps.jobs.all().map((j) => j.view()) });
  }
  const jobId = id(parts[2], "job");
  if (parts.length === 3) {
    if (method === "PUT") {
      const body = await readJson(req, JobCreateSchema);
      const created = await deps.jobs.create(jobId, body);
      return send(res, created.status, created.view);
    }
    if (method === "GET") {
      const job = deps.jobs.live(jobId);
      return send(res, 200, job.view());
    }
    if (method === "DELETE") return send(res, 200, await deps.jobs.close(jobId));
    throw new ServiceError("not_found", "no such route");
  }
  const what = parts[3];

  if (what === "lease" && parts.length === 4 && method === "PUT") {
    await readBody(req, MAX_JSON_BYTES);
    const job = deps.jobs.live(jobId);
    await job.persist();
    return send(res, 200, job.view());
  }

  if (what === "execs" && parts.length >= 5) {
    const execId = id(parts[4], "exec");
    if (parts.length === 5) {
      if (method === "PUT") {
        const body = await readJson(req, ExecStartSchema);
        const started = await startExec(deps.jobs.live(jobId), execId, body);
        return send(res, started.status, started.view);
      }
      // An exec's result outlives a job that ended right after it (disk, a stricter owner).
      const job = deps.jobs.get(jobId);
      if (job === null) throw new ServiceError("not_found", "no such job");
      job.touch();
      if (method === "GET") return send(res, 200, execView(job, execId));
      if (method === "DELETE") return send(res, 200, stopExec(job, execId, q.get("reason")));
    }
    if (parts.length === 6 && parts[5] === "log" && (method === "GET" || method === "HEAD")) {
      const job = deps.jobs.live(jobId);
      const file = execLogFile(job, execId);
      const view = execView(job, execId);
      const etag = `${execId}-${view.state}-${view.result?.log_bytes ?? 0}`;
      return await serveFile(req, res, file, etag, "text/plain; charset=utf-8");
    }
    throw new ServiceError("not_found", "no such route");
  }

  if (what === "uploads" && parts.length >= 5) {
    const uploadId = id(parts[4], "upload");
    if (parts.length === 7 && parts[5] === "parts" && method === "PUT") {
      const n = /^\d{1,5}$/.test(parts[6] ?? "") ? Number(parts[6]) : -1;
      const job = deps.jobs.live(jobId);
      const data = await readBody(req, MAX_PART_BYTES);
      const sha = req.headers["x-sha256"];
      const put = await putPart(
        job,
        uploadId,
        n,
        data,
        typeof sha === "string" ? sha.toLowerCase() : undefined,
      );
      return send(res, put.status, put.result);
    }
    if (parts.length === 5 && method === "PUT") {
      const deletes = parseDeleteList(
        typeof req.headers["x-delete"] === "string" ? req.headers["x-delete"] : undefined,
      );
      const body = await readJson(req, UploadCommitSchema);
      return send(res, 200, await commitUpload(deps.jobs.live(jobId), uploadId, body, deletes));
    }
    throw new ServiceError("not_found", "no such route");
  }

  if (what === "syncs" && parts.length >= 5) {
    const syncId = id(parts[4], "sync");
    if (parts.length === 5 && method === "PUT") {
      const body = await readJson(req, SyncStartSchema);
      return send(res, 200, await startSync(deps.jobs.live(jobId), syncId, body));
    }
    if (parts.length === 6 && parts[5] === "tar" && (method === "GET" || method === "HEAD")) {
      const job = deps.jobs.live(jobId);
      const tar = syncTar(job, syncId);
      return await serveFile(req, res, tar.file, tar.sha256, "application/x-tar");
    }
    if (parts.length === 5 && method === "DELETE") {
      const job = deps.jobs.get(jobId);
      if (job !== null) await finishSync(job, syncId);
      return send(res, 200, { ok: true });
    }
    throw new ServiceError("not_found", "no such route");
  }

  if (what === "procs" && parts.length >= 5) {
    const procId = id(parts[4], "proc");
    if (parts.length === 5) {
      if (method === "PUT") {
        const body = await readJson(req, ProcStartSchema);
        const started = await startProc(deps.jobs.live(jobId), procId, body);
        return send(res, started.status, started.view);
      }
      const job = deps.jobs.get(jobId);
      if (job === null) throw new ServiceError("not_found", "no such job");
      if (method === "GET") return send(res, 200, procView(job, procId));
      if (method === "DELETE") return send(res, 200, await stopProc(job, procId));
    }
    if (parts.length === 6 && parts[5] === "stdin" && method === "PUT") {
      const job = deps.jobs.live(jobId);
      const data = await readBody(req, MIB);
      return send(res, 200, await writeStdin(job, procId, Number(q.get("offset") ?? "x"), data));
    }
    if (parts.length === 6 && parts[5] === "stdout" && method === "GET") {
      const job = deps.jobs.get(jobId);
      if (job === null) throw new ServiceError("not_found", "no such job");
      job.touch();
      const stream = q.get("stream") === "stderr" ? "stderr" : "stdout";
      const out = readOutput(job, procId, stream, Number(q.get("after") ?? "0"));
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": out.data.length,
        "x-next-offset": String(out.next),
        "x-proc-state": out.view.state,
        ...(out.view.code !== null ? { "x-exit-code": String(out.view.code) } : {}),
        "cache-control": "no-store",
      });
      res.end(out.data);
      return;
    }
    throw new ServiceError("not_found", "no such route");
  }
  throw new ServiceError("not_found", "no such route");
}

/** `GET /v1/events`: at once when there are events, else after up to `wait_ms`. */
async function events(deps: ServerDeps, res: ServerResponse, q: URLSearchParams): Promise<void> {
  const after = q.get("after");
  const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Number(q.get("wait_ms") ?? 0) || 0));
  const maxBytes = Math.min(
    MAX_PAGE_BYTES,
    Math.max(1024, Number(q.get("max_bytes") ?? MAX_PAGE_BYTES) || 0),
  );
  let page = deps.events.page(after, maxBytes);
  if (page.events.length === 0 && !page.reset && waitMs > 0) {
    const gone = new AbortController();
    const onClose = () => gone.abort();
    res.once("close", onClose);
    await deps.events.wait(waitMs, gone.signal);
    res.off("close", onClose);
    if (gone.signal.aborted) return;
    page = deps.events.page(after, maxBytes);
  }
  // Core has taken these jobs' events: that renews their leases (§3.5).
  for (const job of new Set(page.events.map((e) => e.job))) deps.jobs.get(job)?.touch();
  send(res, 200, page);
}

export function createSandboxServer(deps: ServerDeps): Server {
  const server = createServer((req, res) => {
    if (!authorized(req, deps.accepted)) {
      req.resume();
      sendError(res, new ServiceError("unauthorized", "unauthorized"));
      return;
    }
    route(deps, req, res).catch((error: unknown) => {
      if (error instanceof ServiceError) {
        // A refused body is not read to its end: the connection goes with the answer.
        if (error.code === "too_large") res.setHeader("connection", "close");
        sendError(res, error);
        return;
      }
      log.error(
        { err: error instanceof Error ? error.stack : String(error), url: req.url },
        "sandbox request failed",
      );
      sendError(res, new ServiceError("internal", "internal error"));
    });
  });
  server.requestTimeout = 180_000;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
