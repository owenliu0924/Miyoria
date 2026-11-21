// `/me market …`: every answer is a neutral card with a picture above it when one can be drawn;
// `mine` is only for the person asking; nothing works while the market is off.

import { CommandRegistry, Permissions } from "@miyoria/commands";
import type {
  ContextKey,
  PictureDataMap,
  PictureFile,
  PictureKind,
  Pictures,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { registerCommands } from "../src/commands.js";
import type { ExchangeService } from "../src/service.js";
import { ALICE, BOB, local, rig } from "./rig.js";

const ctx: ContextKey = { platform: "discord", scope: "g", channel: "100", kind: "channel" };
const who = {
  invoker: ALICE,
  invoker_display_name: "Alice",
  context: ctx,
  invoker_is_guild_admin: false,
};

class FakePictures implements Pictures {
  readonly drawn: PictureKind[] = [];
  async render<K extends PictureKind>(
    kind: K,
    _data: PictureDataMap[K],
  ): Promise<PictureFile | null> {
    this.drawn.push(kind);
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
  it("answers with pictures, and mine only to the person asking", async () => {
    const r = await rig();
    r.wallet.fund(ALICE, 500);
    r.wallet.fund(BOB, 500);
    await r.service.openAccount(ALICE);
    await r.service.place(ALICE, { side: "buy", company: "RICE", coins: 100 }, "a");
    await r.at(local(0, 12, 1));
    const pictures = new FakePictures();
    const registry = registryWith(r.service, pictures);
    expect(registry.groupDescription("me market")).toContain("交易所");
    const quote = await registry.dispatch({
      path: ["me", "market", "quote"],
      args: { code: "RICE" },
      ...who,
    });
    expect(quote.card?.title).toContain("RICE");
    const mine = await registry.dispatch({ path: ["me", "market", "mine"], args: {}, ...who });
    expect(mine.ephemeral).toBe(true);
    expect(mine.text).toContain("RICE");
    await registry.dispatch({ path: ["me", "market", "day"], args: {}, ...who });
    await registry.dispatch({ path: ["me", "market", "rich"], args: {}, ...who });
    await registry.dispatch({ path: ["me", "market", "volume"], args: {}, ...who });
    expect(pictures.drawn).toEqual([
      "exchange_quote",
      "exchange_portfolio",
      "exchange_day",
      "exchange_rich",
      "exchange_volume",
    ]);
    // Without a renderer the text card is all there is.
    const plain = await registryWith(r.service, null).dispatch({
      path: ["me", "market", "day"],
      args: {},
      ...who,
    });
    expect(plain.files ?? []).toHaveLength(0);
  });

  it("says the market is off while it is", async () => {
    const r = await rig({});
    const reply = await registryWith(r.service, null).dispatch({
      path: ["me", "market", "day"],
      args: {},
      ...who,
    });
    expect(reply.text).toContain("交易所現在沒有開");
  });
});
