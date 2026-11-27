// The bearer token check, the Node twin of `workers/service_auth.py`: hostd starts the service
// with `MIYORIA_SERVICE_TOKEN` (its own) and `MIYORIA_HOST_TOKEN` (the machine's); either opens
// every route, `/health` included, compared in constant time. A wrong or missing token is 401
// with no reason given.

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** The tokens that open the service: the non-empty ones of the two. */
export function acceptedTokens(token: string | null, hostToken: string | null): Buffer[] {
  return [token, hostToken]
    .map((t) => (t ?? "").trim())
    .filter((t) => t !== "")
    .map((t) => digest(t));
}

/** Hashed first, so the comparison never depends on the lengths either. */
function digest(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/** Whether `request` carries one of `accepted`. Every token is compared, whichever matches. */
export function authorized(request: IncomingMessage, accepted: readonly Buffer[]): boolean {
  if (accepted.length === 0) return true;
  const header = request.headers.authorization;
  if (typeof header !== "string") return false;
  const space = header.indexOf(" ");
  if (space < 0 || header.slice(0, space).toLowerCase() !== "bearer") return false;
  const presented = digest(header.slice(space + 1).trim());
  let ok = false;
  for (const token of accepted) ok = timingSafeEqual(presented, token) || ok;
  return ok;
}

/** Without a token the service only listens on this machine's loopback. */
export function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}
