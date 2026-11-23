// Each person's AI quota, read-only (docs/design/v6-agent.md 「上限收成三種」): `GET /api/llm/quota`
// for the owners (the limits, and everyone she spent on in her day, the most first), and the
// `quota` field of the member page (`member.ts`), the person's own numbers.

import { PersonQuotaKey } from "@miyoria/brain/self";
import type { MemberQuota, QuotaReport } from "@miyoria/contracts/api";
import { PeopleStoreKey } from "@miyoria/store";
import { type AccountRef, AuthorizerKey, accountRefString, isOwnerAccount } from "@miyoria/types";
import { os } from "./contract.js";
import type { ApiState } from "./state.js";

/** The key a person is charged under: their person id, else their account (the runner's). */
export function quotaKey(account: AccountRef, person: string | null): string {
  return person ?? accountRefString(account);
}

async function report(state: ApiState): Promise<QuotaReport> {
  const quota = state.service(PersonQuotaKey, "AI quota");
  const now = state.now();
  const rules = quota.rules();
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
  const used = quota.used(quotaKey(account, person), state.now());
  return {
    hour_usd: used.hour,
    day_usd: used.day,
    hour_limit_usd: rules.usdPerHour,
    day_limit_usd: rules.usdPerDay,
    exempt: isOwnerAccount(state.optional(AuthorizerKey), account),
  };
}

/** `GET /api/llm/quota`, on the route table (it joins the `llm` group). */
export const quotaRpc = {
  quota: os.llm.quota.handler(({ context }) => report(context.state)),
};
