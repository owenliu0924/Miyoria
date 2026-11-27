import type { Principal } from "./actuator.js";
import { serviceKey } from "./service-key.js";

// Each person's sandbox CPU seconds (docs/design/v6-sandbox.md §8). `hostWorkQuota` in selfhost
// implements it; the sandbox's gate and client only know this interface.

/** The one who pays: a person's key (their id, or `platform:id` for someone she does not know). */
export interface WorkPayer {
  person: string;
  /** The owner's work is counted but never held to a limit. */
  exempt?: boolean;
}

/** A limit a payer is at now. */
export interface WorkCap {
  which: "hour" | "day";
  /** The time on her clock when it is not over any more (epoch ms). */
  until: number;
  /** The first time in this period they were stopped: say it once. */
  first: boolean;
  limit: number;
  used: { hour: number; day: number };
}

/** Each person's sandbox CPU seconds. */
export interface WorkQuota {
  /** Whose a call is; her own (no requester) is `null`. */
  payerOf(principal: Principal): WorkPayer | null;
  /** The limit the payer is at; `null`: none, or exempt, or no payer. */
  capped(payer: WorkPayer | null, now: number): WorkCap | null;
  /** Adds `cpuSeconds`; does nothing without a payer. */
  charge(payer: WorkPayer | null, now: number, cpuSeconds: number): void;
  /** The sentence for this period: `true` the first time it is asked. */
  claimNotice(person: string): boolean;
  used(person: string, now: number): { hour: number; day: number };
  rules(): { cpuSecondsPerHour: number; cpuSecondsPerDay: number };
}

export const WorkQuotaKey = serviceKey<WorkQuota>("WorkQuota");
