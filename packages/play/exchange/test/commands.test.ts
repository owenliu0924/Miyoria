// `/me market …`: every answer is a neutral card with the small print under it and a picture above
// it when one can be drawn; the five local stocks come first in the overview; `mine` is only for
// the person asking; nothing works while the market is off.

import { CommandRegistry, Permissions } from "@miyoria/commands";
import {
  type ContextKey,
  EXCHANGE_DISCLAIMER,
  EXCHANGE_DISCLAIMER_REAL,
  type PictureDataMap,
  type PictureFile,
  type PictureKind,
  type Pictures,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { registerCommands } from "../src/commands.js";
import type { ExchangeService } from "../src/service.js";
import { ALICE, local, rig } from "./rig.js";

const ctx: ContextKey = { platform: "discord", scope: "g", channel: "100", kind: "channel" };
const who = {
  invoker: ALICE,
  invoker_display_name: "Alice",
  context: ctx,
  invoker_is_guild_admin: false,
};

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

function registryWith(service: ExchangeService, pictures: Pictures | null) {
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
  registerCommands(
    registry,
    () => service,
    () => pictures,
  );
  return registry;
}

describe("/me market", () => {
  it("answers with pictures and the small print, local stocks first, mine only to the person asking", async () => {
    const r = await rig({ open: true });
    r.wallet.fund(ALICE, 500);
    await r.service.openAccount(ALICE);
    await r.at(local(0, 12, 30));
    expect(
      await r.service.real.place(ALICE, { side: "buy", code: "RICE", shares: 1 }, "a"),
    ).toMatchObject({ ok: true });
    await r.at(local(0, 13, 1));
    const pictures = new FakePictures();
    const registry = registryWith(r.service, pictures);
    expect(registry.groupDescription("me market")).toContain("交易所");

    const overview = await registry.dispatch({
      path: ["me", "market", "overview"],
      args: {},
      ...who,
    });
    expect(overview.text?.indexOf("新手推薦")).toBeLessThan(overview.text?.indexOf("RICE") ?? -1);
    expect(overview.text).toContain(EXCHANGE_DISCLAIMER);

    const quote = await registry.dispatch({
      path: ["me", "market", "quote"],
      args: { code: "rice" },
      ...who,
    });
    expect(quote.card?.title).toContain("RICE");
    expect(quote.text).toContain(EXCHANGE_DISCLAIMER);
    // A local stock is not a real quote: no data-source line.
    expect(quote.text).not.toContain(EXCHANGE_DISCLAIMER_REAL);

    const mine = await registry.dispatch({ path: ["me", "market", "mine"], args: {}, ...who });
    expect(mine.ephemeral).toBe(true);
    expect(mine.text).toContain("RICE");
    await registry.dispatch({ path: ["me", "market", "rich"], args: {}, ...who });
    expect(pictures.drawn.map((d) => d.kind)).toEqual([
      "exchange_quote",
      "exchange_portfolio",
      "exchange_rich",
    ]);
    for (const d of pictures.drawn)
      expect((d.data as { small_print: string }).small_print).toContain(EXCHANGE_DISCLAIMER);

    // Without a renderer the text card is all there is.
    const plain = await registryWith(r.service, null).dispatch({
      path: ["me", "market", "rich"],
      args: {},
      ...who,
    });
    expect(plain.files ?? []).toHaveLength(0);
    expect(plain.text).toContain(EXCHANGE_DISCLAIMER);
  });

  it("says the market is off while it is, with the small print", async () => {
    const r = await rig({});
    const reply = await registryWith(r.service, null).dispatch({
      path: ["me", "market", "overview"],
      args: {},
      ...who,
    });
    expect(reply.text).toContain("交易所現在沒有開");
    expect(reply.text).toContain(EXCHANGE_DISCLAIMER);
  });
});
