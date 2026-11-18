// `/me play karaoke` and the room notices: the caller alone sees where karaoke is, whether it is
// open to them (a panel admin may use it while it is closed), their coins, the terms and the rooms
// open now with links (theirs first); without `site_url` there are no links, only where to go.

import { rm } from "node:fs/promises";
import {
  type CardBlock,
  type CardButton,
  CommandRegistry,
  type CommandReply,
  Permissions,
  splitPath,
} from "@miyoria/commands";
import type { AccountRef, ContextKey } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { registerCommands, roomNotice, unregisterCommands } from "../src/commands.js";
import type { KaraokeConfig } from "../src/config.js";
import type { RoomDesk } from "../src/rooms.js";
import { ALICE, BOB, makeRig, type Rig } from "./room-rig.js";

const SITE = "https://karaoke.example.com";
/** A panel admin (the owner here): not one of the people she knows. */
const ADMIN: AccountRef = { platform: "discord", id: "77" };
const ctx: ContextKey = { platform: "discord", scope: "111111", channel: "100", kind: "channel" };

const rigs: Rig[] = [];
async function rigWith(overrides: Partial<KaraokeConfig> = {}): Promise<Rig> {
  const r = await makeRig({ site_url: SITE, ...overrides });
  rigs.push(r);
  return r;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    r.raw.close();
    await rm(r.dir, { recursive: true, force: true });
  }
});

function registryWith(desk: RoomDesk | null, config: KaraokeConfig): CommandRegistry {
  const registry = new CommandRegistry(Permissions.fromStrings([`discord:${ADMIN.id}`]));
  registerCommands(
    registry,
    () => desk,
    () => config,
  );
  return registry;
}

function run(registry: CommandRegistry, account: AccountRef): Promise<CommandReply> {
  return registry.dispatch({
    path: ["me", "karaoke"],
    args: {},
    invoker: account,
    invoker_display_name: "x",
    context: ctx,
    invoker_is_guild_admin: false,
  });
}

const blocks = (reply: CommandReply): CardBlock[] => reply.card?.blocks ?? [];
const links = (reply: CommandReply): CardButton[] =>
  blocks(reply).flatMap((b) =>
    b.type === "section" ? [b.button] : b.type === "buttons" ? b.buttons : [],
  );

describe("/me play karaoke", () => {
  it("is under /me play on Discord and answers only the caller", async () => {
    const r = await rigWith();
    const registry = registryWith(r.desk, r.config);
    expect(registry.slashPath(splitPath("me karaoke"))).toEqual(["me", "play", "karaoke"]);
    const reply = await run(registry, BOB);
    expect(reply.ephemeral).toBe(true);
    expect(reply.card?.accent).toBe("neutral");
    unregisterCommands(registry);
    expect((await run(registry, BOB)).text).toContain("找不到指令");
  });

  it("links the page, says it is open, shows the coins, the terms and the rooms to join", async () => {
    const r = await rigWith();
    const room = await r.desk.open(ALICE, "Alice", r.songId, 0);
    const reply = await run(registryWith(r.desk, r.config), BOB);
    expect(reply.text).toContain("現在可以開房間");
    expect(reply.text).toContain("你有 **100** 魚幣");
    expect(reply.text).toContain("開房 20 魚幣,一間包 4 首、最多 8 人一起唱");
    expect(reply.text).toContain(`**${room.code}**`);
    expect(reply.text).toContain("1 / 8 人唱");
    expect(links(reply)).toEqual([
      { id: "", label: "加入", url: `${SITE}/karaoke/room/${room.code}` },
      { id: "", label: "打開唱 K", url: `${SITE}/karaoke` },
    ]);
  });

  it("leads with the caller's own room", async () => {
    const r = await rigWith();
    const room = await r.desk.open(ALICE, "Alice", r.songId, 0);
    const reply = await run(registryWith(r.desk, r.config), ALICE);
    const first = blocks(reply)[0];
    expect(first?.type).toBe("section");
    if (first?.type === "section") {
      expect(first.text).toContain(`你在房間裡:**${room.code}**`);
      expect(first.button).toMatchObject({
        label: "回到房間",
        url: `${SITE}/karaoke/room/${room.code}`,
      });
    }
    // Not listed again among the others.
    expect(reply.text).toContain("現在沒有其他開著的房間");
    expect(reply.text).toContain("你有 **80** 魚幣");
  });

  it("says it is closed to members, and open to a panel admin to try", async () => {
    const r = await rigWith({ open: false });
    const admin = await r.desk.open(ADMIN, "Admin", r.songId, 0, true).catch(() => null);
    // The admin is not someone she knows: the wallet refuses them a room that costs.
    expect(admin).toBeNull();
    const member = await run(registryWith(r.desk, r.config), BOB);
    expect(member.text).toContain("唱 K 現在沒有開放");
    expect(member.text).not.toContain("開著的房間");
    expect(member.text).not.toContain("現在可以開房間");
    const tried = await run(registryWith(r.desk, r.config), ADMIN);
    expect(tried.text).toContain("唱 K 還沒開放,只有管理員能用");
    expect(tried.text).toContain("現在可以開房間");
    expect(tried.text).toContain("現在看不到");
  });

  it("says why no room can be opened now", async () => {
    const r = await rigWith();
    r.voice.on = false;
    const reply = await run(registryWith(r.desk, r.config), BOB);
    expect(reply.text).toContain("現在不能開房間:她要在語音頻道裡才能開房間");
  });

  it("without site_url says where the page is, with no links", async () => {
    const r = await rigWith({ site_url: "" });
    await r.desk.open(ALICE, "Alice", r.songId, 0);
    const reply = await run(registryWith(r.desk, r.config), BOB);
    expect(links(reply)).toEqual([]);
    expect(reply.text).toContain("唱 K 在會員頁的「唱 K」(/karaoke)");
  });

  it("says so without the karaoke module", async () => {
    const r = await rigWith();
    expect((await run(registryWith(null, r.config), BOB)).text).toContain("沒有開");
  });
});

describe("a room's notice in the comment channel", () => {
  it("has the code and a 「加入」 link, escapes the name, and says 「已結束」 at the end", () => {
    const open = roomNotice(
      { site_url: `${SITE}/` },
      { code: "AB23CD", opener: "@everyone *x*", state: "open", reason: null },
    );
    expect(open.text).toContain("\\@everyone \\*x\\* 開了一間唱 K 房間,房號 **AB23CD**");
    expect(open.card?.blocks.at(-1)).toEqual({
      type: "buttons",
      buttons: [{ id: "", label: "加入", url: `${SITE}/karaoke/room/AB23CD` }],
    });
    expect(open.ephemeral).toBeUndefined();
    const ended = roomNotice(
      { site_url: SITE },
      { code: "AB23CD", opener: "x", state: "ended", reason: "大家都離開了" },
    );
    expect(ended.text).toContain("唱 K 房間 **AB23CD** 已結束");
    expect(ended.text).toContain("大家都離開了");
    expect(JSON.stringify(ended.card)).not.toContain("url");
    const plain = roomNotice(
      { site_url: "" },
      { code: "AB23CD", opener: "x", state: "open", reason: null },
    );
    expect(JSON.stringify(plain.card)).not.toContain("url");
    expect(plain.text).toContain("輸入房號加入");
  });
});
