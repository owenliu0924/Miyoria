// The raw record of conversation (docs/design/v5-data.md §2.3, §2.7): every chat line, people's
// text and voice and hers too (her echoed messages, her spoken sentences), written to the event
// log as one chat event each through the store's `ChatLogStore`.
//
// The facts module is the one writer from the bus to the event log: its lines (observations, her
// decisions, how each turn ended) and these chat lines all come from its subscriptions, so each
// line is stored once whatever publishes it (both Discord connections deliver the same message,
// the terminal chat, the voice room). Her observations of the same messages are hers, a derived
// view under the same key.
//
// Also here, as they go with the lines:
// - "do not remember this" (`agent.message.excluded`): the message's events (its line and her
//   observations of it) are redacted, so every reader of the log stops seeing it;
// - the people table: whoever wrote or spoke is recorded, and her stable name for them is fixed
//   the first time she sees them.

import { errorMessage, type ModuleContext, type Subscription } from "@miyoria/runtime/kernel";
import { logEntryFromIncoming, type Store } from "@miyoria/store";
import {
  type AccountRef,
  HandleDirectoryKey,
  type IncomingMessage,
  isJsonObject,
  MESSAGE_EXCLUDED_TOPIC,
  type MessageRef,
  newId,
  type ProfileId,
  sameAccount,
  type TurnId,
} from "@miyoria/types";

/** What the chat record writes to: the chat events, or a message log without them (test doubles). */
export type ChatRecordStore = Pick<Store, "chat"> & Partial<Pick<Store, "messages" | "people">>;

/** The topics the chat record reads. */
export const CHAT_RECORD_TOPICS: readonly string[] = [
  "platform.ready",
  "platform.message.created",
  "voice.utterance",
  "voice.playback",
  MESSAGE_EXCLUDED_TOPIC,
];

/** Writes every chat line `sub` delivers, one at a time, until it ends. */
export async function recordChat(
  ctx: ModuleContext,
  store: ChatRecordStore,
  profile: ProfileId,
  sub: Subscription,
): Promise<void> {
  const own: AccountRef[] = [];
  for await (const env of sub) {
    const event = env.event;
    switch (event.type) {
      case "platform_ready": {
        const account = event.data.self_account;
        if (!own.some((a) => sameAccount(a, account))) own.push(account);
        break;
      }
      case "platform_message_created": {
        const msg = event.data;
        const isSelf = own.some((a) => sameAccount(a, msg.author.account));
        await line(ctx, async () => {
          const options = { self: isSelf, turn: env.correlation, source: env.source };
          if (store.chat) await store.chat.message(msg, options);
          else await store.messages?.append(entry(profile, msg, isSelf, env.correlation));
        });
        if (!isSelf) await person(ctx, store, msg);
        break;
      }
      case "voice_utterance": {
        const u = event.data;
        const msg: IncomingMessage = {
          id: { context: u.context, id: u.id },
          author: u.speaker,
          text: u.text,
          mentions_self: false,
          reply_to_self: false,
          attachments: [],
          ts: u.ended_at,
        };
        await line(ctx, async () => {
          const options = { turn: env.correlation, source: env.source };
          if (store.chat) await store.chat.utterance(u, options);
          else await store.messages?.append(entry(profile, msg, false, env.correlation));
        });
        await person(ctx, store, msg);
        break;
      }
      case "voice_playback": {
        const playback = event.data;
        if (playback.state !== "started") break;
        const account = own.find((a) => a.platform === playback.context.platform);
        if (!account) break;
        const speaker = { account, display_name: "", is_bot: true };
        await line(ctx, async () => {
          if (store.chat) {
            const options = { at: env.ts, turn: playback.turn, source: env.source };
            await store.chat.playback({ ...playback, speaker }, options);
            return;
          }
          const msg: IncomingMessage = {
            id: { context: playback.context, id: newId() },
            author: speaker,
            text: playback.text,
            mentions_self: false,
            reply_to_self: false,
            attachments: [],
            ts: env.ts,
          };
          await store.messages?.append(entry(profile, msg, true, playback.turn));
        });
        break;
      }
      case "custom": {
        if (event.data.topic !== MESSAGE_EXCLUDED_TOPIC) break;
        const message = excludedMessage(event.data.payload);
        if (message === null || !store.chat) break;
        try {
          const ids = await store.chat.redactMessage(message, "do not remember", env.source);
          ctx.log.info({ events: ids.length }, "a message she was asked not to remember");
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "failed to redact an excluded message");
        }
        break;
      }
      default:
        break;
    }
  }
}

/** A line as a `LogEntry`, for a store without chat events (test doubles). */
function entry(profile: ProfileId, msg: IncomingMessage, isSelf: boolean, turn: TurnId | null) {
  return { ...logEntryFromIncoming(profile, msg, isSelf), turn };
}

/** Stores one line; a failing store costs that line, never the loop. */
async function line(ctx: ModuleContext, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (error) {
    ctx.log.warn({ err: errorMessage(error) }, "failed to record message");
  }
}

/** Keeps the people table up to date for someone who wrote or spoke. */
async function person(
  ctx: ModuleContext,
  store: ChatRecordStore,
  msg: IncomingMessage,
): Promise<void> {
  if (!store.people) return;
  try {
    const person = await store.people.upsertAccount(msg.author.account, msg.author.display_name);
    // Her stable name for them is fixed the first time she sees them.
    ctx.services
      .get(HandleDirectoryKey)
      ?.ofAccount(msg.author.account, msg.author.display_name, person);
  } catch (error) {
    ctx.log.warn({ err: errorMessage(error) }, "failed to record person");
  }
}

/** The message of an `agent.message.excluded` payload, when it names one. */
function excludedMessage(payload: unknown): MessageRef | null {
  if (!isJsonObject(payload) || !isJsonObject(payload.message)) return null;
  const { context, id } = payload.message;
  if (!isJsonObject(context) || typeof id !== "string") return null;
  if (typeof context.platform !== "string") return null;
  return payload.message as unknown as MessageRef;
}
