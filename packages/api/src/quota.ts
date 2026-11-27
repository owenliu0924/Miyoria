// Each person's AI quota, read-only (docs/design/v6-agent.md 「上限收成三種」): `GET /api/llm/quota`
// for the owners (the limits, and everyone she spent on in her day, the most first), and the
// `quota` field of the member page (`member.ts`), the person's own numbers.

import { PersonQuotaKey } from "@miyoria/brain/self";
import type { MemberQuota, QuotaReport, QuotaWork } from "@miyoria/contracts/api";
import { PeopleStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  AuthorizerKey,
  accountRefString,
  isOwnerAccount,
  type WorkQuota,
  WorkQuotaKey,
} from "@miyoria/types";
import { os } from "./contract.js";
import type { ApiState } from "./state.js";

/** The key a person is charged under: their person id, else their account (the runner's). */
export function quotaKey(account: AccountRef, person: string | null): string {
  return person ?? accountRefString(account);
}

/**
 * One person's sandbox CPU seconds against the limits (`0`: none). `capped` is worked out from
 * the numbers here, not asked of `WorkQuota.capped`, which marks the person's stretch and so would
 * use up the one line she says when they are stopped. The owner is counted, never capped.
 */
function workOf(work: WorkQuota, person: string, exempt: boolean, now: number): QuotaWork {
  const rules = work.rules();
  const used = work.used(person, now);
  const capped = exempt
    ? null
    : rules.cpuSecondsPerDay > 0 && used.day >= rules.cpuSecondsPerDay
      ? "day"
      : rules.cpuSecondsPerHour > 0 && used.hour >= rules.cpuSecondsPerHour
        ? "hour"
        : null;
  return {
    hour: used.hour,
    day: used.day,
    limit_hour: rules.cpuSecondsPerHour,
    limit_day: rules.cpuSecondsPerDay,
    capped,
  };
}

async function report(state: ApiState): Promise<QuotaReport> {
  const quota = state.service(PersonQuotaKey, "AI quota");
  const now = state.now();
  const rules = quota.rules();
  const work = state.optional(WorkQuotaKey);
  const names = new Map(
    ((await state.optional(PeopleStoreKey)?.all()) ?? []).map((p) => [
      String(p.id),
      p.display_name,
    ]),
  );
  return {
    limits: {
      person_usd_per_hour: rules.usdPerHour,
      person_usd_per_day: rules.usdPerDay,
      unpriced_usd_per_mtok: rules.unpricedUsdPerMtok,
    },
    people: quota
      .today(now)
      .sort((a, b) => b.used.day - a.used.day)
      .map(({ person, used }) => ({
        person,
        name: names.get(person) ?? null,
        hour_usd: used.hour,
        day_usd: used.day,
        capped: quota.limitAt(person, now)?.which ?? null,
        ...(work === undefined ? {} : { work: workOf(work, person, false, now) }),
      })),
  };
}

/** The person's own numbers for the member page; `null` without the quota. */
export function memberQuota(
  state: ApiState,
  account: AccountRef,
  person: string | null,
): MemberQuota | null {
  const quota = state.optional(PersonQuotaKey);
  if (quota === undefined) return null;
  const rules = quota.rules();
  const key = quotaKey(account, person);
  const owner = isOwnerAccount(state.optional(AuthorizerKey), account);
  const work = state.optional(WorkQuotaKey);
  const used = quota.used(key, state.now());
  return {
    hour_usd: used.hour,
    day_usd: used.day,
    hour_limit_usd: rules.usdPerHour,
    day_limit_usd: rules.usdPerDay,
    exempt: owner,
    ...(work === undefined ? {} : { work: workOf(work, key, owner, state.now()) }),
  };
}

/** `GET /api/llm/quota`, on the route table (it joins the `llm` group). */
export const quotaRpc = {
  quota: os.llm.quota.handler(({ context }) => report(context.state)),
};
