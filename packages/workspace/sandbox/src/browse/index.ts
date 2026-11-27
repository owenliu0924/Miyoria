// A real browser for her, in a job on a computer of the cluster (docs/design/v6-agent-split.md P6).

export {
  BROWSE_ACT,
  BROWSE_OPEN,
  BROWSE_READ,
  BROWSE_SHOT,
  type Browse,
  type BrowseActArgs,
  BrowseActArgsSchema,
  type BrowseAvailability,
  type BrowseOpenArgs,
  BrowseOpenArgsSchema,
  type BrowseOptions,
  type BrowseReadArgs,
  BrowseReadArgsSchema,
  type BrowseShotArgs,
  BrowseShotArgsSchema,
  browseCapabilities,
  browseUrl,
} from "./capabilities.js";
export { type BrowseConfig, BrowseConfigSchema } from "./config.js";
export { BrowseOffer, type CapabilityRegistrar } from "./offer.js";
export { DOWNLOADS_DIR, DRIVER, DRIVER_ARGV, SHOT_MAX_BYTES } from "./protocol.js";
export {
  BROWSE_SESSION_NAME,
  BrowseError,
  type BrowseOwner,
  BrowseSession,
  BrowseSessions,
  DEFAULT_BROWSE_SESSION,
} from "./sessions.js";
