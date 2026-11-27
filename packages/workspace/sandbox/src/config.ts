import { z } from "zod";
import { BrowseConfigSchema } from "./browse/config.js";

/**
 * An image reference the Docker CLI can never mistake for a flag: starts with a letter or digit,
 * then the characters of `name[:tag][@sha256:digest]`.
 */
export const IMAGE_REF = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/;

const image = z.string().regex(IMAGE_REF, "not a Docker image reference");

/** Image per language. Pin a digest (`python:3.12-slim@sha256:...`) for reproducible runs. */
export const SandboxImagesSchema = z.object({
  python: image.default("python:3.12-slim"),
  node: image.default("node:24-slim"),
});

/**
 * Resource limits of one container. The defaults fit `pip install` and real data work (a job is
 * a whole Linux machine now); they were 256 MiB, 1 CPU, 128 processes, a 64 MiB `/tmp`, 16 MiB
 * files and 256 open files.
 */
export const SandboxLimitsSchema = z.object({
  /** `--memory` (and `--memory-swap`, so no swap), in MiB. */
  memory_mb: z.number().int().min(16).default(2048),
  /** `--cpus`. */
  cpus: z.number().positive().default(2),
  /** `--pids-limit`: processes and threads inside the container. */
  pids_limit: z.number().int().min(8).default(512),
  /** Size of the `/tmp` tmpfs, in MiB. */
  tmpfs_mb: z.number().int().min(1).default(512),
  /** `--ulimit fsize`: largest file a process may write, in bytes. */
  max_file_size_bytes: z
    .number()
    .int()
    .min(1024)
    .default(256 * 1024 * 1024),
  /** `--ulimit nofile`: open files per process. */
  nofile: z.number().int().min(16).default(4096),
});
export type SandboxLimits = z.output<typeof SandboxLimitsSchema>;

/** Size caps of what goes in and comes out of a run. */
export const SandboxCapsSchema = z.object({
  /** Longest program, in bytes (UTF-8). */
  max_code_bytes: z
    .number()
    .int()
    .min(1)
    .default(256 * 1024),
  /** Longest stdin, in bytes. */
  max_stdin_bytes: z
    .number()
    .int()
    .min(0)
    .default(1024 * 1024),
  /** Input files per run. */
  max_files_in: z.number().int().min(0).default(32),
  /** All input files together, in bytes. */
  max_files_in_bytes: z
    .number()
    .int()
    .min(0)
    .default(4 * 1024 * 1024),
  /** stdout and stderr kept, each, in bytes; the rest is dropped and marked truncated. */
  max_output_bytes: z
    .number()
    .int()
    .min(256)
    .default(64 * 1024),
  /**
   * The container is killed (`output_limit`) once stdout + stderr pass this many bytes, so a
   * print loop cannot keep the CPU and the pipe busy until the timeout.
   */
  kill_output_bytes: z
    .number()
    .int()
    .min(256)
    .default(8 * 1024 * 1024),
  /** Output files returned per run. */
  max_files_out: z.number().int().min(0).default(32),
  /** All returned output files together, in bytes. */
  max_files_out_bytes: z
    .number()
    .int()
    .min(0)
    .default(1024 * 1024),
});
export type SandboxCaps = z.output<typeof SandboxCapsSchema>;

/** Her named sessions: long-lived containers whose `/work` carries over between runs. */
export const SandboxSessionsSchema = z.object({
  /**
   * Sessions open at once, everyone's together (per profile). 0 = no sessions. It was 3 while
   * only she had sessions.
   */
  max: z.number().int().min(0).default(8),
  /** Sessions one person (or she herself) has open at once; cluster backend only. */
  per_person: z.number().int().min(0).default(2),
  /** A session closes after this many minutes without a run. */
  idle_minutes: z.number().positive().default(15),
  /** A session closes this many minutes after it started, however busy. */
  lifetime_minutes: z.number().positive().default(120),
  /**
   * Largest `/work` of a session, in MiB; a run that leaves more closes the session. On the
   * cluster backend it is the job's disk limit (`/work`, `/workspace` and `/home` together).
   */
  disk_mb: z.number().int().min(1).default(2048),
});

/**
 * `[modules.sandbox.files]`: files people send her. The bytes are downloaded by Core (bounded,
 * allowlisted hosts) and only ever opened by the extractor inside a container.
 */
export const SandboxFilesSchema = z.object({
  enabled: z.boolean().default(true),
  /** Larger files are declined, from the size the platform reports and again while downloading. */
  max_bytes: z.number().int().min(1).default(2_500_000),
  /** Characters of extracted text she gets (the rest is cut and marked as cut). */
  max_chars: z.number().int().min(200).default(6000),
  /** Wall-clock limit of the extractor run, in milliseconds. */
  timeout_ms: z.number().int().min(1000).default(20_000),
  /** Time limit for downloading one file, in milliseconds. */
  download_timeout_ms: z.number().int().min(500).default(8000),
  /** Files are only downloaded from these hosts (the platform's CDN), over HTTPS. */
  allowed_hosts: z.array(z.string()).default(["cdn.discordapp.com", "media.discordapp.net"]),
  /** Files one person may have her read per `window_s` seconds. */
  per_person: z.number().int().min(0).default(4),
  /** Files everyone together may have her read per `window_s` seconds. */
  global: z.number().int().min(0).default(12),
  window_s: z.number().int().min(1).default(600),
  /** Extracted results kept in memory, by attachment id (a cached read costs no limit). */
  cache_entries: z.number().int().min(0).default(16),
});
export type SandboxFiles = z.output<typeof SandboxFilesSchema>;

/**
 * `[modules.sandbox.workspace]`: her own directory, kept between runs and sessions
 * (`<root>/profiles/<profile>/workspace`, mounted read-write at `/workspace` on request). Work
 * done for someone stays in their folder `people/<id>/` (see `people.ts`), with its own caps;
 * she and the owners see the whole of it. The quotas hold for what is written through the tools;
 * what a program leaves there is checked right after the run and what is over a quota is removed
 * (see `PersistentWorkspace.enforce`).
 */
export const SandboxWorkspaceSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * All files together, everyone's folders included, in MiB: an upper bound on Core's disk, not
   * a reservation. Most folders stay far below the per-person cap.
   */
  max_mb: z.number().int().min(1).default(32_768),
  /** Files at most, everyone's folders included (the default: 100 people at 2000 each). */
  max_files: z.number().int().min(1).default(200_000),
  /** One file at most, in KiB (it was 8192). */
  max_file_kb: z.number().int().min(1).default(262_144),
  /** One person's folder at most, in MiB (it was 256). */
  person_max_mb: z.number().int().min(1).default(1024),
  /** Files in one person's folder at most. */
  person_max_files: z.number().int().min(1).default(2000),
  /** The largest file `workspace_export` takes out (to hand over with `share`), in KiB (it was 8192). */
  export_max_kb: z.number().int().min(1).default(262_144),
  /**
   * Characters of a file `workspace_read` returns at once (the rest is read with `offset`).
   */
  read_chars: z.number().int().min(200).default(3900),
  /** Output files (`outputs/<run id>.txt`, full output of runs whose result was cut) kept. */
  keep_outputs: z.number().int().min(0).default(20),
});

/** A host name or `*.suffix`: no scheme, port, path or bare wildcard. */
export const ALLOWED_HOST =
  /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * `[modules.sandbox.network]`: what a run may reach.
 *
 * On the cluster backend each job gets its own egress proxy (docs/design/v6-sandbox.md §5):
 * `mode = "open"` (the default) lets everything through but private, link-local, tailnet and
 * cloud metadata addresses and the mail ports (`deny_ports`); `allowlist` only the hosts in
 * `allow` on 80 and 443; `none` no network. An old file that lists hosts in `allow` and has no
 * `mode` is read as `allowlist` (see `networkMode`).
 *
 * The local backend keeps its own rule: closed unless `allow` lists hosts; then a run that asks
 * gets a Docker network without a route out and an egress proxy (a container of the node image)
 * as its only way out, which lets through only these hosts on ports 80 and 443 and never to a
 * private address.
 */
export const SandboxNetworkSchema = z.object({
  /** Cluster backend; not given: `open`, or `allowlist` when `allow` lists hosts. */
  mode: z.enum(["open", "allowlist", "none"]).optional(),
  allow: z
    .array(z.string().toLowerCase().regex(ALLOWED_HOST, "a host name or `*.example.com`"))
    .max(32)
    .default([]),
  /** Port the proxy listens on, inside its container. */
  proxy_port: z.number().int().min(1024).max(65535).default(3128),
  /** Memory of the proxy container, in MiB. */
  proxy_memory_mb: z.number().int().min(32).default(128),
  /** Ports refused in `open` mode as well (mail: a job must not send spam from a friend's IP). */
  deny_ports: z.array(z.number().int().min(1).max(65535)).max(64).default([25, 465, 587]),
  /** Connections one job has open at once (cluster backend). */
  max_connections: z.number().int().min(1).default(64),
  /** What one job sends and receives in all, in MiB (cluster backend). */
  max_mb: z.number().int().min(1).default(4096),
});
export type SandboxNetwork = z.output<typeof SandboxNetworkSchema>;

/** The network mode a job of the cluster backend gets (an old allowlist-only file: `allowlist`). */
export function networkMode(network: SandboxNetwork): "open" | "allowlist" | "none" {
  return network.mode ?? (network.allow.length > 0 ? "allowlist" : "open");
}

/**
 * `[modules.sandbox.transfer]`: the folder that travels to a computer of the cluster with a job,
 * and how long that computer keeps a job Core stopped asking about.
 */
export const SandboxTransferSchema = z.object({
  /** Largest folder sent into one job, in MiB. */
  max_mb: z.number().int().min(1).default(1024),
  /** One upload part, in MiB: each has its own length and can be sent again on its own. */
  part_mb: z.number().int().min(1).max(64).default(8),
  /**
   * A job is closed on its computer when Core did not touch it for this long. Long enough for a
   * restart of Core (signing in and loading models takes a minute or two).
   */
  lease_secs: z.number().int().min(30).default(600),
  /**
   * The computers (host names) a plugin with secrets may run on; empty: only Core's own one
   * (docs/design/v6-sandbox.md §16 question 3).
   */
  trusted_hosts: z.array(z.string().min(1).max(253)).max(64).default([]),
  /**
   * The computers (host names) members' work may go to, with their folders, and that receive
   * the `people/` tree on an owner's run over the whole workspace; Core's own machine always may.
   * A computer must be listed here AND have its owner take members' work (`[sandbox] members`
   * in its host.toml): that report is the computer's own word, and a hostile one would say yes.
   */
  member_hosts: z.array(z.string().min(1).max(253)).max(64).default([]),
});
export type SandboxTransfer = z.output<typeof SandboxTransferSchema>;

/**
 * `[modules.sandbox]` config section. The module is opt-in: it only runs with
 * `enabled = true` (see the core's `OPT_IN_MODULES`).
 *
 * ```toml
 * [modules.sandbox]
 * enabled = true
 * root = "data/sandbox"
 * ```
 */
export const SandboxConfigSchema = z.object({
  /**
   * Where runs go: `auto` (the default) uses the `sandbox` service of a computer of the cluster
   * when one is ready, and Docker on this machine otherwise, as before; `cluster` only the
   * cluster; `local` only this machine's Docker (no shell, the network of `network.allow`).
   * `images`, `pool_size`, `user` and `docker` only matter to the local backend.
   */
  backend: z.enum(["auto", "cluster", "local"]).default("auto"),
  /**
   * Directory for per-run workspaces (`runs/<run id>`), the per-profile tools workspace
   * (`profiles/<profile>/tools`) and session workspaces (`profiles/<profile>/sessions`). Relative paths resolve against the directory of
   * `miyoria.toml`.
   */
  root: z.string().min(1).default("data/sandbox"),
  /** Docker CLI executable (run directly, never through a shell). */
  docker: z.string().min(1).default("docker"),
  images: SandboxImagesSchema.prefault({}),
  /**
   * `--user` of the container. `"auto"` = the host uid:gid on Linux / macOS when that is not
   * root (so the host can clean up files the container wrote), `65534:65534` (nobody)
   * otherwise. Never `root` / `0`.
   */
  user: z
    .string()
    .regex(/^(auto|[1-9][0-9]{0,9}(:[1-9][0-9]{0,9})?)$/, "`auto` or a non-root uid[:gid]")
    .default("auto"),
  /** Timeout of a run that does not ask for one, in milliseconds (it was 30000). */
  default_timeout_ms: z.number().int().min(100).default(300_000),
  /** Longest timeout a run may ask for, in milliseconds: ten minutes (it was 120000). */
  max_timeout_ms: z.number().int().min(100).default(600_000),
  /** Runs at the same time. */
  max_concurrent: z.number().int().min(1).default(2),
  /** Runs waiting for a slot; more are refused (`busy`). */
  max_queued: z.number().int().min(0).default(8),
  /** Finished run workspaces kept on disk (their output files), newest first. 0 = none. */
  keep_runs: z.number().int().min(0).default(20),
  /** Longest image pull, in milliseconds (pulls happen before a run's clock starts). */
  pull_timeout_ms: z.number().int().min(1000).default(600_000),
  /** How long a `docker version` result is trusted, in milliseconds. */
  health_ttl_ms: z.number().int().min(0).default(30_000),
  limits: SandboxLimitsSchema.prefault({}),
  caps: SandboxCapsSchema.prefault({}),
  sessions: SandboxSessionsSchema.prefault({}),
  files: SandboxFilesSchema.prefault({}),
  workspace: SandboxWorkspaceSchema.prefault({}),
  network: SandboxNetworkSchema.prefault({}),
  transfer: SandboxTransferSchema.prefault({}),
  /** The browser on a computer of the cluster (`[modules.sandbox.browser]`, the browse_* tools). */
  browser: BrowseConfigSchema.prefault({}),
  /**
   * Started, idle containers kept ready per language image, so a fresh run skips the container
   * start. Each serves exactly one run, then it is destroyed and replaced. Default 0 (off):
   * no idle containers unless it is turned on.
   */
  pool_size: z.number().int().min(0).max(8).default(0),
  /** Scripts kept in the tools workspace per profile. */
  max_scripts: z.number().int().min(0).default(100),
  /** Proposed tools kept per profile (pending, approved and rejected). */
  max_proposed_tools: z.number().int().min(0).default(50),
  /**
   * Characters of a run's output (stdout + stderr, framed as untrusted data) she gets back from
   * `code.run` and her own tools.
   */
  result_chars: z.number().int().min(200).default(3900),
  /**
   * Timeout of one call of an approved tool she wrote, in milliseconds.
   */
  tool_timeout_ms: z.number().int().min(100).default(8000),
  /** How often Docker is re-checked to offer or withdraw the capabilities, in milliseconds. */
  recheck_ms: z.number().int().min(1000).default(60_000),
});
export type SandboxConfig = z.output<typeof SandboxConfigSchema>;

/** Defaults of every field. */
export function defaultSandboxConfig(): SandboxConfig {
  return SandboxConfigSchema.parse({});
}
