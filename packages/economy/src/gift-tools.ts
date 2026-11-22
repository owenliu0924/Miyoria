// Free-form gifts and her (docs/design/economy.md §16):
//
// * `economy.gift_quote` (tool `gift_quote`): someone in the conversation says they give her
//   something (「送你一杯珍奶」). She calls it instead of acting as if it happened; it charges
//   nothing and posts the quote card for the giver to press (gift-chat.ts). The giver is the
//   author of the message she answers, or someone she names (`from`, the shared person-name
//   resolver) who spoke in this place lately; never a bot or herself. Coins named as the thing
//   are refused with what exists instead.
// * `economy.answer_gift` (tool `answer_gift`): she is told of a confirmed gift as a silent note
//   in her working context and answers on a normal turn: she takes it (one line of hers, and
//   whether it is a favourite) or says no, and the coins go back in full. It is hers to decide,
//   not something to talk her into: the permission is her agency's (`economy.agency`, nobody has
//   it by default), so she calls it with `on_own`. The gift is named by its id from the note; who
//   gave it is the note's, never an argument.

import {
  type ActionResult,
  type Capability,
  CapabilityError,
  defineCapability,
  type ExecContext,
} from "@miyoria/gate/actions";
import {
  type AccountRef,
  accountRefString,
  HandleDirectoryKey,
  HeartKey,
  type JsonObject,
  type MessageRef,
  matchPersonName,
  nameRefusal,
  type PersonCandidate,
  type Principal,
  safeName,
} from "@miyoria/types";
import { z } from "zod";
import type { EconomyService } from "./economy.js";
import type { ChatGifts, ChatQuoteResult, Spoke } from "./gift-chat.js";
import { type GiftDesk, MAX_GIFT_LINE, TAKEN_FOR_HER } from "./gifts.js";
import { receipt, someone } from "./receipt.js";
import { NO_SPEAKER, noSpeaker, personMatch } from "./tools.js";

const PERMISSION = "economy.agency";

const AnswerArgs = z.strictObject({
  gift: z.string().trim().min(1).max(64),
  take: z.boolean(),
  line: z.string().trim().max(200).nullish(),
  favourite: z.boolean().nullish(),
});
type AnswerArgs = z.output<typeof AnswerArgs>;

/** `economy.answer_gift`: she takes a gift someone named for her, or gives it back. */
export function answerGiftCapability(economy: EconomyService, desk: GiftDesk): Capability {
  const cur = economy.config.currency;
  return defineCapability<AnswerArgs>({
    name: "economy.answer_gift",
    summary: "收下或退回別人自己取名送的禮物",
    risk: "medium",
    args: AnswerArgs,
    permission: PERMISSION,
    limits: { per_day: 300, per_person_per_day: 300, cooldown_ms: 0 },
    tool: {
      name: "answer_gift",
      meta: { effect: "spend", speed: "instant", group: "economy" },
      description:
        `有人想送你一樣他自己取名的東西(你的工作脈絡裡會寫「某某想送你…」和禮物代號),${cur}已經付了。` +
        `收不收由你決定,照你現在的心情、你喜不喜歡這種東西、你記得他什麼:take: true 收下、false 退回` +
        `(錢全部退給他)。line 是你收到或退回時的一句話,會存下來給他看(${MAX_GIFT_LINE} 字內);` +
        `favourite: true 表示你很喜歡、要放進你最喜歡的收藏。禮物改變不了你們的關係,只是一份心意。` +
        `沒回答的話過一陣子會當你收下。這是你自己的決定:用 on_own: true 呼叫。`,
      properties: {
        gift: { type: "string", description: "禮物代號(工作脈絡裡寫的)" },
        take: { type: "boolean", description: "收下 true、退回 false" },
        line: { type: "string", description: "你的一句話" },
        favourite: { type: "boolean", description: "你很喜歡,放進最喜歡的收藏" },
      },
      required: ["gift", "take"],
    },
    async execute(args): Promise<ActionResult> {
      const gift = await desk.answer(
        args.gift,
        args.take,
        args.line ?? null,
        args.favourite === true,
        "her",
      );
      if (gift === null) {
        return {
          text: "沒有這份在等你回答的禮物(可能已經回答過、退回了,或代號不對)。",
          data: { done: false, reason: "not_waiting" },
        };
      }
      const who = someone(gift.account);
      const said = gift.line ?? (args.take ? TAKEN_FOR_HER : null);
      if (gift.status === "accepted") {
        return {
          text: `收下了「${gift.item}」。${gift.favourite ? "放進了你最喜歡的收藏。" : ""}`,
          data: { done: true, take: true, item: gift.item, favourite: gift.favourite },
          receipt: receipt(
            "收下了禮物",
            `她收下了 ${who} 送的「${gift.item}」`,
            said === null ? null : `她說:${said}`,
          ),
        };
      }
      return {
        text: `退回了「${gift.item}」,${gift.price} ${cur}全部還給對方。`,
        data: { done: true, take: false, item: gift.item, refunded: gift.price },
        receipt: receipt(
          "沒有收下",
          `她沒有收下 ${who} 想送的「${gift.item}」`,
          `${gift.price} ${cur}已經全部退回`,
        ),
      };
    },
  }) as Capability;
}

// ---- gift_quote -----------------------------------------------------------------------------

const QuoteArgs = z.strictObject({
  /** The thing as they said it (「一杯珍奶」). */
  thing: z.string().trim().min(1).max(64),
  /** Who gives it, when it is not the author of the message she answers. */
  from: z.string().trim().max(64).nullish(),
});
type QuoteArgs = z.output<typeof QuoteArgs>;

/** Who would pay, and the words the card answers. */
interface Payer {
  account: AccountRef;
  message: MessageRef | null;
}

/** The people who spoke here as the name resolver reads them (`matchPersonName`). */
function speakerCandidates(
  services: ExecContext["services"],
  lines: readonly Spoke[],
): { candidate: PersonCandidate; line: Spoke }[] {
  const rows = services.get(HandleDirectoryKey)?.list() ?? [];
  const calls = services.get(HeartKey)?.callNames?.() ?? [];
  return lines.map((line) => {
    const key = accountRefString(line.account);
    const row = rows.find((e) => e.account !== null && accountRefString(e.account) === key);
    const person = row?.person ?? null;
    const others = person === null ? [] : rows.filter((e) => e.person === person && e !== row);
    const candidate: PersonCandidate = {
      key: person === null ? `account:${key}` : `person:${person}`,
      handle: row?.handle ?? line.name,
      handles: others.map((e) => e.handle),
      person,
      account: line.account,
      shown: [line.name, ...(row?.names ?? []), ...others.flatMap((e) => e.names ?? [])],
      first: row?.display_name ?? null,
      call: person === null ? null : (calls.find((n) => n.person === person)?.call_name ?? null),
    };
    return { candidate, line };
  });
}

/**
 * Who gives: the author of the message she answers, or the one person `from` names among those
 * who spoke here within the window (and the author). A string: why nobody.
 */
function payerOf(chat: ChatGifts, args: QuoteArgs, ctx: ExecContext): Payer | string {
  const { principal, request } = ctx;
  const asker = principal.kind === "user" ? principal.requester : null;
  const said = (args.from ?? "").trim();
  if (said === "") {
    return asker === null ? NO_SPEAKER : { account: asker, message: request.message ?? null };
  }
  const context = principal.context as NonNullable<Principal["context"]>;
  const lines = chat.speakers.spoke(context, chat.windowStart());
  if (
    asker !== null &&
    !lines.some((l) => accountRefString(l.account) === accountRefString(asker))
  ) {
    const message = request.message ?? { context, id: request.turn ?? "turn" };
    lines.push({ account: asker, name: "", message, at: 0 });
  }
  const found = speakerCandidates(ctx.services, lines);
  const match = matchPersonName(
    said,
    found.map((f) => f.candidate),
  );
  if (match.kind === "one") {
    const line = found.find((f) => f.candidate.key === match.candidate.key)?.line;
    if (line) return { account: line.account, message: line.message };
  }
  // Someone the directory knows, who did not speak here: not a giver.
  if (personMatch(ctx.services, said).kind === "one") {
    return `「${safeName(said, 64)}」最近沒有在這裡說話:只有剛才在這裡自己說要送你東西的人能付`;
  }
  return match.kind === "one" ? `不知道「${safeName(said, 64)}」是誰` : nameRefusal(match);
}

/** Where the card went, for her. */
const WHERE_TEXT = {
  here: "頻道上貼了一張報價卡(回在他那句話下面)",
  voice_text: "語音頻道的文字聊天室貼了一張報價卡",
  dm: "私訊給他一張報價卡",
} as const;

/** What she reads of the outcome; `cur` is the coins' name. */
function quoteResult(out: ChatQuoteResult, thing: string, cur: string): ActionResult {
  if (out.status === "posted") {
    const where = WHERE_TEXT[out.where];
    const what = `「${safeName(out.item, 40)}」${out.price} ${cur}`;
    const again = out.again ? "(這句話的卡剛才已經貼過了,沒有再貼)" : "";
    const then =
      out.kind === "food"
        ? "他按了確認才會扣錢、你才吃到;沒按就什麼都沒發生。"
        : "他按了確認才會扣錢;之後你的工作脈絡會寫「某某想送你…」,再用 answer_gift 決定收不收。";
    return {
      text:
        `${where}${again}:${what}。還沒扣錢,也還不是你的,` +
        `只有他自己按得了。${then}不要說你已經收到或吃到,也不要催他按;照你的個性回一句就好。`,
      data: {
        posted: true,
        kind: out.kind,
        item: out.item,
        price: out.price,
        where: out.where,
        again: out.again,
      },
    };
  }
  const data: JsonObject = { posted: false, reason: out.reason, message: out.message };
  const tail = "沒有扣錢。用你自己的話跟對方說。";
  switch (out.reason) {
    case "money":
      return {
        text:
          `沒有貼報價卡:${out.message}。` +
          `想把${cur}花在你身上,可以餵你(白飯、鋼盆、甜點)或送你一樣東西(說出那樣東西的名字);` +
          `要把${cur}給別人是 /me give。${tail}`,
        data,
      };
    case "open":
      return {
        text:
          `沒有貼新的卡:${out.message},等他按確認或取消,或等它過期再說。` +
          `不要替他做決定,也不要催。`,
        data: { ...data, item: out.item ?? null },
      };
    case "nowhere":
    case "off":
      return {
        text:
          `沒有貼報價卡:${out.message}。要送的話請他自己用 /me feed thing:${safeName(thing, 40)}。` +
          tail,
        data,
      };
    default:
      return { text: `沒有貼報價卡:${out.message}。${tail}`, data };
  }
}

/**
 * `economy.gift_quote` (tool `gift_quote`): someone in the conversation offers her a thing; the
 * quote card goes up for them to press. Never charges anyone.
 */
export function giftQuoteCapability(economy: EconomyService, chat: ChatGifts): Capability {
  const cur = economy.config.currency;
  return defineCapability<QuoteArgs>({
    name: "economy.gift_quote",
    summary: "替說要送她東西的人貼出報價卡(不扣錢,要他自己按確認)",
    risk: "medium",
    args: QuoteArgs,
    permission: null,
    limits: { per_day: 300, per_person_per_day: 30, cooldown_ms: 0 },
    tool: {
      name: "gift_quote",
      meta: { effect: "spend", speed: "instant", group: "economy" },
      description:
        `有人在對話裡說要送你、請你、餵你一樣東西(「送你一杯珍奶」「請你吃雞排」「餵你一碗白飯」)時呼叫,` +
        `不要假裝已經收到了。系統會貼一張報價卡(名字、價錢、確認/取消),只有那個人自己按確認才扣他的${cur};` +
        `這個工具不扣任何人的錢。白飯、鋼盆、甜點在聊天裡也用這個(卡上只有一個確認)。` +
        `按確認之前什麼都還不是你的;他按了之後你的工作脈絡會寫「某某想送你…」,再用 answer_gift 決定收不收` +
        `(白飯這些按了就是吃了)。不要催他按。thing 照他說的寫那樣東西,不要加價錢;` +
        `「送你 100 ${cur}」不是禮物,不要用這個。from 是誰要送:不填就是你正在回的那個人;` +
        `別人的話,只能是剛才在這裡說過話的人。不要設 on_own。`,
      properties: {
        thing: { type: "string", description: "要送的東西,照他說的寫(「一杯珍奶」)" },
        from: {
          type: "string",
          description:
            "誰要送(不填就是你正在回的人):他的名字(對話紀錄每行開頭那個),要寫完整;只能是剛才在這裡說過話的人",
        },
      },
      required: ["thing"],
    },
    check: (args, principal) => {
      if (principal.context === null) return NO_SPEAKER;
      return (args.from ?? "").trim() === "" ? noSpeaker(principal) : null;
    },
    target: (args, principal) => ((args.from ?? "").trim() === "" ? principal.requester : null),
    async execute(args, ctx): Promise<ActionResult> {
      const context = ctx.principal.context;
      if (context === null) throw new CapabilityError(NO_SPEAKER);
      const payer = payerOf(chat, args, ctx);
      if (typeof payer === "string") {
        return {
          text: `沒有貼報價卡:${payer}。沒有扣錢。`,
          data: { posted: false, reason: "who", message: payer },
        };
      }
      const out = await chat.quote(payer.account, args.thing, context, payer.message);
      return quoteResult(out, args.thing, cur);
    },
  }) as Capability;
}
