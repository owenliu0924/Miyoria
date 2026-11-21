// The small print under every exchange surface (owner 2026-11-21): this walks every command, then
// every control on every reply it reaches (a few levels deep), every picture builder and the
// notice card, and fails on the first one without the base line, or a real-stock surface without
// the data-source line, or a 2× surface without the leverage line.

import {
  type Card,
  CommandRegistry,
  type CommandReply,
  type ComponentInvocationData,
  Permissions,
} from "@miyoria/commands";
import {
  type ContextKey,
  EXCHANGE_DISCLAIMER,
  EXCHANGE_DISCLAIMER_LEVERAGE,
  EXCHANGE_DISCLAIMER_REAL,
  type PictureDataMap,
  type PictureFile,
  type PictureKind,
  type Pictures,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { card, LEVERAGE_CONFIRM, PATHS, registerCommands } from "../src/commands.js";
import { ALICE, BOB, local, rig } from "./rig.js";

const ctx: ContextKey = { platform: "discord", scope: "g", channel: "100", kind: "channel" };
const who = {
  invoker: ALICE,
  invoker_display_name: "Alice",
  context: ctx,
  invoker_is_guild_admin: false,
};

class Drawn implements Pictures {
  readonly data: { kind: PictureKind; data: { small_print: string } }[] = [];
  async render<K extends PictureKind>(
    kind: K,
    data: PictureDataMap[K],
  ): Promise<PictureFile | null> {
    this.data.push({ kind, data: data as unknown as { small_print: string } });
    return null;
  }
  async forMember() {
    return null;
  }
}

describe("the small print", () => {
  it("is under every reply and picture the commands and their controls reach", async () => {
    const r = await rig({ open: true });
    r.wallet.fund(ALICE, 500);
    r.wallet.fund(BOB, 500);
    await r.service.openAccount(ALICE);
    await r.at(local(0, 12, 30));
    await r.service.real.place(ALICE, { side: "buy", code: "RICE", shares: 1 }, "a");
    await r.at(local(0, 13, 1));
    const pictures = new Drawn();
    const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
    registerCommands(
      registry,
      () => r.service,
      () => pictures,
    );

    const seen: CommandReply[] = [];
    const queue: { reply: CommandReply; depth: number }[] = [];
    for (const path of PATHS) {
      const args: Record<string, string> = path.endsWith("quote") ? { code: "RICE" } : {};
      const reply = await registry.dispatch({ path: path.split(" "), args, ...who });
      queue.push({ reply, depth: 0 });
    }
    const pressed = new Set<string>();
    while (queue.length > 0) {
      const { reply, depth } = queue.shift() as { reply: CommandReply; depth: number };
      seen.push(reply);
      if (depth >= 3) continue;
      for (const b of (reply.card as Card | undefined)?.blocks ?? []) {
        const controls: ComponentInvocationData[] =
          b.type === "buttons"
            ? b.buttons
                .filter((x) => !x.disabled)
                .map((x) => ({ custom_id: x.id, message_id: "m", ...who }))
            : b.type === "select"
              ? b.select.options
                  // The first two of every select, every heat map and the 月線 of the chart's.
                  .filter((o, i) => i < 2 || o.value.startsWith("map:") || o.value === "monthly")
                  .map((o) => ({
                    custom_id: b.select.id,
                    values: [o.value],
                    message_id: "m",
                    ...who,
                  }))
              : [];
        for (const c of controls) {
          const key = `${c.custom_id}|${c.values?.[0] ?? ""}`;
          if (pressed.has(key)) continue;
          pressed.add(key);
          const out = await registry.dispatchComponent(c);
          if (!out) continue;
          if (out.result.type === "modal") {
            const m = out.result.modal;
            const fields = Object.fromEntries(
              m.fields.map((f) => [f.id, f.id === "amount" ? "1" : "1"]),
            );
            const sub = await registry.dispatchComponent({
              custom_id: m.id,
              fields,
              message_id: "m",
              ...who,
            });
            if (sub && sub.result.type !== "modal")
              queue.push({ reply: sub.result.reply, depth: depth + 1 });
            continue;
          }
          queue.push({ reply: out.result.reply, depth: depth + 1 });
        }
      }
    }
    expect(seen.length).toBeGreaterThan(10);
    for (const reply of seen) {
      expect(reply.text, reply.card?.title ?? reply.text).toContain(EXCHANGE_DISCLAIMER);
      if (reply.text.includes(LEVERAGE_CONFIRM))
        expect(reply.text).toContain(EXCHANGE_DISCLAIMER_LEVERAGE);
      if (reply.text.includes("資料來源:Yahoo"))
        expect(reply.text).toContain(EXCHANGE_DISCLAIMER_REAL);
    }
    const kinds = new Set(pictures.data.map((d) => d.kind));
    for (const k of [
      "exchange_overview",
      "exchange_quote",
      "exchange_portfolio",
      "exchange_rich",
      "exchange_receipt",
      "exchange_map",
    ])
      expect(kinds.has(k as PictureKind), k).toBe(true);
    for (const d of pictures.data)
      expect(d.data.small_print, d.kind).toContain(EXCHANGE_DISCLAIMER);
  });

  it("is under the notice card members get by DM", () => {
    expect(card("深海交易所", ["一則通知"], { real: true, leverage: true }).text).toContain(
      EXCHANGE_DISCLAIMER + EXCHANGE_DISCLAIMER_REAL + EXCHANGE_DISCLAIMER_LEVERAGE,
    );
  });
});
