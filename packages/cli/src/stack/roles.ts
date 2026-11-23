// Machine roles: which services one computer runs. This file is the single place that names the
// roles and the services in them; rename a role here (and in the docs) and nothing else changes.
//
// `[machine]` in miyoria.toml picks the roles (or lists services by hand) for THIS computer:
//
//   [machine]
//   roles = ["core"]                  # broadcast | core | inference; several = one PC doing both
//   # services = ["core", "asr"]      # hand-picked services; replaces `roles` when given
//   [machine.hosts]
//   core = "127.0.0.1"                # address of the computer running core, as the others see it
//   inference = "127.0.0.1"           # address of the computer running asr / tts / sing

import type { Config } from "@miyoria/runtime/kernel";
import { isJsonObject } from "@miyoria/types";
import { z } from "zod";
import { t } from "../i18n/index.js";

export interface RoleInfo {
  /** Services in start order. */
  services: readonly string[];
}

/** The roles, by the services each brings up. */
export const ROLES = {
  broadcast: { services: ["voice-node", "stage"] },
  core: { services: ["core", "turn"] },
  inference: { services: ["asr", "tts", "sing"] },
} as const satisfies Record<string, RoleInfo>;

export type Role = keyof typeof ROLES;
export const ROLE_NAMES = Object.keys(ROLES) as Role[];

/** Every service, in the order the old launcher brought them up (models, core, broadcast). */
export const SERVICE_ORDER = ["asr", "tts", "sing", "turn", "core", "voice-node", "stage"] as const;
export type ServiceName = (typeof SERVICE_ORDER)[number];

export const WORKER_SERVICES: readonly string[] = ["asr", "tts", "sing", "turn"];

export function isRole(name: string): name is Role {
  return (ROLE_NAMES as string[]).includes(name);
}

export function isService(name: string): name is ServiceName {
  return (SERVICE_ORDER as readonly string[]).includes(name);
}

export function roleOf(service: string): Role | null {
  for (const r of ROLE_NAMES)
    if ((ROLES[r].services as readonly string[]).includes(service)) return r;
  return null;
}

/** Services of the given roles, deduplicated and in start order. */
export function servicesOfRoles(roles: readonly Role[]): ServiceName[] {
  const set = new Set<string>(roles.flatMap((r) => ROLES[r].services));
  return SERVICE_ORDER.filter((s) => set.has(s));
}

export const ALL_SERVICES: readonly ServiceName[] = [...SERVICE_ORDER];

/**
 * Turns words from the command line (`core`, `inference,broadcast`, `all`, `asr`) into services.
 * Throws on a word that is neither a role, `all` nor a service.
 */
export function expandTargets(words: readonly string[]): ServiceName[] {
  const set = new Set<string>();
  for (const raw of words.flatMap((w) => w.split(","))) {
    const w = raw.trim();
    if (w === "") continue;
    if (w === "all") for (const s of SERVICE_ORDER) set.add(s);
    else if (isRole(w)) for (const s of ROLES[w].services) set.add(s);
    else if (isService(w)) set.add(w);
    else {
      throw new Error(
        t.stack.roles.unknownTarget(w, t.common.list(ROLE_NAMES), t.common.list(SERVICE_ORDER)),
      );
    }
  }
  return SERVICE_ORDER.filter((s) => set.has(s));
}

// ---- [machine] ---------------------------------------------------------------------------

export const LOOPBACK = "127.0.0.1";

/** `[machine]`; also composed into the root schema of the whole file (`validate.ts`). */
export const MachineSchema = z
  .object({
    roles: z.array(z.enum(ROLE_NAMES as [Role, ...Role[]])).default([]),
    /** Hand-picked services; when present it replaces `roles`. */
    services: z.array(z.enum(SERVICE_ORDER)).optional(),
    hosts: z
      .object({
        core: z.string().trim().min(1).default(LOOPBACK),
        inference: z.string().trim().min(1).default(LOOPBACK),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export interface Machine {
  roles: Role[];
  /** The services this computer runs, in start order. */
  services: ServiceName[];
  hosts: { core: string; inference: string };
  /** `services` was written by hand instead of coming from `roles`. */
  custom: boolean;
}

/** `[machine]`, or `null` when the section is missing (old configs keep the `[stack]` behavior). */
export function machineConfig(config: Config): Machine | null {
  const section = config.section("machine");
  if (!isJsonObject(section)) return null;
  const raw = MachineSchema.parse(section);
  const custom = raw.services !== undefined;
  // The end-of-turn worker is only worth running when the voice module is set to use it.
  const services = custom
    ? SERVICE_ORDER.filter((s) => (raw.services as string[]).includes(s))
    : servicesOfRoles(raw.roles).filter((s) => s !== "turn" || turnWanted(config));
  return { roles: raw.roles, services, hosts: raw.hosts, custom };
}

/** `[modules.voice]` uses Smart Turn or Silero, so `workers/turn` is needed. */
export function turnWanted(config: Config): boolean {
  const voice = config.module("voice").config;
  return (
    isJsonObject(voice) && (voice.turn_engine === "smart-turn" || voice.vad_engine === "silero")
  );
}

export function isLoopback(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/** Roles whose services are all present in `services` (a custom pick can fill several). */
export function rolesCovered(services: readonly string[]): Role[] {
  return ROLE_NAMES.filter((r) => ROLES[r].services.every((s) => services.includes(s)));
}
