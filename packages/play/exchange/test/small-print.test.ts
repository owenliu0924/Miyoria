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
import { discordProblems, modalProblems } from "./discord-limits.js";
import { ALICE, BOB, local, rig } from "./rig.js";

const ctx: ContextKey = { platform: "discord", scope: "g", channel: "100", kind: "channel" };

/** A renderer that draws (a file named by its index) or fails, and remembers each picture's data. */
class Drawn implements Pictures {
  readonly data: { kind: PictureKind; data: { small_print: string } }[] = [];
  constructor(private readonly draws: boolean) {}
  async render<K extends PictureKind>(
    kind: K,
    data: PictureDataMap[K],
  ): Promise<PictureFile | null> {
    this.data.push({ kind, data: data as unknown as { small_print: string } });
    if (!this.draws) return null;
    return {
      name: `pic-${this.data.length - 1}.png`,
      data: new Uint8Array([1]),
      contentType: "image/png",
      alt: kind,
      artifact_id: null,
    };
  }
  async forMember() {
    return null;
  }
}

/** The small print a message shows: its card's own text, and what its pictures end with. */
function printed(reply: CommandReply, pictures: Drawn): { card: string; drawn: string[] } {
  const blocks = (reply.card as Card | undefined)?.blocks ?? [];
  const card = blocks
    .flatMap((b) => (b.type === "text" || b.type === "muted" ? [b.text] : []))
    .join("\n");
  const drawn = blocks.flatMap((b) => {
    if (b.type !== "image") return [];
    const i = Number(/^pic-(\d+)\.png$/.exec(b.name)?.[1]);
    const d = pictures.data[i];
    return d ? [d.data.small_print] : [];
  });
  return { card: reply.card ? card : reply.text, drawn };
}

/**
 * Walks every command and every control on every reply it reaches (a few levels deep, modals
 * submitted), as `invoker`; every reply and modal is checked against Discord's limits on the way.
 */
async function walk(
  draws: boolean,
  invoker: typeof ALICE,
  name: string,
): Promise<{ seen: CommandReply[]; pictures: Drawn }> {
  const r = await rig({ open: true });
  r.wallet.fund(ALICE, 500);
  r.wallet.fund(BOB, 500);
  await r.service.openAccount(ALICE);
  await r.at(local(0, 12, 30));
  await r.service.real.place(ALICE, { side: "buy", code: "RICE", shares: 1 }, "a");
  await r.at(local(0, 13, 1));
  // A waiting order (its cancel button), placed after the day's last tick.
  await r.at(local(0, 23, 30));
  await r.service.real.place(ALICE, { side: "buy", code: "WHLE", shares: 1 }, "b");
  const pictures = new Drawn(draws);
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1", "discord:2"]));
  registerCommands(
    registry,
    () => r.service,
    () => pictures,
  );
  const who = { ...base, invoker, invoker_display_name: name };
  const seen: CommandReply[] = [];
  const queue: { reply: CommandReply; depth: number }[] = [];
  const check = (reply: CommandReply) =>
    expect(discordProblems(reply), reply.card?.title ?? reply.text).toEqual([]);
  for (const path of PATHS) {
    const args: Record<string, string> = path.endsWith("quote") ? { code: "RICE" } : {};
    const reply = await registry.dispatch({ path: path.split(" "), args, ...who });
    queue.push({ reply, depth: 0 });
  }
  const pressed = new Set<string>();
  while (queue.length > 0) {
    const { reply, depth } = queue.shift() as { reply: CommandReply; depth: number };
    seen.push(reply);
    check(reply);
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
          expect(modalProblems(m), m.title).toEqual([]);
          // Each form of the one amount: shares, coins, and garbage (the line with both forms).
          for (const amount of ["1", "$50", "全部", "三股"]) {
            const fields = Object.fromEntries(
              m.fields.map((f) => [f.id, f.id === "amount" ? amount : "1"]),
            );
            const sub = await registry.dispatchComponent({
              custom_id: m.id,
              fields,
              message_id: "m",
              ...who,
            });
            if (sub && sub.result.type !== "modal")
              queue.push({ reply: sub.result.reply, depth: depth + 1 });
          }
          continue;
        }
        queue.push({ reply: out.result.reply, depth: depth + 1 });
      }
    }
  }
  return { seen, pictures };
}

const base = {
  context: ctx,
  invoker_is_guild_admin: false,
};

describe("the small print", () => {
  for (const [draws, invoker, name] of [
    [true, ALICE, "Alice"],
    [false, ALICE, "Alice"],
    [true, BOB, "Bob"],
  ] as const) {
    it(`is on every message the commands and their controls reach, once (${name}, pictures ${draws ? "drawn" : "failing"})`, async () => {
      const { seen, pictures } = await walk(draws, invoker, name);
      expect(seen.length).toBeGreaterThan(10);
      for (const reply of seen) {
        const where = reply.card?.title ?? reply.text;
        const { card, drawn } = printed(reply, pictures);
        const all = [card, ...drawn].join("\n");
        // Present at least once per message, in the card or in its picture.
        expect(all, where).toContain(EXCHANGE_DISCLAIMER);
        // Not the identical sentence twice: a drawn picture already says it.
        if (drawn.some((d) => d.includes(EXCHANGE_DISCLAIMER)))
          expect(card, where).not.toContain(EXCHANGE_DISCLAIMER);
        // The plain text (where a picture cannot go) always has it.
        expect(reply.text, where).toContain(EXCHANGE_DISCLAIMER);
        if (all.includes(LEVERAGE_CONFIRM))
          expect(all, where).toContain(EXCHANGE_DISCLAIMER_LEVERAGE);
        if (card.includes("資料來源:Yahoo")) expect(all, where).toContain(EXCHANGE_DISCLAIMER_REAL);
      }
      const kinds = new Set(pictures.data.map((d) => d.kind));
      for (const k of [
        "exchange_overview",
        "exchange_quote",
        "exchange_map",
        "exchange_rich",
        // Bob has no trades to draw.
        ...(invoker === ALICE ? ["exchange_portfolio", "exchange_receipt"] : []),
      ])
        expect(kinds.has(k as PictureKind), k).toBe(true);
      for (const d of pictures.data)
        expect(d.data.small_print, d.kind).toContain(EXCHANGE_DISCLAIMER);
      // Bob had no account: the walk reached the 開戶 card and went on after it.
      if (invoker === BOB) expect(seen.some((x) => x.text.includes("開戶不花錢"))).toBe(true);
    });
  }

  it("is under the notice card members get by DM", () => {
    expect(card("深海交易所", ["一則通知"], { real: true, leverage: true }).text).toContain(
      EXCHANGE_DISCLAIMER + EXCHANGE_DISCLAIMER_REAL + EXCHANGE_DISCLAIMER_LEVERAGE,
    );
  });
});
