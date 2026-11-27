// @miyoria/plugin-host/mcp: MCP integration (module `mcp`).
//
// Client. Every server in `[mcp.servers.<name>]`, and every server an enabled extension bundles
// (`<extension>-<name>`, started by the extension launcher where the extension runs), is
// connected over stdio or Streamable HTTP (concurrently, in the background; a server that fails
// to start never fails the module). Its allowed tools are gated capabilities
// `mcp.<server>.<tool>` in the `ActuatorRegistry`, offered to the model as
// `mcp_<server>_<tool>`: the server's risk, limits, audit, and its permission node (default
// `tools.mcp.<server>`, a work node: members she knows well enough may use it). The tool list follows `notifications/tools/list_changed`, dead servers
// are reconnected with backoff and their tools unregistered meanwhile, and everything is
// unregistered on stop. `McpStatus` (service `McpStatusKey`) reports each server's state.
//
// Server (optional). With `[mcp.server] enabled = true` a bearer-token protected Streamable
// HTTP endpoint at `http://<bind>/mcp` exposes read-only inspection tools (`status`,
// `list_modules`, `list_tools`, `recent_decisions`) to external agents. It cannot send
// messages or change anything.

export {
  type BundledServer,
  bundledLaunchSpec,
  bundledServerName,
  bundledServers,
} from "./bundled.js";
export { ChildTransport } from "./child-transport.js";
export {
  McpConnectionError,
  McpToolError,
  type McpToolOptions,
  mcpCapabilityName,
  mcpToolCapability,
  mcpToolRisk,
  Registrar,
  ServerRunner,
} from "./client.js";
export {
  ExposeConfig,
  type ExposeConfigData,
  type McpConfig,
  McpConfigError,
  McpConfigSchema,
  parseMcpConfig,
  reconnectInitialMs,
  reconnectMaxMs,
  ServerConfig,
  type ServerConfigData,
  type Transport,
} from "./config.js";
export { McpModule, McpStartError } from "./module.js";
export {
  compactSchema,
  flattenResult,
  globMatch,
  MAX_TOOL_NAME,
  registryName,
  stdioEnv,
  ToolFilter,
  truncateChars,
} from "./policy.js";
export {
  EXPOSED_TOOL_LIST,
  ExposedTools,
  exposedServer,
  McpServeError,
  parseBind,
  tokenMatches,
} from "./server.js";
export { ProfileIdKey } from "./services.js";
export {
  type ExposeStatus,
  McpStatus,
  McpStatusKey,
  newServerStatus,
  type ServerState,
  type ServerStatus,
} from "./status.js";
