// The migrations that retired features (phase 5, docs/design/v5-play.md §10): what a removed feature
// still held goes back to its owner as a ledger row that says so, then its tables are dropped.
// The database is brought to version 1, filled the way the old code left it, and migrated.

import { identitySchema, migrate } from "@miyoria/store";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { newId } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { economySchema } from "../src/migrations.js";

const open: TestDb[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
});

const NOW = 1_700_000_000_000_000;

/** A database as version 1 left it, with two people. */
function oldDatabase() {
  const t = openTestDb({
    identity: true,
    plugins: [{ ...economySchema, migrations: economySchema.migrations.slice(0, 1) }],
  });
  open.push(t);
  const identity = t.identity;
  if (!identity) throw new Error("identity");
  const people = ["Alice", "Bob"].map((name, i) => {
    const ref = { platform: "discord", id: `u${i}` };
    const person = identity.see(ref, name).id;
    const account = identity.account(ref)?.id ?? "";
    return { person, account };
  });
  let ts = NOW;
  const row = (person: string, delta: number, reason: string, ref: string | null = null) => {
    const id = newId();
    ts += 1;
    t.db.run(
      `INSERT INTO economy_ledger (id, person_id, delta, reason, ref, idem_key, ts)
       VALUES ($id, $person, $delta, $reason, $ref, $key, $ts)`,
      { id, person, delta, reason, ref, key: `k:${id}`, ts },
    );
    return id;
  };
  const balance = (person: string) =>
    Number(
      t.db.all("SELECT SUM(delta) AS n FROM economy_ledger WHERE person_id = $person", {
        person,
      })[0]?.n,
    );
  return { t, people, row, balance };
}

function refunds(t: TestDb) {
  return t.db.all(
    "SELECT person_id, delta, reason, ref, idem_key FROM economy_ledger WHERE reason = 'refund_removed' ORDER BY seq",
  );
}

function tableExists(t: TestDb, name: string): boolean {
  return (
    t.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = $name", { name })
      .length > 0
  );
}

describe("retiring deals", () => {
  it("returns the escrow of every deal still open, once, and drops the table", () => {
    const { t, people, row, balance } = oldDatabase();
    const [alice, bob] = people;
    if (!alice || !bob) throw new Error("people");
    row(alice.person, 100, "checkin");
    row(bob.person, 100, "checkin");
    const deal = (
      who: { account: string },
      status: string,
      prepaid: boolean,
      escrow: string | null,
    ) =>
      t.db.run(
        `INSERT INTO economy_deals (id, account_id, reward_item, reward_count, reward_value, task,
           prepaid, escrow_entry, status, created_at)
         VALUES ($id, $account, 'rice', 1, 10, 'meow', $prepaid, $escrow, $status, $ts)`,
        { id: newId(), account: who.account, status, prepaid: prepaid ? 1 : 0, escrow, ts: NOW },
      );
    // Held: two open prepaid deals, one each.
    const heldA = row(alice.person, -30, "deal_escrow");
    const heldB = row(bob.person, -10, "deal_escrow");
    deal(alice, "open", true, heldA);
    deal(bob, "open", true, heldB);
    // Not held: released to her, refunded already, unpaid.
    deal(alice, "settled", true, row(alice.person, -20, "deal_escrow"));
    const refunded = row(bob.person, -15, "deal_escrow");
    row(bob.person, 15, "refund", refunded);
    deal(bob, "refunded", true, refunded);
    deal(alice, "open", false, null);
    expect(balance(alice.person)).toBe(100 - 30 - 20);
    expect(balance(bob.person)).toBe(100 - 10 - 15 + 15);

    expect(migrate(t.db, [identitySchema, economySchema]).map((m) => m.name)).toEqual([
      "retire_deals",
    ]);

    expect(refunds(t)).toEqual([
      {
        person_id: alice.person,
        delta: 30,
        reason: "refund_removed",
        ref: heldA,
        idem_key: `refund:${heldA}`,
      },
      {
        person_id: bob.person,
        delta: 10,
        reason: "refund_removed",
        ref: heldB,
        idem_key: `refund:${heldB}`,
      },
    ]);
    expect(balance(alice.person)).toBe(100 - 20);
    expect(balance(bob.person)).toBe(100);
    expect(tableExists(t, "economy_deals")).toBe(false);
    // Each refund is an `economy.posted` event too, with the balance after it.
    const events = t.db.all(
      "SELECT key, person_id, data FROM events WHERE type = 'economy.posted' ORDER BY seq",
    );
    expect(events).toHaveLength(2);
    const first = events[0];
    expect(first?.person_id).toBe(alice.person);
    expect(JSON.parse(String(first?.data))).toMatchObject({
      person_id: alice.person,
      delta: 30,
      reason: "refund_removed",
      ref: heldA,
      balance: 100 - 30 - 20 + 30,
    });
    // Nothing is left to apply, and a second run changes nothing.
    expect(migrate(t.db, [identitySchema, economySchema])).toEqual([]);
    expect(refunds(t)).toHaveLength(2);
  });
});
