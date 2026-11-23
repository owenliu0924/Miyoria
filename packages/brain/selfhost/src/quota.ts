// Each person's AI quota on today's services (`PersonQuota` of `@miyoria/brain/self`): the rules
// are `[modules.agent.quota]`, her day is the Arbiter's local day, the book is the store's `quota`
// table, and the owner is never capped. A run is charged to the people it works for
// (`payerOfAuthor` of every caller, or of who asked for what came back or for a time she set: the
// runner shares a step among them and gives a tool's own calls to the one it is for); her own
// initiative to nobody.

import { StoreKey } from "@miyoria/store";
import { type AccountRef, AuthorizerKey, accountRefString, isOwnerAccount } from "@miyoria/types";
import type { Agent } from "../../agent/src/index.js";
import { dayIndex, type LocalTime, nextDayStart } from "../../arbiter/src/index.js";
import {
  type Payer,
  PersonQuota,
  type QuotaDay,
  utcQuotaDay,
  type Wake,
  type WakeAuthor,
  wakeAuthor,
} from "../../self/src/index.js";
import { quotaTables } from "./quota-store.js";

const DAY_MS = 86_400_000;

/** Her day by her local clock; UTC days without one. */
export function localQuotaDay(quiet: LocalTime | null): (now: number) => QuotaDay {
  if (quiet === null) return utcQuotaDay;
  return (now) => ({
    key: new Date(dayIndex(now, quiet) * DAY_MS).toISOString().slice(0, 10),
    endsAt: nextDayStart(now, quiet),
  });
}

/** The key a person is charged under: their person id when she knows them, else the account. */
export function personKey(agent: Agent, account: AccountRef): string {
  return agent.attitude(account)?.person ?? accountRefString(account);
}

/** Whom `from`'s request is charged to; the owner is charged and exempt. */
export function payerOfAuthor(agent: Agent, from: WakeAuthor): Payer {
  const owner = isOwnerAccount(agent.ctx.services.get(AuthorizerKey), from.account);
  return { person: personKey(agent, from.account), ...(owner && { exempt: true }) };
}

/** Whom a run woken by `wake` is charged to; `null`: nobody (her own initiative). */
export function payerOf(agent: Agent, wake: Wake): Payer | null {
  const from = wakeAuthor(wake);
  return from === null ? null : payerOfAuthor(agent, from);
}

/** The quota of the process, over the store's table when there is one. */
export function hostQuota(agent: Agent, quiet: LocalTime | null): PersonQuota {
  const book = agent.ctx.services.get(StoreKey)?.plugin(quotaTables) ?? null;
  return new PersonQuota({
    rules: () => {
      const q = agent.config.quota;
      return {
        usdPerHour: q.person_usd_per_hour,
        usdPerDay: q.person_usd_per_day,
        unpricedUsdPerMtok: q.unpriced_usd_per_mtok,
      };
    },
    day: localQuotaDay(quiet),
    book,
    onError: (what, error) => agent.log.warn({ err: String(error) }, what),
  });
}
