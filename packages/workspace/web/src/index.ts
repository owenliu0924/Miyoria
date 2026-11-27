// Web search and a page reader for her (module `web`), and declarative HTTP tools (module
// `http_tools`: one TOML file per outside API, behind the gate and the same SSRF guard).

export { type WebConfig, WebConfigSchema } from "./config.js";
export type { SearchHit } from "./html.js";
export * from "./http-tools/index.js";
export { WebModule } from "./module.js";
export { checkUrl, isBlockedAddress, WebError } from "./net.js";
export { WEB_NODE, webCapabilities } from "./tools.js";
export { WebService } from "./web.js";
