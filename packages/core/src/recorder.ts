// `recorder`: writes every chat line (people's text and voice, hers too: her echoed messages and
// her spoken sentences) to the event log as one chat event each (docs/design/v5-data.md §8 step
// 5), keeps the people table up to date and stores the agent's decision traces.
//
// It is the one writer of the raw chat record: one subscriber, so a line is stored once. The facts
// module's observations of the same messages are hers, a derived view under the same key.
//
// "Do not remember this" (`agent.message.excluded`) is applied here too: the message's events
// (its line and her observations of it) are redacted, so every reader of the log stops seeing it.

import {
  defineManifest,
  errorMessage,
  type Module,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
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
  TURN_OUTCOME_TOPIC,
  type TurnId,
  v2Payload,
} from "@miyoria/types";

export class RecorderModule implements Module {
  static readonly ID = "recorder";
  readonly manifest = defineManifest(RecorderModule.ID, "Message recorder", {
    description: "Persists conversations and the people she meets",
  });
  readonly #store: Store;
  readonly #profile: ProfileId;

  constructor(store: Store, profile: ProfileId) {
    this.#store = store;
    this.#profile = profile;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const sub = ctx.subscribe([
      "platform.ready",
      "platform.message.created",
      "voice.utterance",
      "voice.playback",
      "agent.decision",
      TURN_OUTCOME_TOPIC,
      MESSAGE_EXCLUDED_TOPIC,
    ]);
    const store = this.#store;
    const profile = this.#profile;
    const log = ctx.log;
    ctx.spawn("record", async () => {
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
              else await store.messages.append(entry(profile, msg, isSelf, env.correlation));
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
              else await store.messages.append(entry(profile, msg, false, env.correlation));
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
              await store.messages.append(entry(profile, msg, true, playback.turn));
            });
            break;
          }
          case "agent_decision": {
            try {
              await store.decisions.append({ id: newId(), profile, ts: env.ts, trace: event.data });
            } catch (error) {
              log.warn({ err: errorMessage(error) }, "failed to record decision");
            }
            break;
          }
          case "custom": {
            if (event.data.topic === MESSAGE_EXCLUDED_TOPIC) {
              const message = excludedMessage(event.data.payload);
              if (message === null || !store.chat) break;
              try {
                const ids = await store.chat.redactMessage(message, "do not remember", env.source);
                log.info({ events: ids.length }, "a message she was asked not to remember");
              } catch (error) {
                log.warn({ err: errorMessage(error) }, "failed to redact an excluded message");
              }
              break;
            }
            // How a turn ended: "decided to reply but nothing was sent" becomes queryable.
            const outcome = v2Payload(event, TURN_OUTCOME_TOPIC);
            if (outcome === null || !store.decisions.appendOutcome) break;
            try {
              await store.decisions.appendOutcome(profile, outcome);
            } catch (error) {
              log.warn({ err: errorMessage(error) }, "failed to record turn outcome");
            }
            break;
          }
          default:
            break;
        }
      }
    });
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
async function person(ctx: ModuleContext, store: Store, msg: IncomingMessage): Promise<void> {
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
