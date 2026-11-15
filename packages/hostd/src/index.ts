// The per-machine supervisor (docs/design/v5-hostd.md).
export {
  type Caller,
  type ClusterClient,
  type GuardSource,
  type HostApi,
  HostRpcError,
} from "./api.js";
export {
  CATALOG_ROOTS,
  type Catalog,
  type CatalogEntry,
  type CatalogProblem,
  DESCRIPTOR_FILE,
  ENV_PLACEHOLDER_PREFIX,
  isKnownPlaceholder,
  loadCatalog,
  PLACEHOLDERS,
  placeholdersIn,
} from "./catalog.js";
export {
  type CallOptions,
  HostdClient,
  HostdUnavailableError,
  type LogsOptions,
} from "./client.js";
export { Daemon, type DaemonOptions, HostdRunningError } from "./daemon.js";
export { matchesPassEnv, mergeEnv, passEnv, workerBaseEnv } from "./env.js";
export {
  GpuCache,
  type GpuReader,
  type GpuSample,
  nvidiaSmiReader,
  parseNvidiaSmi,
} from "./gpu.js";
export { coreStatusGuard, GuardUnknownError, guardStatesOf } from "./guard.js";
export {
  HOST_CONFIG_FILE,
  HostConfigError,
  type LoadedHostConfig,
  loadHostConfig,
  parseHostConfig,
  type StateLayout,
  stateLayout,
} from "./host-config.js";
export { fileTail, MEMORY_LINES, ServiceLog } from "./logs.js";
export {
  freePort,
  localAddress,
  PORT_DENIED_HINT,
  type PortProbe,
  type PortState,
  probePort,
  tcpConnect,
} from "./ports.js";
export { httpHealthy } from "./probe.js";
export {
  expandService,
  type LiveValues,
  offloadUrls,
  planServices,
  pythonIn,
  type ResolveContext,
  ResolveError,
  type ServicePlan,
  type SpawnSpec,
} from "./resolve.js";
export {
  pidAlive,
  RUN_FILE,
  type RunInfo,
  readRunFile,
  runFilePath,
} from "./run-file.js";
export { JSON_RPC } from "./server.js";
export { DEFAULT_TIMING, type Timing } from "./service.js";
