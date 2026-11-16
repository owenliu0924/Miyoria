// Config keys that were read once and are not any more. A file that still holds one loads as
// before (the schemas drop keys they do not name); Core names the ones it finds in one warning
// at start, so nobody keeps tuning a value that does nothing.

import type { Config } from "@miyoria/runtime/kernel";

/**
 * Dotted paths. A path that ends at a table stands for the whole table (`modules.agent.attention`
 * is every key under it); a path inside a table that is itself still read names one key.
 */
export const REMOVED_CONFIG_KEYS: readonly string[] = [
  "core.pipeline",
  "modules.agent.runner",
  "modules.mind.daily_posts",
];

/** The removed paths `config` still holds, in the order of `REMOVED_CONFIG_KEYS`. */
export function removedConfigKeys(config: Config): string[] {
  return REMOVED_CONFIG_KEYS.filter((path) => config.section(path) !== undefined);
}

/** One warning naming every removed key the file still holds; none when it holds none. */
export function warnRemovedKeys(config: Config, warn: (message: string) => void): string[] {
  const found = removedConfigKeys(config);
  if (found.length > 0) {
    warn(`config keys no longer read, ignored: ${found.map((p) => `\`${p}\``).join(", ")}`);
  }
  return found;
}
