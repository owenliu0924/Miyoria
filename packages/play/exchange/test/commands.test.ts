// `/me market …`: every answer is a neutral card with the small print under it and a picture above
// it when one can be drawn. Browsing: the lists (the local stocks first; 大家都在買 shows counts and
// never who), pages of 25, a ticker's card, the modal, the confirmation and the order. Controls
// belong to whoever opened them and expire, also across a restart; 分享 posts only when pressed;
// the suggestions while typing are limited and cached.

import {
  type Card,
  type CardBlock,
  CommandRegistry,
  type CommandReply,
  type ComponentInvocationData,
  type ComponentOutcome,
  Permissions,
} from "@miyoria/commands";
import {
  type AccountRef,
  type ContextKey,
  EXCHANGE_DISCLAIMER,
  EXCHANGE_DISCLAIMER_REAL,
  type PictureDataMap,
  type PictureFile,
  type PictureKind,
  type Pictures,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { EXPIRED, NOT_YOURS, parseAmount, registerCommands } from "../src/commands.js";
import { pageOf } from "../src/real/lists.js";
import type { ExchangeService } from "../src/service.js";
import { ALICE, BOB, local, MIN, rig } from "./rig.js";

const ctx: ContextKey = { platform: "discord", scope: "g", channel: "100", kind: "channel" };
const as = (who: AccountRef, name: string) => ({
  invoker: who,
  invoker_display_name: name,
  context: ctx,
  invoker_is_guild_admin: false,
});
const who = as(ALICE, "Alice");

class FakePictures implements Pictures {
  readonly drawn: { kind: PictureKind; data: unknown }[] = [];
  async render<K extends PictureKind>(
    kind: K,
    data: PictureDataMap[K],
  ): Promise<PictureFile | null> {
    this.drawn.push({ kind, data });
    return {
      name: `${kind}.png`,
      data: new Uint8Array([1]),
      contentType: "image/png",
      alt: `${kind} 摘要`,
      artifact_id: null,
    };
  }
  async forMember() {
    return null;
  }
}

function registryWith(service: () => ExchangeService, pictures: Pictures | null) {
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1", "discord:2"]));
  registerCommands(registry, service, () => pictures);
  return registry;
}

const blocksOf = (r: CommandReply | undefined): CardBlock[] =>
  (r?.card as Card | undefined)?.blocks ?? [];
const selects = (r: CommandReply | undefined) =>
  blocksOf(r).flatMap((b) => (b.type === "select" ? [b.select] : []));
const buttons = (r: CommandReply | undefined) =>
  blocksOf(r).flatMap((b) => (b.type === "buttons" ? b.buttons : []));
const button = (r: CommandReply | undefined, label: string) => {
  const b = buttons(r).find((x) => x.label === label);
  if (!b)
    throw new Error(
      `no button ${label}: ${buttons(r)
        .map((x) => x.label)
        .join(",")}`,
    );
  return b;
};
const replyOf = (o: ComponentOutcome | null): CommandReply => {
  if (!o || o.result.type === "modal")
    throw new Error(`not a reply: ${JSON.stringify(o?.result.type)}`);
  return o.result.reply;
};

function press(
  id: string,
  extra: Partial<ComponentInvocationData> = {},
  person = who,
): ComponentInvocationData {
  return { custom_id: id, message_id: "m1", ...person, ...extra };
}

async function opened(fund = true) {
  const r = await rig({ open: true });
  if (fund) {
    r.wallet.fund(ALICE, 500);
    r.wallet.fund(BOB, 500);
    await r.service.openAccount(ALICE);
    await r.service.openAccount(BOB);
  }
  await r.at(local(0, 12, 30));
  return r;
}

describe("/me market", () => {
  it("opens the overview privately, local stocks first, with the explainer and the small print", async () => {
    const r = await opened();
    const pictures = new FakePictures();
    const registry = registryWith(() => r.service, pictures);
    expect(registry.groupDescription("me market")).toContain("交易所");
    const o = await registry.dispatch({ path: ["me", "market", "overview"], args: {}, ...who });
    expect(o.ephemeral).toBe(true);
    expect(o.text).toContain("第一次來");
    expect(o.text?.indexOf("新手推薦")).toBeLessThan(o.text?.indexOf("RICE") ?? -1);
    expect(o.text).toContain(EXCHANGE_DISCLAIMER);
    const [lists, tickers] = selects(o);
    expect(lists?.options[0]).toMatchObject({ value: "local", default: true });
    expect(tickers?.options.map((x) => x.value)).toEqual(["RICE", "WHLE", "NAPS", "CUBE", "DPSK"]);
    expect(pictures.drawn.map((d) => d.kind)).toEqual(["exchange_overview"]);
    expect((pictures.drawn[0]?.data as { small_print: string } | undefined)?.small_print).toContain(
      EXCHANGE_DISCLAIMER,
    );
  });

  it("buys a local stock by shares through the card, the modal and the confirmation", async () => {
    const r = await opened();
    const registry = registryWith(() => r.service, null);
    const o = await registry.dispatch({ path: ["me", "market", "overview"], args: {}, ...who });
    const pick = selects(o)[1]?.id ?? "";
    const q = replyOf(await registry.dispatchComponent(press(pick, { values: ["RICE"] })));
    expect(q.card?.title).toContain("RICE");
    expect(q.text).not.toContain(EXCHANGE_DISCLAIMER_REAL);
    const modal = await registry.dispatchComponent(press(button(q, "買").id));
    if (modal?.result.type !== "modal") throw new Error("no modal");
    expect(modal.result.modal.fields.map((f) => f.id)).toEqual(["amount"]);
    const confirm = replyOf(
      await registry.dispatchComponent(press(modal.result.modal.id, { fields: { amount: "1" } })),
    );
    expect(confirm.text).toContain("付");
    const done = replyOf(await registry.dispatchComponent(press(button(confirm, "確認").id)));
    expect(done.text).toContain("委託已送出");
    // Pressing the same confirmation again is the same order.
    await registry.dispatchComponent(press(button(confirm, "確認").id));
    expect(
      r.service.real.portfolio("p-alice").orders.filter((x) => x.status === "open"),
    ).toHaveLength(1);
    await r.at(local(0, 13, 1));
    expect(r.service.real.portfolio("p-alice").holdings[0]?.code).toBe("RICE");
  });

  it("refuses someone else's press and an expired one, also after a restart", async () => {
    const r = await opened();
    let service = r.service;
    const registry = registryWith(() => service, null);
    const o = await registry.dispatch({ path: ["me", "market", "overview"], args: {}, ...who });
    const listId = selects(o)[0]?.id ?? "";
    const bob = await registry.dispatchComponent(
      press(listId, { values: ["popular"] }, as(BOB, "Bob")),
    );
    expect(bob?.ephemeral).toBe(true);
    expect(replyOf(bob).text).toContain(NOT_YOURS);
    // A new process: the control still works for its opener while it is in time.
    service = r.restart();
    const again = replyOf(await registry.dispatchComponent(press(listId, { values: ["popular"] })));
    expect(again.text).toContain("大家都在買");
    r.clock.at += (r.service.config.component_minutes + 1) * MIN;
    const late = await registry.dispatchComponent(press(listId, { values: ["popular"] }));
    expect(late?.result.type).toBe("update");
    expect(replyOf(late).text).toContain(EXPIRED);
    expect(replyOf(late).text).toContain(EXCHANGE_DISCLAIMER);
  });

  it("lists the most held tickers as counts only, never who holds them", async () => {
    const r = await opened();
    for (const [account, key] of [
      [ALICE, "a"],
      [BOB, "b"],
    ] as const)
      await r.service.real.place(account, { side: "buy", code: "RICE", shares: 1 }, key);
    await r.at(local(0, 13, 1));
    const rows = r.service.lists.rows("popular", null);
    expect(rows[0]).toMatchObject({ code: "RICE", holders: 2 });
    const registry = registryWith(() => r.service, null);
    const o = await registry.dispatch({ path: ["me", "market", "overview"], args: {}, ...who });
    const view = replyOf(
      await registry.dispatchComponent(press(selects(o)[0]?.id ?? "", { values: ["popular"] })),
    );
    const all = JSON.stringify(view);
    expect(all).toContain("2 人持有");
    expect(all).not.toMatch(/Alice|Bob|p-alice|p-bob/);
  });

  it("pages a long list 25 at a time", async () => {
    expect(pageOf([...Array(60).keys()], 2)).toMatchObject({
      page: 2,
      pages: 3,
      items: [50, 51, 52, 53, 54, 55, 56, 57, 58, 59],
    });
    expect(pageOf([], 5)).toMatchObject({ page: 0, pages: 1 });
    const r = await opened();
    const now = r.clock.at;
    for (let i = 0; i < 30; i++) {
      const code = `T${String(i).padStart(2, "0")}`;
      r.store.real.addInstrument(
        {
          code,
          market: "us",
          name: `示範 ${i}`,
          exchange: "NMS",
          type: "EQUITY",
          currency: "USD",
          provider: "yahoo",
          status: "active",
          added_at: now,
          added_by: null,
        },
        now,
      );
    }
    r.restart({ open: true, watch_max: 50 } as never);
    for (let i = 0; i < 30; i++)
      expect(r.service.lists.setWatch("p-alice", `T${String(i).padStart(2, "0")}`, true).ok).toBe(
        true,
      );
    const registry = registryWith(() => r.service, null);
    const o = await registry.dispatch({ path: ["me", "market", "overview"], args: {}, ...who });
    const watch = replyOf(
      await registry.dispatchComponent(press(selects(o)[0]?.id ?? "", { values: ["watch"] })),
    );
    expect(selects(watch)[1]?.options).toHaveLength(25);
    expect(watch.text).toContain("第 1 / 2 頁");
    const next = replyOf(await registry.dispatchComponent(press(button(watch, "▶").id)));
    expect(selects(next)[1]?.options).toHaveLength(5);
    // The watch list's cap.
    r.restart({ open: true, watch_max: 30 } as never);
    expect(r.service.lists.setWatch("p-alice", "RICE", true)).toMatchObject({
      ok: false,
      code: "watch_full",
    });
  });

  it("shows holdings only to their owner and posts them only when 分享 is pressed", async () => {
    const r = await opened();
    await r.service.real.place(ALICE, { side: "buy", code: "RICE", shares: 1 }, "a");
    await r.at(local(0, 13, 1));
    const pictures = new FakePictures();
    const registry = registryWith(() => r.service, pictures);
    const mine = await registry.dispatch({ path: ["me", "market", "mine"], args: {}, ...who });
    expect(mine.ephemeral).toBe(true);
    expect(mine.text).toContain("RICE");
    expect(pictures.drawn.map((d) => d.kind)).toEqual(["exchange_portfolio"]);
    const shared = await registry.dispatchComponent(press(button(mine, "分享持股").id));
    expect(shared?.result.type).toBe("reply");
    expect(shared?.ephemeral).toBe(false);
    expect(replyOf(shared).card?.title).toBe("Alice 的持股");
    const receipt = await registry.dispatchComponent(press(button(mine, "分享最近一筆成交").id));
    expect(receipt?.ephemeral).toBe(false);
    expect(pictures.drawn.map((d) => d.kind)).toEqual([
      "exchange_portfolio",
      "exchange_portfolio",
      "exchange_receipt",
    ]);
    // Someone else cannot share it.
    const bob = await registry.dispatchComponent(
      press(button(mine, "分享持股").id, {}, as(BOB, "Bob")),
    );
    expect(bob?.ephemeral).toBe(true);
    expect(replyOf(bob).text).toContain(NOT_YOURS);
  });

  it("suggests tickers while typing from what is known, limited and cached, with no provider call", async () => {
    const r = await opened();
    const registry = registryWith(() => r.service, null);
    const data = { path: ["me", "market", "quote"], args: {}, ...who };
    const first = await registry.autocomplete(data, "code", "ri");
    expect(first[0]).toEqual({ name: "RICE 白飯食品", value: "RICE" });
    expect((await registry.autocomplete(data, "code", "")).length).toBeLessThanOrEqual(25);
    // Cached: a ticker added a moment later is not in the same text's answer yet.
    r.store.real.addInstrument(
      {
        code: "RIDE",
        market: "us",
        name: "示範 R",
        exchange: "NMS",
        type: "EQUITY",
        currency: "USD",
        provider: "yahoo",
        status: "active",
        added_at: r.clock.at,
        added_by: null,
      },
      r.clock.at,
    );
    expect(await registry.autocomplete(data, "code", "ri")).toEqual(first);
    // Past the per-minute limit, only cached answers.
    r.restart({ open: true, suggest_per_minute: 2 } as never);
    expect((await registry.autocomplete(data, "code", "w")).length).toBeGreaterThan(0);
    expect((await registry.autocomplete(data, "code", "n")).length).toBeGreaterThan(0);
    expect(await registry.autocomplete(data, "code", "c")).toEqual([]);
    expect(await registry.autocomplete(data, "code", "w")).not.toEqual([]);
  });

  it("reads amounts as coins or shares", () => {
    expect(parseAmount("100", "coins")).toEqual({ unit: "c", value: 100 });
    expect(parseAmount("1", "shares")).toEqual({ unit: "s", value: 1 });
    expect(parseAmount("0.5 股", "coins")).toEqual({ unit: "s", value: 0.5 });
    expect(parseAmount("100 幣", "shares")).toEqual({ unit: "c", value: 100 });
    expect(parseAmount("全部", "coins")).toEqual({ unit: "a", value: 0 });
    expect(parseAmount("1.5", "coins")).toBeNull();
    expect(parseAmount("-1", "coins")).toBeNull();
  });

  it("says the market is off while it is, with the small print", async () => {
    const r = await rig({});
    const reply = await registryWith(() => r.service, null).dispatch({
      path: ["me", "market", "overview"],
      args: {},
      ...who,
    });
    expect(reply.text).toContain("交易所現在沒有開");
    expect(reply.text).toContain(EXCHANGE_DISCLAIMER);
  });
});
