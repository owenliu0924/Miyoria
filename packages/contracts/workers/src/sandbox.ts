import { z } from "zod";

// The sandbox service (`workers/sandbox`, docs/design/v6-sandbox.md): JSON bodies of `/v1/`.
// What is not JSON (upload parts, the tar of a sync, the log, proc stdin and stdout) is raw
// bytes; the paths, headers and limits are in the design document. Ids are Core's ULIDs
// (lowercase, `^[0-9a-z]{26}$`) and live in the path, not in a body.
//
// Names: the export is the design document's name (`JobCreate`), the JSON Schema id is
// `WorkersSandbox<Name>` (`WorkersSandboxJobCreate`), because ids start with the part's name.

/** The wire version `GET /v1/info` reports. */
export const SANDBOX_API_VERSION = 1;

/** Image roles; the tag itself is the machine's own (§6). */
export const SandboxImageSchema = z
  .enum(["default", "browser"])
  .meta({ id: "WorkersSandboxImage" });
export type SandboxImage = z.output<typeof SandboxImageSchema>;

/** Whom a job is for; the machine's owner decides which of these it takes (`[sandbox]`, §12.1). */
export const SandboxForSchema = z
  .enum(["self", "owner", "member", "plugin"])
  .meta({ id: "WorkersSandboxFor" });
export type SandboxFor = z.output<typeof SandboxForSchema>;

/** Why a job ended. */
export const SandboxEndReasonSchema = z
  .enum(["closed", "idle", "lifetime", "lease", "disk", "lost", "shutdown", "host_policy"])
  .meta({ id: "WorkersSandboxEndReason" });
export type SandboxEndReason = z.output<typeof SandboxEndReasonSchema>;

/** Why the sandbox (not the program) stopped an exec. */
export const SandboxKilledReasonSchema = z
  .enum(["timeout", "aborted", "output_limit", "memory", "quota", "disk", "lost"])
  .meta({ id: "WorkersSandboxKilledReason" });
export type SandboxKilledReason = z.output<typeof SandboxKilledReasonSchema>;

/** `GET /v1/info`: this machine's state, rules and room. */
export const SandboxInfoSchema = z
  .object({
    api: z.literal(1),
    service_version: z.string(),
    /** Changes with every start of the service; event cursors carry it. */
    boot: z.string(),
    /** `process.platform`. */
    platform: z.string(),
    arch: z.string(),
    docker: z.object({
      available: z.boolean(),
      server_version: z.string().nullable(),
      error: z.string().nullable(),
      cgroup: z.enum(["v2", "v1"]).nullable(),
      runtime: z.string().nullable(),
    }),
    images: z.record(
      SandboxImageSchema,
      z.object({
        tag: z.string(),
        present: z.boolean(),
        building: z.boolean(),
        /** The image from before is in use: the Dockerfile changed and the new one is not built. */
        stale: z.boolean(),
      }),
    ),
    ready: z.boolean(),
    reason: z.string().optional(),
    /** `[sandbox]` of `host.toml`, defaults applied. */
    policy: z.object({
      members: z.boolean(),
      plugins: z.boolean(),
      cpus: z.number(),
      memory_mb: z.number(),
      disk_mb: z.number(),
      max_job_cpus: z.number(),
      max_job_memory_mb: z.number(),
    }),
    /** What is reserved now (not measured). */
    load: z.object({
      jobs: z.number(),
      running: z.number(),
      queued: z.number(),
      cpus: z.number(),
      memory_mb: z.number(),
      disk_mb: z.number(),
    }),
  })
  .meta({ id: "WorkersSandboxInfo" });
export type SandboxInfo = z.output<typeof SandboxInfoSchema>;

export const SandboxLimitsSchema = z
  .object({
    /** `--cpus`. */
    cpus: z.number(),
    /** `--memory`, and `--memory-swap` with it. */
    memory_mb: z.number(),
    /** `--pids-limit`. */
    pids: z.number(),
    /** The `/tmp` tmpfs. */
    tmp_mb: z.number(),
    /** `--ulimit fsize`. */
    file_mb: z.number(),
    nofile: z.number(),
    /** `/work` + `/workspace` + `/home` together; measured every 5 s, over it stops the exec and ends the job (`disk`). */
    disk_mb: z.number(),
  })
  .meta({ id: "WorkersSandboxLimits" });
export type SandboxLimits = z.output<typeof SandboxLimitsSchema>;

export const SandboxNetworkSchema = z
  .object({
    mode: z.enum(["open", "allowlist", "none"]),
    /** Read in `allowlist`: host names or `*.example.com`. */
    allow: z.array(z.string()),
    /** Ports refused in `open` as well. */
    deny_ports: z.array(z.number().int()),
    /** Connections open at once. */
    max_connections: z.number(),
    /** In and out together, MiB. */
    max_mb: z.number(),
  })
  .meta({ id: "WorkersSandboxNetwork" });
export type SandboxNetwork = z.output<typeof SandboxNetworkSchema>;

/** `PUT /v1/jobs/{job}` body. */
export const JobCreateSchema = z
  .object({
    kind: z.enum(["run", "session", "browser", "plugin"]),
    image: SandboxImageSchema,
    for: SandboxForSchema,
    /**
     * Who pays, as `HMAC-SHA256(Core's own key, person key)`, the first 16 hex characters. The
     * machine only counts jobs per payer and logs it; it cannot tell who it is. Her own jobs:
     * `null`.
     */
    payer: z.string().nullable(),
    limits: SandboxLimitsSchema,
    network: SandboxNetworkSchema,
    /** Seconds; 0: no limit (a plugin). */
    lifetime_s: z.number(),
    idle_s: z.number(),
    /** The job is closed when nothing touched it for this long (lease). */
    lease_s: z.number(),
    mounts: z.object({ tools: z.boolean(), ext: z.boolean() }),
    /** Names `^[A-Z][A-Z0-9_]{0,63}$`, values up to 4 KiB, at most 32; Core's own environment is never sent. */
    env: z.record(z.string(), z.string()),
    /** For people to read (a session's name, a plugin's id); changes nothing. */
    label: z.string().nullable(),
  })
  .meta({ id: "WorkersSandboxJobCreate" });
export type JobCreate = z.output<typeof JobCreateSchema>;

export const JobUsageSchema = z
  .object({
    /** CPU the container's cgroup used, milliseconds. */
    cpu_ms: z.number(),
    /** `cgroup`: its running total; `sampled`: summed `docker stats` samples (less exact). */
    cpu_source: z.enum(["cgroup", "sampled"]),
    wall_ms: z.number(),
    disk_bytes: z.number(),
    egress: z.object({
      bytes_in: z.number(),
      bytes_out: z.number(),
      connections: z.number(),
      refused: z.object({ address: z.number(), port: z.number(), cap: z.number() }),
    }),
  })
  .meta({ id: "WorkersSandboxJobUsage" });
export type JobUsage = z.output<typeof JobUsageSchema>;

export const JobViewSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["run", "session", "browser", "plugin"]),
    state: z.enum(["starting", "ready", "busy", "ended"]),
    ended: z.object({ reason: SandboxEndReasonSchema, at: z.number() }).nullable(),
    image_tag: z.string(),
    /** What was applied (the machine may have lowered them). */
    limits: SandboxLimitsSchema,
    created_at: z.number(),
    last_used_at: z.number(),
    /** The earliest of idle, lifetime and lease. */
    expires_at: z.number(),
    usage: JobUsageSchema,
    /** The exec running now. */
    exec: z.string().nullable(),
    procs: z.array(z.string()),
  })
  .meta({ id: "WorkersSandboxJobView" });
export type JobView = z.output<typeof JobViewSchema>;

/** `GET /v1/jobs`: every job on this machine (Core reconciles with it after a restart). */
export const JobListSchema = z
  .object({ jobs: z.array(JobViewSchema) })
  .meta({ id: "WorkersSandboxJobList" });
export type JobList = z.output<typeof JobListSchema>;

/** `PUT .../parts/{n}` result. */
export const UploadPartResultSchema = z
  .object({ n: z.number().int(), bytes: z.number(), sha256: z.string() })
  .meta({ id: "WorkersSandboxUploadPartResult" });
export type UploadPartResult = z.output<typeof UploadPartResultSchema>;

/** One file of a manifest: what Core (or the machine) has at that path now. */
export const ManifestEntrySchema = z
  .object({ path: z.string(), size: z.number(), sha256: z.string(), mtime_ms: z.number() })
  .meta({ id: "WorkersSandboxManifestEntry" });
export type ManifestEntry = z.output<typeof ManifestEntrySchema>;

/** `PUT .../uploads/{upload}` body: the parts are in, check and unpack. */
export const UploadCommitSchema = z
  .object({
    parts: z.number().int(),
    bytes: z.number(),
    /** SHA-256 of all parts joined. */
    sha256: z.string(),
    format: z.enum(["tar", "tar.gz"]),
    /** Where to unpack. */
    target: z.enum(["workspace", "tools", "ext", "work"]),
    /** Empty `target` first. The first workspace upload of a job has it. */
    replace: z.boolean(),
    /** The tar's list; once unpacked the machine uses it as "what Core has now". */
    manifest: z.array(ManifestEntrySchema),
  })
  .meta({ id: "WorkersSandboxUploadCommit" });
export type UploadCommit = z.output<typeof UploadCommitSchema>;

export const UploadResultSchema = z
  .object({
    files: z.number(),
    bytes: z.number(),
    /** What was not taken, and why (links, devices, bad paths, too large). */
    skipped: z.array(z.object({ path: z.string(), why: z.string() })),
  })
  .meta({ id: "WorkersSandboxUploadResult" });
export type UploadResult = z.output<typeof UploadResultSchema>;

export const FileInSchema = z
  .object({
    path: z.string(),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).optional(),
  })
  .meta({ id: "WorkersSandboxFileIn" });
export type FileIn = z.output<typeof FileInSchema>;

/** `PUT .../execs/{exec}` body. */
export const ExecStartSchema = z
  .object({
    /** One of these two: a program (written to `/code/<exec>.<ext>`) or an argument list. */
    program: z
      .object({
        language: z.enum(["python", "node", "shell"]),
        code: z.string(),
      })
      .optional(),
    argv: z.array(z.string()).optional(),
    /** At most 1 MiB. */
    stdin: z.string().optional(),
    /** Written into `/work` first, 4 MiB in all. */
    files: z.array(FileInSchema).optional(),
    /** Default `/workspace`. */
    cwd: z.enum(["/work", "/workspace"]).optional(),
    timeout_ms: z.number(),
    /** Same rules as `JobCreate.env`. */
    env: z.record(z.string(), z.string()).optional(),
    output: z.object({
      /** What of stdout and of stderr each stays in the result. */
      keep_bytes: z.number(),
      /** Over this in all, the exec is stopped (`output_limit`). */
      kill_bytes: z.number(),
      /** Most that events carry; after it only `cpu` and `exit`. The whole output is in the log. */
      stream_bytes: z.number(),
    }),
    /** At the end bring back what is new or changed in `/work` (today's `files_out`). */
    collect: z.object({ max_files: z.number(), max_bytes: z.number() }).nullable().default(null),
  })
  .meta({ id: "WorkersSandboxExecStart" });
export type ExecStart = z.output<typeof ExecStartSchema>;
export type ExecStartIn = z.input<typeof ExecStartSchema>;

export const FileOutSchema = z
  .object({
    path: z.string(),
    size: z.number(),
    encoding: z.enum(["utf8", "base64"]),
    content: z.string(),
  })
  .meta({ id: "WorkersSandboxFileOut" });
export type FileOut = z.output<typeof FileOutSchema>;

export const ExecResultSchema = z
  .object({
    exit_code: z.number().nullable(),
    killed_reason: SandboxKilledReasonSchema.nullable(),
    duration_ms: z.number(),
    /** CPU the container used during this exec (the cgroup's difference between start and end). */
    cpu_ms: z.number(),
    stdout: z.string(),
    stderr: z.string(),
    stdout_truncated: z.boolean(),
    stderr_truncated: z.boolean(),
    stdout_bytes: z.number(),
    stderr_bytes: z.number(),
    files_out: z.array(FileOutSchema),
    files_out_truncated: z.boolean(),
    /** Length of the log; the whole output is a `range` read away. */
    log_bytes: z.number(),
  })
  .meta({ id: "WorkersSandboxExecResult" });
export type ExecResult = z.output<typeof ExecResultSchema>;

export const ExecViewSchema = z
  .object({
    id: z.string(),
    state: z.enum(["running", "done", "lost"]),
    started_at: z.number(),
    result: ExecResultSchema.nullable(),
  })
  .meta({ id: "WorkersSandboxExecView" });
export type ExecView = z.output<typeof ExecViewSchema>;

/** `PUT .../syncs/{sync}` body. */
export const SyncStartSchema = z
  .object({
    /** Only the workspace goes back to Core. */
    target: z.literal("workspace"),
  })
  .meta({ id: "WorkersSandboxSyncStart" });
export type SyncStart = z.output<typeof SyncStartSchema>;

export const SyncResultSchema = z
  .object({
    /** New or changed since the last sync (or the uploaded manifest). */
    changed: z.array(ManifestEntrySchema),
    deleted: z.array(z.string()),
    skipped: z.array(z.object({ path: z.string(), why: z.string() })),
    /** Without `changed` there is no tar. */
    tar: z.object({ bytes: z.number(), sha256: z.string() }).nullable(),
  })
  .meta({ id: "WorkersSandboxSyncResult" });
export type SyncResult = z.output<typeof SyncResultSchema>;

/** `PUT .../procs/{proc}` body. */
export const ProcStartSchema = z
  .object({
    argv: z.array(z.string()),
    cwd: z.enum(["/work", "/workspace", "/ext"]).optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .meta({ id: "WorkersSandboxProcStart" });
export type ProcStart = z.output<typeof ProcStartSchema>;

/** One event of `GET /v1/events`, for every job on the machine. `seq` rises by one. */
export const SandboxEventSchema = z
  .discriminatedUnion("kind", [
    z.object({
      seq: z.number(),
      job: z.string(),
      kind: z.literal("state"),
      state: z.enum(["starting", "ready", "busy", "ended"]),
    }),
    /** The job's total CPU, every 10 s. */
    z.object({ seq: z.number(), job: z.string(), kind: z.literal("cpu"), cpu_ms: z.number() }),
    z.object({
      seq: z.number(),
      job: z.string(),
      exec: z.string(),
      kind: z.enum(["stdout", "stderr"]),
      text: z.string(),
    }),
    z.object({
      seq: z.number(),
      job: z.string(),
      exec: z.string(),
      kind: z.literal("exit"),
      result: ExecResultSchema,
    }),
    z.object({
      seq: z.number(),
      job: z.string(),
      proc: z.string(),
      kind: z.literal("proc_out"),
      stream: z.enum(["stdout", "stderr"]),
      /** Where this stream is, counted from its start, in bytes. */
      offset: z.number(),
      data_b64: z.string(),
    }),
    z.object({
      seq: z.number(),
      job: z.string(),
      proc: z.string(),
      kind: z.literal("proc_exit"),
      code: z.number().nullable(),
      signal: z.string().nullable(),
    }),
    z.object({
      seq: z.number(),
      job: z.string(),
      kind: z.literal("ended"),
      reason: SandboxEndReasonSchema,
      usage: JobUsageSchema,
    }),
  ])
  .meta({ id: "WorkersSandboxEvent" });
export type SandboxEvent = z.output<typeof SandboxEventSchema>;

/** `GET /v1/events` result. */
export const EventsPageSchema = z
  .object({
    /** The next `after`: `<boot>:<seq>`. */
    cursor: z.string(),
    events: z.array(SandboxEventSchema),
    /**
     * The cursor is from another start, or Core stayed away so long the events are gone: Core
     * reconciles with `GET /v1/jobs`, and fills a proc's output with `GET .../stdout?after=`.
     */
    reset: z.boolean(),
  })
  .meta({ id: "WorkersSandboxEventsPage" });
export type EventsPage = z.output<typeof EventsPageSchema>;

export const SandboxErrorCodeSchema = z
  .enum([
    "bad_request",
    "unauthorized",
    "not_accepting",
    "not_found",
    "conflict",
    "gone",
    "too_large",
    "limit",
    "busy",
    "docker_failed",
    "unavailable",
    "internal",
  ])
  .meta({ id: "WorkersSandboxErrorCode" });
export type SandboxErrorCode = z.output<typeof SandboxErrorCodeSchema>;

/** Every 4xx and 5xx of `/v1/`. */
export const SandboxErrorBodySchema = z
  .object({
    error: z.object({
      code: SandboxErrorCodeSchema,
      message: z.string(),
      retry_after_ms: z.number().optional(),
      ended: z.object({ reason: SandboxEndReasonSchema, at: z.number() }).optional(),
      reason: z.string().optional(),
    }),
  })
  .meta({ id: "WorkersSandboxErrorBody" });
export type SandboxErrorBody = z.output<typeof SandboxErrorBodySchema>;

/** The HTTP status of each error code. */
export const SANDBOX_ERROR_STATUS: Readonly<Record<SandboxErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  not_accepting: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  too_large: 413,
  limit: 422,
  busy: 429,
  docker_failed: 502,
  unavailable: 503,
  internal: 500,
};
