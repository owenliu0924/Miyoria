// Messages of `miyoria hostd | up | down | restart | status | logs` (this machine's services).

export const host = {
  /** A colon and a detail after a phrase: `stopped: <reason>`. */
  suffix: (detail: string) => `: ${detail}`,
  noHostToml: (file: string) =>
    `${file} not found. Run \`miyoria host migrate\` to create it from [machine] and [stack] in miyoria.toml.`,
  logFile: (file: string) => `    Log file: ${file}`,
  /** How long a start took: `1.2 s`. */
  elapsed: (seconds: string) => `${seconds} s`,
  // ---- service events ----
  starting: (service: string) => `Starting ${service}`,
  running: "running",
  disabled: (reason: string) => `disabled: ${reason}`,
  stopped: "stopped",
  foreignDefault: "another program already answers on its port",
  externalNotStarted: (service: string) =>
    `${service} is an external program; hostd does not start it`,
  // ---- hostd ----
  alreadyRunningHere: (pid: number) =>
    `hostd is already running for this workspace (PID ${pid}); not starting another.`,
  daemonRunning: (pid: number, port: number, workspace: string) =>
    `hostd running (PID ${pid}, local API port ${port}), workspace ${workspace}`,
  startServicesFailed: (error: string) => `Failed to start services: ${error}`,
  runningNoApi: (pid: number) =>
    `hostd is already running (PID ${pid}), but its local API does not answer; no services were started.`,
  askedToStart: (pid: number, services: string) =>
    `hostd is already running (PID ${pid}); asked it to start ${services} enabled in host.toml`,
  alreadyRunning: (pid: number) => `hostd is already running (PID ${pid})`,
  startedInBackground: (pid: number, file: string) =>
    `hostd started in the background (PID ${pid}), log file ${file}`,
  cannotStart: (error: string) => `hostd could not be started: ${error}`,
  exitedEarly: (code: number) => `hostd exited after starting (exit code ${code})`,
  noAnswer: (seconds: string) => `hostd did not answer within ${seconds}`,
  didNotStart: "hostd did not start",
  // ---- up ----
  nothingToStart: (file: string) =>
    `No services to start: ${file} enables no [services.<name>] table.`,
  startingChain: (chain: string) => `Starting ${chain}`,
  handedOver: "Handed over to hostd. Run `miyoria status` to follow the progress.",
  couldNotStart: (services: string) => `${services} could not be started`,
  stillStarting: (list: string) =>
    `Still starting: ${list} (hostd continues; run \`miyoria status\` to check)`,
  servicesDidNotStart: (services: string) => `${services} did not start`,
  allReadyMark: "All services are ready",
  /** `mark`: `allReadyMark`, coloured. */
  allReady: (mark: string) => `${mark}. Run \`miyoria down\` to stop all services.`,
  alreadyInBackground: (pid: number) =>
    `hostd is already running in the background for this workspace (PID ${pid}). Use \`miyoria up\`, or run \`miyoria down\` first.`,
  foregroundStart: (chain: string) =>
    `Starting ${chain} (foreground; Ctrl+C stops everything in reverse order)`,
  stoppingServices: "Stopping services",
  // ---- down / restart ----
  notRunningNothingToStop: "hostd is not running; there are no services to stop.",
  noneStopped: (detail: string) => `No services were stopped: ${detail}`,
  daemonStopped: "hostd stopped",
  foreignNotStopped: (service: string) =>
    `${service} was not started by this hostd; it is left running.`,
  externalNotStopped: (service: string) =>
    `${service} is an external program; hostd does not stop it.`,
  servicesDidNotStop: (services: string) => `${services} did not stop`,
  restartNotRunning: (service: string) =>
    `hostd is not running. Start it with \`miyoria up ${service}\`.`,
  restarted: (service: string) => `Restarted ${service}; waiting for it to become ready...`,
  serviceDidNotStart: (service: string) => `${service} did not start`,
  // ---- status ----
  labels: { hostd: "hostd", gpu: "GPU", arbiter: "Arbiter" },
  arbiterWorker: 'decided by the singing service itself (host.toml [gpu] arbiter = "worker")',
  arbiterInactive: "hostd, not active",
  /** `leases`: how many jobs hold the GPU now. */
  arbiterActive: (policy: string | null, leases: number) =>
    `hostd${policy !== null ? ` (policy ${policy})` : ""}, ${
      leases === 0 ? "no service holds the GPU" : `${leases} ${leases === 1 ? "lease" : "leases"}`
    }`,
  /** `what`: `mode / code`; `held`: a duration; `evicted`: the services that gave the GPU up. */
  lease: (
    holder: string,
    stage: string,
    what: string | null,
    held: string,
    evicted: string | null,
  ) =>
    `${holder} in stage ${stage}${what !== null ? ` (${what})` : ""}, held for ${held}${
      evicted !== null ? `, evicted: ${evicted}` : ""
    }`,
  /** `ago`: `30 s ago`. */
  lastDecision: (stage: string, mode: string, code: string, ago: string, reason: string) =>
    `Last decision: ${stage} ${mode} / ${code}, ${ago}: ${reason}`,
  link: {
    connected: "connected",
    connecting: "connecting",
    unauthorized: "rejected (host.key is invalid or was revoked)",
    stopped: "stopped",
    none: "none (host.toml has no [cluster], or there is no host.key yet)",
  },
  /** The columns of the service table. */
  columns: {
    service: "Service",
    state: "State",
    health: "Health",
    port: "Port",
    pid: "PID",
    restarts: "Restarts",
    since: "Since",
    reason: "Reason",
  },
  noHostTomlNote: (file: string) =>
    `No ${file} (\`miyoria host migrate\` can create it from [machine] and [stack])`,
  thisMachine: (name: string) => `This machine: ${name}`,
  notRunningStartHint: "hostd is not running (`miyoria up` starts it)",
  enabledInHostToml: (list: string) => `Services enabled in host.toml: ${list}`,
  /** `uptime`: a duration; `link`: one of `link`, coloured. */
  daemonLine: (pid: number, uptime: string, link: string) =>
    `PID ${pid}  up ${uptime}  Core link: ${link}`,
  gpuUnreadable: "unavailable (neither NVML nor nvidia-smi answered)",
  /** `used`: a number; `total`, `free`, `reserve`: sizes in MB. */
  gpuLine: (name: string, used: string, total: string, free: string | null, reserve: string) =>
    `${name}  ${used} / ${total} used${free !== null ? `, ${free} free` : ""}, ${reserve} reserved`,
  noServices: "host.toml has no services",
  coreSkipped: (error: string) => `(Core not checked: ${error})`,
  coreNotAnswering: "Core's admin API is not responding",
  /** Refusals of hostd, worded here from their codes (`HOST_ERROR_CODE`). */
  rpc: {
    unknownService: (service: string) => `No service named ${service}`,
    notInstalled: (service: string) =>
      `${service} is not a service of this machine (host.toml has no [services.${service}])`,
    /** `states`: the guarded states that are active, as a list. */
    guarded: (service: string, states: string) =>
      `${service} is protected (${states}). Try again later, or add --force.`,
    guardUnknown: (service: string) =>
      `${service} is protected, and Core's current state could not be determined. Add --force to proceed anyway.`,
    singing: "singing in progress",
    live: "live stream in progress",
  },
  // ---- logs ----
  notRunningNoLog: (file: string) => `hostd is not running and ${file} does not exist.`,
  notRunningNoFollow: "hostd is not running; no new lines will follow.",
};
