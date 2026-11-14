// The `event` notification: a bus event the host forwards to an extension that subscribed to its
// topic and is granted it. Its params are the bus envelope plus the topic.

import { z } from "zod";
import {
  AccountRefSchema,
  ContextKeySchema,
  IncomingMessageSchema,
  JsonValueSchema,
  MessageRefSchema,
  PlaybackStateSchema,
  TimestampSchema,
  VoiceParticipantSchema,
  VoiceUtteranceSchema,
} from "../../wire/src/index.js";

export const ExtModuleStateKindSchema = z
  .enum(["disabled", "starting", "running", "degraded", "stopping", "stopped", "failed"])
  .meta({ id: "ExtModuleStateKind" });
export type ExtModuleStateKind = z.output<typeof ExtModuleStateKindSchema>;

/** Why the agent did or did not respond. */
export const ExtDecisionTraceSchema = z
  .object({
    turn: z.string(),
    context: ContextKeySchema,
    respond: z.boolean(),
    score: z.number(),
    reasons: z.array(z.string()),
  })
  .meta({ id: "ExtDecisionTrace" });
export type ExtDecisionTrace = z.output<typeof ExtDecisionTraceSchema>;

const variant = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ type: z.literal(type), data });

/**
 * A bus event, `{ type, data }` with a snake_case `type`. A type this list does not have is a
 * newer event: a receiver ignores it. `custom` carries any other topic (extensions, experiments).
 */
export const ExtEventSchema = z
  .discriminatedUnion("type", [
    variant("platform_ready", z.object({ platform: z.string(), self_account: AccountRefSchema })),
    variant("platform_message_created", IncomingMessageSchema),
    variant("platform_typing", z.object({ context: ContextKeySchema, account: AccountRefSchema })),
    variant("agent_turn_started", z.object({ turn: z.string(), context: ContextKeySchema })),
    variant("agent_decision", ExtDecisionTraceSchema),
    variant(
      "agent_turn_completed",
      z.object({ turn: z.string(), context: ContextKeySchema, text: z.string() }),
    ),
    variant(
      "action_completed",
      z.object({
        action: z.string(),
        turn: z.string().nullable(),
        ok: z.boolean(),
        error: z.string().nullable(),
        /** The message a successful `send_message` created. */
        message: MessageRefSchema.nullable(),
      }),
    ),
    variant(
      "voice_joined",
      z.object({ context: ContextKeySchema, participants: z.array(VoiceParticipantSchema) }),
    ),
    variant("voice_left", z.object({ context: ContextKeySchema, reason: z.string().nullable() })),
    variant(
      "voice_participants",
      z.object({ context: ContextKeySchema, participants: z.array(VoiceParticipantSchema) }),
    ),
    variant(
      "voice_speaking",
      z.object({ context: ContextKeySchema, account: AccountRefSchema, speaking: z.boolean() }),
    ),
    variant("voice_utterance", VoiceUtteranceSchema),
    variant(
      "voice_playback",
      z.object({
        context: ContextKeySchema,
        turn: z.string().nullable(),
        state: PlaybackStateSchema,
        text: z.string(),
        /** Added later, so each of these may be missing. */
        emotion: z.string().nullable().optional(),
        heard_ms: z.number().nullable().optional(),
        total_ms: z.number().nullable().optional(),
        blocked: z.string().nullable().optional(),
      }),
    ),
    variant(
      "agent_initiative",
      z.object({
        context: ContextKeySchema,
        reason: z.string(),
        hint: z.string(),
        about: z.array(AccountRefSchema),
      }),
    ),
    variant(
      "module_state_changed",
      z.object({
        module: z.string(),
        state: ExtModuleStateKindSchema,
        reason: z.string().nullable(),
      }),
    ),
    variant("custom", z.object({ topic: z.string(), payload: JsonValueSchema })),
  ])
  .meta({ id: "ExtEvent" });
export type ExtEvent = z.output<typeof ExtEventSchema>;

/** `event` params: the bus envelope plus the dotted topic (`platform.message.created`). */
export const ExtEventNotificationSchema = z
  .object({
    topic: z.string(),
    id: z.string(),
    ts: TimestampSchema,
    /** The module that published it: `agent`, `ext.<id>`, ... */
    source: z.string(),
    causation: z.string().nullable(),
    correlation: z.string().nullable(),
    event: ExtEventSchema,
  })
  .meta({ id: "ExtEventNotification" });
export type ExtEventNotification = z.output<typeof ExtEventNotificationSchema>;
