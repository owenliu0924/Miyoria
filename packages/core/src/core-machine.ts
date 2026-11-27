// Which hosts of the cluster are Core's own machine (docs/design/v6-sandbox.md §12.2, §16 item
// 3): what goes there stays on this machine, so the owner does not have to list it among the
// computers that may have members' folders or an extension's credentials.
//
// "From this machine" is the link's loopback address: a reverse proxy or tunnel on Core's machine
// in front of the cluster port makes every host look local, so the README tells such a setup to
// keep it in mind (the owner's lists are then the only thing that tells the computers apart).

import { ClusterKey } from "@miyoria/cluster";
import type { ServiceLookup } from "@miyoria/runtime/kernel";

/** Whether a URL names this machine: `localhost`, `127.x`, `::1`. */
function loopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/gu, "");
    return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/u.test(host);
  } catch {
    return false;
  }
}

/**
 * The hosts of `capability` that are Core's own machine, as the `cluster` module's registry
 * knows them: a connected host whose link comes from this machine, and an endpoint Core calls
 * directly at a loopback address. What goes there stays on this machine, so it needs no
 * listing where the owner names the other computers (`member_hosts`, `trusted_hosts`). Read at
 * each use: hosts connect after Core starts. Without the `cluster` module there are none.
 */
export function coreMachineHosts(services: ServiceLookup, capability: string): string[] {
  const registry = services.get(ClusterKey)?.registry;
  if (registry === undefined) return [];
  const out = new Set<string>();
  for (const host of registry.hostRouting()) if (host.local === true) out.add(host.host);
  for (const e of registry.candidates(capability, { all: true })) {
    if (e.via === "direct" && loopbackUrl(e.url)) out.add(e.host);
  }
  return [...out];
}
