// Karaoke on Discord: `/me play karaoke` (the path is `me karaoke`, which Discord shows under
// `/me play`, see `SLASH_REGROUP`) and the room notices in the comment channel. No new top-level
// command: one entry beside the coin commands that tells the caller, only them, where karaoke is
// (a link to the member site when `site_url` is set), whether it is open to them, their coins, what
// a room costs and pays, the rooms open now with a link to each (theirs first), and lets them open
// a room. Singing is on the member page; Discord only points there.
//
// - 開房 (on the notice, only when the caller may open one now and has the coins): an ephemeral
//   confirmation with the price and their coins; nothing is charged before 確定. 確定 opens the
//   room through `RoomDesk.open`, the web's own path (same charge, same refusals, one opening per
//   person at a time), and the confirmation turns into the room's code and a link to it.
//
// Every answer is a neutral system card; names are people's and are escaped.

import {
  type AnyComponentRoute,
  type CardBlock,
  type CardButton,
  type CommandRegistry,
  type CommandReply,
  ComponentResult,
  cancelled,
  cardReply,
  commandSpec,
  componentId,
  type Invocation,
  notice,
} from "@miyoria/commands";
import type { KaraokeRooms } from "@miyoria/contracts/api";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { type KaraokeConfig, siteLink } from "./config.js";
import type { RoomBrief, RoomDesk, RoomNotice } from "./rooms.js";
import { KaraokeError } from "./service.js";

const log = getLogger("karaoke.commands");

export const PATHS = ["me karaoke"] as const;

/** The coin commands' node: a role without it, like `blocked`, cannot take part. */
const NODE = "me.wallet";
/** A panel admin (the panel's own node): karaoke is open to them while it is closed to members. */
const PANEL_ACCESS = "admin.panel.access";
const OFF = "唱 K 現在沒有開";
const FAILED = "唱 K 現在打不開,等一下再試";
const TITLE = "唱 K";

/** The routes of the notice's 開房 and its confirmation. */
export const ROUTES = {
  open: "karaoke:room:open",
  yes: "karaoke:room:yes",
  no: "karaoke:room:no",
} as const;
/** A confirmation's buttons stay usable this long. */
const CONFIRM_TTL_MS = 2 * 60_000;

/** Display names come from people: no Markdown in them. */
export function md(text: string): string {
  return text.replace(/[\\*_`~|>#[\]()<@]/g, (c) => `\\${c}`);
}

const roomPath = (code: string) => `/karaoke/room/${encodeURIComponent(code)}`;

/** One room's line: its code, the song (or none yet), how many sing. */
function briefLine(room: RoomBrief): string {
  const song = room.song === null ? "還沒選歌" : `「${md(room.song.slice(0, 60))}」`;
  const state =
    room.state === "countdown" || room.state === "singing"
      ? "　正在唱"
      : room.state === "results"
        ? "　剛唱完一首"
        : "";
  return `**${room.code}**　${song}　${room.singers} / ${room.max_singers} 人唱${state}`;
}

export interface KaraokeNoticeInput {
  config: Pick<KaraokeConfig, "site_url" | "open">;
  overview: KaraokeRooms;
  rooms: readonly RoomBrief[];
  /** The caller is a panel admin (karaoke is theirs to try while closed). */
  admin: boolean;
}

/** The caller may open a room now: it is open to them, they are in none, they have the coins. */
export function mayOpen(overview: KaraokeRooms): boolean {
  if (!overview.available || overview.mine !== null) return false;
  const price = overview.terms.price;
  return price <= 0 || (overview.balance !== null && overview.balance >= price);
}

/** The answer of `/me play karaoke` (only the caller sees it). */
export function karaokeNotice(input: KaraokeNoticeInput): CommandReply {
  const { config, overview, rooms, admin } = input;
  const blocks: CardBlock[] = [];
  const mine =
    overview.mine === null ? null : (rooms.find((r) => r.code === overview.mine) ?? null);
  if (mine !== null) {
    const url = siteLink(config, roomPath(mine.code));
    const text = `你在房間裡:${briefLine(mine)}`;
    blocks.push(
      url === null
        ? { type: "text", text }
        : { type: "section", text, button: { id: "", label: "回到房間", url } },
    );
  }
  if (!config.open && admin) {
    blocks.push({ type: "text", text: "唱 K 還沒開放,只有管理員能用。" });
  } else if (!config.open) {
    blocks.push({ type: "text", text: "唱 K 現在沒有開放。" });
  }
  if (overview.available) {
    if (mine === null)
      blocks.push({ type: "text", text: "現在可以開房間,或用房號加入別人的房間。" });
  } else if (overview.reason !== null && (config.open || admin)) {
    blocks.push({ type: "text", text: `現在不能開房間:${overview.reason}。` });
  }
  const t = overview.terms;
  blocks.push({
    type: "text",
    text:
      overview.balance === null
        ? `你的${t.currency}現在看不到(她還不認識你,或錢包暫時打不開)。`
        : `你有 **${overview.balance}** ${t.currency}。`,
  });
  blocks.push({
    type: "muted",
    text: `開房 ${t.price} ${t.currency},一間包 ${t.rounds} 首、最多 ${t.max_singers} 人一起唱;每一首第一名 +${t.prize}、唱完 +${t.finish};一首都沒唱完就全退。`,
  });
  const others = rooms.filter((r) => r.code !== mine?.code);
  if (config.open || admin) {
    blocks.push({ type: "separator" });
    if (others.length === 0) {
      blocks.push({ type: "muted", text: "現在沒有其他開著的房間。" });
    } else {
      blocks.push({ type: "text", text: "**開著的房間**" });
      for (const room of others.slice(0, 10)) {
        const url = siteLink(config, roomPath(room.code));
        const text = briefLine(room);
        blocks.push(
          url === null
            ? { type: "text", text }
            : { type: "section", text, button: { id: "", label: "加入", url } },
        );
      }
    }
  }
  const buttons: CardButton[] = [];
  if (mayOpen(overview)) {
    buttons.push({ id: componentId(ROUTES.open), label: "開房", style: "primary" });
  }
  const page = siteLink(config, "/karaoke");
  if (page === null) {
    blocks.push({
      type: "muted",
      text: "唱 K 在會員頁的「唱 K」(/karaoke),用 Discord 登入就能用。",
    });
  } else {
    buttons.push({ id: "", label: "打開唱 K", url: page });
  }
  if (buttons.length > 0) blocks.push({ type: "buttons", buttons });
  return cardReply(blocks, { accent: "neutral", title: TITLE, ephemeral: true });
}

/** The confirmation before a room is opened: its price and the caller's coins, nothing charged. */
export function openConfirm(overview: KaraokeRooms): CommandReply {
  const t = overview.terms;
  const cost =
    t.price <= 0
      ? `開房不用${t.currency}`
      : `開房要 ${t.price} ${t.currency}${overview.balance === null ? "" : `,你有 ${overview.balance}`}`;
  return cardReply(
    [
      { type: "text", text: `${cost},確定?` },
      {
        type: "muted",
        text: `一間包 ${t.rounds} 首、最多 ${t.max_singers} 人一起唱;一首都沒唱完就全退。`,
      },
      {
        type: "buttons",
        buttons: [
          { id: componentId(ROUTES.yes), label: "確定", style: "primary" },
          { id: componentId(ROUTES.no), label: "取消", style: "secondary" },
        ],
      },
    ],
    {
      accent: "neutral",
      title: TITLE,
      ephemeral: true,
      // Only the one who pressed 開房 may confirm, and not after a while.
      session: { ttlMs: CONFIRM_TTL_MS, initiatorOnly: true },
    },
  );
}

/** What a confirmation turns into once the room is open: its code and where it is. */
export function openedCard(config: Pick<KaraokeConfig, "site_url">, code: string): CommandReply {
  const url = siteLink(config, roomPath(code));
  const blocks: CardBlock[] = [
    { type: "text", text: `房間開好了,房號 **${code}**。` },
    {
      type: "muted",
      text:
        url === null
          ? "到會員頁的「唱 K」(/karaoke)就會看到你的房間。"
          : "進房間後點歌,大家一起唱。",
    },
  ];
  if (url !== null) {
    blocks.push({ type: "buttons", buttons: [{ id: "", label: "進房間", url }] });
  }
  return cardReply(blocks, { accent: "neutral", title: TITLE, ephemeral: true });
}

/** A room's notice in the comment channel: its code and a 「加入」 link; 「已結束」 once closed. */
export function roomNotice(
  config: Pick<KaraokeConfig, "site_url">,
  room: RoomNotice,
): CommandReply {
  if (room.state === "ended") {
    return cardReply(
      [
        {
          type: "text",
          text: `唱 K 房間 **${room.code}** 已結束。`,
        },
        ...(room.reason === null ? [] : [{ type: "muted" as const, text: room.reason }]),
      ],
      { accent: "neutral", title: TITLE },
    );
  }
  const text = `${md(room.opener)} 開了一間唱 K 房間,房號 **${room.code}**。進房間再點歌,大家一起唱。`;
  const url = siteLink(config, roomPath(room.code));
  const blocks: CardBlock[] =
    url === null
      ? [
          { type: "text", text },
          { type: "muted", text: "在會員頁的「唱 K」輸入房號加入。" },
        ]
      : [
          { type: "text", text },
          { type: "buttons", buttons: [{ id: "", label: "加入", url }] },
        ];
  return cardReply(blocks, { accent: "neutral", title: TITLE });
}

/** A refusal in the service's own words; anything else is logged and said plainly. */
function refusal(error: unknown, what: string): CommandReply {
  if (error instanceof KaraokeError) {
    return notice(error.status >= 500 ? "warn" : "info", error.message);
  }
  log.warn({ error: errorMessage(error) }, `${what} failed`);
  return notice("warn", FAILED);
}

export interface KaraokeCommandDeps {
  rooms: () => RoomDesk | null;
  config: () => KaraokeConfig;
}

async function answer(inv: Invocation, d: KaraokeCommandDeps): Promise<CommandReply> {
  const desk = d.rooms();
  if (desk === null) return notice("info", OFF);
  try {
    const admin = await inv.allowed(PANEL_ACCESS);
    const overview = await desk.overview(inv.invoker, admin);
    return karaokeNotice({ config: d.config(), overview, rooms: desk.briefs(), admin });
  } catch (error) {
    return refusal(error, "/me play karaoke");
  }
}

function routes(d: KaraokeCommandDeps): AnyComponentRoute[] {
  return [
    {
      // 開房 on the notice: checked again now, then only a confirmation (nothing is charged).
      route: ROUTES.open,
      ephemeral: true,
      handle: async (inv) => {
        const desk = d.rooms();
        if (desk === null) return ComponentResult.reply(notice("info", OFF));
        try {
          const admin = await inv.allowed(PANEL_ACCESS);
          const overview = await desk.overview(inv.invoker, admin);
          if (!overview.available) {
            return ComponentResult.reply(notice("info", overview.reason ?? OFF));
          }
          if (overview.mine !== null) {
            return ComponentResult.reply(
              notice("info", `你已經在房間 **${overview.mine}** 裡了。`),
            );
          }
          const t = overview.terms;
          if (t.price > 0 && overview.balance !== null && overview.balance < t.price) {
            return ComponentResult.reply(
              notice("info", `開房要 ${t.price} ${t.currency},你有 ${overview.balance}`),
            );
          }
          // A stranger (no coins to see) still gets the confirmation: the wallet refuses them.
          return ComponentResult.reply(openConfirm(overview));
        } catch (error) {
          return ComponentResult.reply(refusal(error, "karaoke: 開房"));
        }
      },
    },
    {
      // 確定: the web's own opening (one per person at a time); the confirmation becomes the room.
      // A refusal is a new notice: the message may already be the room (a second press).
      route: ROUTES.yes,
      ephemeral: true,
      requiresSession: true,
      handle: async (inv) => {
        const desk = d.rooms();
        if (desk === null) return ComponentResult.reply(notice("info", OFF));
        try {
          const admin = await inv.allowed(PANEL_ACCESS);
          const room = await desk.open(inv.invoker, inv.invoker_display_name, null, 0, admin);
          return ComponentResult.update(openedCard(d.config(), room.code));
        } catch (error) {
          return ComponentResult.reply(refusal(error, "karaoke: opening a room"));
        }
      },
    },
    {
      route: ROUTES.no,
      ephemeral: true,
      handle: () => ComponentResult.update(cancelled()),
    },
  ];
}

export function registerCommands(
  registry: CommandRegistry,
  rooms: () => RoomDesk | null,
  config: () => KaraokeConfig,
): void {
  const d: KaraokeCommandDeps = { rooms, config };
  registry.register(
    commandSpec("me karaoke", "唱 K:會員頁的連結、開著的房間、開房和你的魚幣", {
      permission: NODE,
      ephemeral: true,
    }),
    (inv) => answer(inv, d),
    { components: routes(d) },
  );
}

export function unregisterCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
