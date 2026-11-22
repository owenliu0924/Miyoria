// Each member's colours of up and down (owner 2026-11-22): 紅漲綠跌 or 綠漲紅跌, kept with the
// person's other choices (`exchange_colors:<platform>:<id>` under `_global`, which the store keeps in
// `persons.prefs`), the install's `colors` until they choose. Every picture drawn for a member is in
// their colours, also one they share; one nobody asked for is in the install's. The choice is made
// from the overview's last select, no new command. Every name here is made up.

import {
  type Card,
  CommandRegistry,
  type CommandReply,
  type ComponentInvocationData,
  type ComponentOutcome,
  Permissions,
} from "@miyoria/commands";
import { MemorySettingsStore } from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  EXCHANGE_COLOR_WORDS,
  type PictureDataMap,
  type PictureFile,
  type PictureKind,
  type Pictures,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { NOT_YOURS, registerCommands } from "../src/commands.js";
import { mapPictureData, overviewPictureData, quotePictureData } from "../src/pictures.js";
import { discordProblems } from "./discord-limits.js";
import { ALICE, ALICE_ALT, BOB, local, rig, STRANGER } from "./rig.js";

const ctx: ContextKey = { platform: "discord", scope: "g", channel: "100", kind: "channel" };
const as = (who: AccountRef, name: string) => ({
  invoker: who,
  invoker_display_name: name,
  context: ctx,
  invoker_is_guild_admin: false,
});

class Drawn implements Pictures {
  readonly drawn: { kind: PictureKind; colors: unknown; by: string }[] = [];
  by = "";
  async render<K extends PictureKind>(kind: K, data: PictureDataMap[K]): Promise<PictureFile> {
    this.drawn.push({ kind, colors: (data as { colors?: unknown }).colors, by: this.by });
    return {
      name: `${kind}.png`,
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

const blocks = (r: CommandReply) => (r.card as Card | undefined)?.blocks ?? [];
const selects = (r: CommandReply) =>
  blocks(r).flatMap((b) => (b.type === "select" ? [b.select] : []));
const buttons = (r: CommandReply) =>
  blocks(r).flatMap((b) => (b.type === "buttons" ? b.buttons : []));
const replyOf = (o: ComponentOutcome | null): CommandReply => {
  if (!o || o.result.type === "modal") throw new Error("not a reply");
  return o.result.reply;
};
const colorSelect = (r: CommandReply) => {
  const s = selects(r).find((x) => x.id.includes(":xm:colors:"));
  if (!s) throw new Error("no colour select");
  return s;
};

async function world(settings = new MemorySettingsStore(), more = {}) {
  const r = await rig({ open: true, ...more }, undefined, { settings: () => settings });
  r.wallet.fund(ALICE, 500);
  r.wallet.fund(BOB, 500);
  await r.service.openAccount(ALICE);
  await r.service.openAccount(BOB);
  await r.at(local(0, 12, 30));
  await r.service.real.place(ALICE, { side: "buy", code: "RICE", shares: 1 }, "k");
  await r.at(local(0, 13, 1));
  return { r, settings };
}

describe("a member's colours of up and down", () => {
  it("are the install's until chosen, kept with the person's choices, read back, and an unknown value is refused", async () => {
    const { r, settings } = await world();
    const x = r.service;
    expect(await x.colorsView(ALICE)).toEqual({ colors: "tw", chosen: null, default: "tw" });
    const set = await x.setColors(ALICE, "us");
    expect(set).toMatchObject({ ok: true, colors: "us", chosen: "us", default: "tw" });
    // Where the store keeps a person's choices (`persons.prefs` behind this key).
    expect(await settings.get("_global", "exchange_colors:discord:1")).toBe("us");
    // A new process reads it back; another member is untouched.
    const again = r.restart();
    expect(await again.colorsOf(ALICE)).toBe("us");
    expect(await again.colorsOf(BOB)).toBe("tw");
    // Nothing else is a choice: refused, and the choice stays.
    for (const bad of ["green", "", "TW", 1, { colors: "us" }]) {
      expect(await again.setColors(ALICE, bad)).toMatchObject({ ok: false, status: 400 });
    }
    expect(await again.colorsOf(ALICE)).toBe("us");
    // Someone she does not know cannot choose.
    expect(await again.setColors(STRANGER, "us")).toMatchObject({ ok: false, status: 403 });
    // Cleared: back to the install's default, whatever it is.
    const greenUp = r.restart({ colors: "us" });
    expect(await greenUp.colorsOf(BOB)).toBe("us");
    expect(await greenUp.setColors(ALICE, null)).toMatchObject({ ok: true, chosen: null });
    expect(await greenUp.colorsView(ALICE)).toEqual({ colors: "us", chosen: null, default: "us" });
    // Nobody asking: the install's.
    expect(await greenUp.colorsOf(null)).toBe("us");
  });

  it("fall back to the install's when the store cannot answer, and live in memory without one", async () => {
    const broken = {
      get: async () => {
        throw new Error("down");
      },
      set: async () => undefined,
    };
    const r = await rig({ open: true }, undefined, { settings: () => broken });
    expect(await r.service.colorsOf(ALICE)).toBe("tw");
    // No settings store at all: kept per person, so both of Alice's accounts read it.
    const plain = await rig({ open: true });
    expect(await plain.service.setColors(ALICE, "us")).toMatchObject({ ok: true });
    expect(await plain.service.colorsOf(ALICE_ALT)).toBe("us");
    expect(await plain.service.colorsOf(BOB)).toBe("tw");
  });

  it("are chosen from the overview's last select (no new command), at once for the next picture", async () => {
    const { r } = await world();
    const pictures = new Drawn();
    const registry = new CommandRegistry(Permissions.fromStrings(["discord:1", "discord:2"]));
    registerCommands(
      registry,
      () => r.service,
      () => pictures,
    );
    const alice = as(ALICE, "Alice");
    const overview = await registry.dispatch({
      path: ["me", "market", "overview"],
      args: {},
      ...alice,
    });
    expect(discordProblems(overview)).toEqual([]);
    const select = colorSelect(overview);
    // The two options in words, the current one chosen, the install's marked.
    expect(select.options.map((o) => [o.value, o.label, o.default])).toEqual([
      ["tw", `漲跌顏色:${EXCHANGE_COLOR_WORDS.tw}`, true],
      ["us", `漲跌顏色:${EXCHANGE_COLOR_WORDS.us}`, false],
    ]);
    expect(select.options[0]?.description).toBe("沒有選的時候用這個");
    // Bob's press on Alice's panel changes nothing.
    const bob = as(BOB, "Bob");
    const foreign = replyOf(
      await registry.dispatchComponent({
        custom_id: select.id,
        values: ["us"],
        message_id: "m",
        ...bob,
      }),
    );
    expect(foreign.text).toContain(NOT_YOURS);
    expect(await r.service.colorsOf(BOB)).toBe("tw");
    pictures.drawn.length = 0;
    const changed = replyOf(
      await registry.dispatchComponent({
        custom_id: select.id,
        values: ["us"],
        message_id: "m",
        ...alice,
      }),
    );
    expect(discordProblems(changed)).toEqual([]);
    expect(changed.text).toContain(`漲跌顏色改成${EXCHANGE_COLOR_WORDS.us}`);
    expect(changed.text).toContain("▲▼");
    expect(colorSelect(changed).options.find((o) => o.default)?.value).toBe("us");
    // The overview picture drawn right away is green up.
    expect(pictures.drawn).toEqual([{ kind: "exchange_overview", colors: "us", by: "" }]);
    expect(await r.service.colorsOf(ALICE)).toBe("us");
    // A value that is not one of the two is refused in words, and nothing changes.
    const bad = replyOf(
      await registry.dispatchComponent({
        custom_id: colorSelect(changed).id,
        values: ["purple"],
        message_id: "m",
        ...alice,
      }),
    );
    expect(bad.text).toContain("漲跌顏色只能選");
    expect(await r.service.colorsOf(ALICE)).toBe("us");
  });

  it("colour every picture drawn for a member their way, a shared one too, and nobody's in the install's", async () => {
    const { r } = await world();
    await r.service.setColors(ALICE, "us");
    const pictures = new Drawn();
    const registry = new CommandRegistry(Permissions.fromStrings(["discord:1", "discord:2"]));
    registerCommands(
      registry,
      () => r.service,
      () => pictures,
    );
    const alice = as(ALICE, "Alice");
    const bob = as(BOB, "Bob");
    const run = async (who: typeof alice) => {
      pictures.by = who.invoker_display_name;
      const o = await registry.dispatch({ path: ["me", "market", "overview"], args: {}, ...who });
      // A ticker's card (its candle chart), then a heat map from the list select.
      const pick = selects(o).find((s) => s.id.includes(":xm:pick:"));
      await registry.dispatchComponent({
        custom_id: pick?.id ?? "",
        values: ["RICE"],
        message_id: "m",
        ...who,
      });
      const lists = selects(o).find((s) => s.id.includes(":xm:list:"));
      for (const map of ["map:holdings", "map:tw"])
        await registry.dispatchComponent({
          custom_id: lists?.id ?? "",
          values: [map],
          message_id: "m",
          ...who,
        });
      const mine = await registry.dispatch({ path: ["me", "market", "mine"], args: {}, ...who });
      return mine;
    };
    const mine = await run(alice);
    await run(bob);
    const by = (name: string) => pictures.drawn.filter((d) => d.by === name);
    const kinds = new Set(by("Alice").map((d) => d.kind));
    for (const k of ["exchange_overview", "exchange_quote", "exchange_map", "exchange_portfolio"])
      expect(kinds.has(k as PictureKind), k).toBe(true);
    // Alice chose green up; Bob did not, so his are the install's red up.
    expect(new Set(by("Alice").map((d) => d.colors))).toEqual(new Set(["us"]));
    expect(new Set(by("Bob").map((d) => d.colors))).toEqual(new Set(["tw"]));
    // Shared where everyone sees it: still the colours of the member who shared it.
    pictures.by = "Alice shares";
    const share = buttons(mine).find((b) => b.label === "分享持股");
    const posted = replyOf(
      await registry.dispatchComponent({
        custom_id: share?.id ?? "",
        message_id: "m",
        ...alice,
      } as ComponentInvocationData),
    );
    expect(posted.ephemeral).toBe(false);
    expect(by("Alice shares")).toEqual([
      { kind: "exchange_portfolio", colors: "us", by: "Alice shares" },
    ]);
    // A picture made with nobody asking (a scheduled post, her own share): the install's.
    const now = r.clock.at;
    expect(overviewPictureData(r.service, now).colors).toBe("tw");
    expect(mapPictureData(r.service, r.service.real.map("tw", false), now).colors).toBe("tw");
    const set = await r.service.real.candles("RICE", "daily", false);
    if (!set) throw new Error("no candles");
    expect(quotePictureData(r.service, set).colors).toBe("tw");
    expect(quotePictureData(r.service, set, await r.service.colorsOf(ALICE)).colors).toBe("us");
  });
});
