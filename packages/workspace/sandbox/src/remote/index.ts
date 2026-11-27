// The sandbox on the computers of the cluster (docs/design/v6-sandbox.md §9): the client of the
// `sandbox` service, `Sandbox` over it, the folder that travels with a job, and what Core
// remembers of its jobs.

export { AutoSandbox, localFeatures } from "./auto.js";
export {
  HttpSandboxClient,
  type HttpSandboxClientOptions,
  isRemoteJob,
  type MachineState,
  refusalText,
  SANDBOX_CAPABILITY,
  SandboxClientError,
  type SandboxClientErrorCode,
} from "./client.js";
export { closeReason, JobEndedError, RemoteJob } from "./job.js";
export { sandboxSchema } from "./jobs-migrations.js";
export {
  decodePayer,
  encodePayer,
  MemorySandboxJobs,
  type SandboxJobRow,
  type SandboxJobs,
  SandboxJobsTable,
  sandboxJobsTables,
} from "./jobs-store.js";
export { ProcChannel } from "./proc-stream.js";
export { quotaSentence, RemoteSandbox, type RemoteSandboxOptions } from "./remote-sandbox.js";
export {
  type CallWorkspace,
  type Manifest,
  pushChanges,
  receiveWorkspace,
  scanTree,
  sendWorkspace,
  type TransferJob,
} from "./transfer.js";
