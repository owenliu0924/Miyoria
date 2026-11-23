// Messages of `miyoria host invite | join | ls | approve | remove` and the hosts of `status --all`.

export const cluster = {
  // ---- Core's admin API ----
  unreachable: (error: string) =>
    `Cannot reach Core's admin API: ${error}. Check that Core is running.`,
  tokenRejected: "Core's admin API rejected the token. Check MIYORIA_API_TOKEN.",
  moduleOff:
    "Core's cluster module is not running. It requires the database; check its state with `miyoria module list`.",
  coreAnswered: (detail: string) => `Core answered: ${detail}`,
  // ---- invite ----
  badTtl: (max: number) => `--ttl must be a whole number of minutes from 1 to ${max}.`,
  inviteCode: (code: string) => `Invite code ${code}`,
  /** `until`: local date and time; `minutes`: how long; `name`: the only host name it takes. */
  inviteValid: (until: string, minutes: string, name: string | null) =>
    `   Valid until ${until} (${minutes}), single use${name !== null ? `, only for a host named ${name}` : ""}`,
  runOnJoining: "Run this on the machine that is joining:",
  loopbackOnly: (bind: string) =>
    `Core's admin API listens only on ${bind} (this machine), so other machines cannot reach it. To let another machine join, set [modules.api] bind to this machine's LAN or tailnet address (for example 192.168.1.10:7878), restart Core, and use that address in the command above.`,
  // ---- join ----
  notAUrl: (text: string) => `\`${text}\` is not a URL (for example http://192.168.1.10:7878).`,
  badScheme: "The Core address must use http:// or https://.",
  noDaemon:
    "hostd is not running on this machine; it connects to Core when `miyoria up` starts it.",
  oldDaemon:
    "This hostd does not support host.relink (it is too old). Run `miyoria down`, then `miyoria up`.",
  relinkFailed: (reason: string) =>
    `Could not ask hostd to connect to Core: ${reason}. Running \`miyoria down\` and then \`miyoria up\` also connects it.`,
  linkState: (link: string) => `hostd link to Core: ${link}`,
  /** `command`: the approve command, emphasised. */
  approveNext: (command: string) =>
    `One step left: run ${command} on the Core node (or use the admin panel) to approve this machine. Its services are not used until it is approved.`,
  approvedAlready: (capabilities: string) =>
    `Approved: ${capabilities}. This machine needs no further approval.`,
  noEnabledServices: "(host.toml enables no services)",
  codeInvalid:
    "The invite code is not valid: it does not exist, was already used or has expired. Run `miyoria host invite` on the Core node again.",
  nameRejected: (detail: string) =>
    `Core rejected the name: ${detail}. Choose another with --name; the invite code was not used up.`,
  /** `retry`: how long to wait, when Core said. */
  tooManyAttempts: (retry: string | null) =>
    `Too many attempts; Core ignores this address for now. ${retry !== null ? `Try again in ${retry}.` : "Try again later."}`,
  joinModuleOff: "Core's cluster module is not running, so no host can join now.",
  notCoreApi: (url: string) =>
    `${url} has no /api/cluster/join: it is not the admin API address of a Miyoria Core, or that Core is too old.`,
  coreStatus: (status: number, detail: string | null) =>
    `Core answered ${status}${detail !== null ? `: ${detail}` : ""}`,
  missingUrl: "Missing the Core address: <core-url>",
  missingCode:
    "Missing the invite code: --code (run `miyoria host invite` on the Core node to get one)",
  alreadyJoined: (file: string) =>
    `This machine has already joined a Core (${file} exists). To join another, run \`miyoria host remove\` on the original Core first, then add --force.`,
  cannotWrite: (dir: string, error: string) => `Cannot write to ${dir}: ${error}`,
  cannotReach: (url: string, error: string) =>
    `Cannot reach ${url}: ${error}. Check the address, and whether [modules.api] bind of that Core listens only on its own machine.`,
  notJoinResult: (url: string) => `The answer from ${url} is not a join result of a Miyoria Core.`,
  joined: (name: string) => `Joined Core as ${name}`,
  keyWritten: (file: string) => `Key written to ${file} (keep it private)`,
  clusterUrl: (file: string, url: string) => `[cluster] url = ${url} in ${file}`,
  nameTaken: (name: string) =>
    `Core already has a host named ${name}. Run \`miyoria host remove ${name}\` and try again, or choose another name with --name.`,
  localNoCode: "--local does not take an invite code.",
  alreadyJoinedLocal: (file: string) =>
    `This machine has already joined Core (${file} exists). To join again, run \`miyoria host remove <name>\` first, then add --force.`,
  joinedLocal: (name: string) => `Joined the local Core as ${name}`,
  // ---- `up` links this machine to its own Core ----
  clause: {
    connected: "connected",
    state: (link: string) => `link state: ${link}`,
    noDaemon: "hostd is not running",
    oldDaemon:
      "this hostd does not support host.relink; run `miyoria down` and `miyoria up` to connect",
    failed: (reason: string) => `could not ask hostd to connect: ${reason}`,
  },
  /** `clause`: one of `clause`. */
  selfLinked: (name: string, capabilities: string, clause: string) =>
    `Linked this machine to the local Core (name ${name}, approved: ${capabilities}); ${clause}`,
  noCapabilities: "none",
  goneFromCore: (id: string) =>
    `Core no longer has this machine (${id}); it was not linked automatically. Run \`miyoria host join --local --force\` to join again.`,
  revoked: (name: string) => `${name} was revoked in Core; it was not approved automatically.`,
  reapproved: (name: string, capabilities: string) =>
    `Re-approved this machine (${name}): ${capabilities}`,
  selfLinkFailed: (error: string) =>
    `This machine was not linked to the local Core automatically: ${error}`,
  // ---- ls ----
  notConnected: "not connected",
  /** `duration`: how long, when known. */
  connectedFor: (duration: string | null) =>
    `connected${duration !== null ? ` for ${duration}` : ""}`,
  columns: {
    name: "Name",
    status: "Status",
    connection: "Connection",
    capabilities: "Approved capabilities",
    platform: "Platform",
    version: "Version",
    lastSeen: "Last seen",
  },
  noHosts:
    "Core has no hosts yet. Run `miyoria host invite` to create an invite code, or `miyoria host join --local` to add this machine.",
  // ---- approve / remove ----
  noSuchHost: (name: string) =>
    `Core has no host named ${name}. Run \`miyoria host ls\` to list the hosts.`,
  offlineCapabilities: (name: string) =>
    `${name} is not connected, so Core does not know what it provides. List the capabilities to approve, for example \`miyoria host approve ${name} asr tts\`.`,
  noReportedCapabilities: (name: string) =>
    `${name} reported no capabilities. List the capabilities to approve.`,
  approved: (name: string, capabilities: string) => `Approved ${name}: ${capabilities}`,
  removeNeedsYes: "Not an interactive terminal: add -y to remove.",
  removeConfirm: (name: string, status: string, connected: boolean) =>
    `Remove ${name} (${status}${connected ? ", connected" : ""})? Its key stops working, its link is closed and its services are removed from Core's endpoints.`,
  notRemoved: "Not removed",
  alreadyGone: (name: string) => `${name} is no longer in Core.`,
  removed: (name: string) => `Removed ${name}`,
  // ---- status --all ----
  hostsUnavailable: (error: string) => `(Could not list the hosts: ${error})`,
  allHosts: "All hosts (Core)",
  noHostsShort: "Core has no hosts yet (`miyoria host invite`)",
  lastSeen: (when: string) => `last seen ${when}`,
  approvedList: (capabilities: string) => `approved: ${capabilities}`,
  noServices: "  No services",
  servicesUnavailable: (error: string) => `  (Could not list the services: ${error})`,
};
