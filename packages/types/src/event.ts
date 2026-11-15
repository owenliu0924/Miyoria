import {
  type ActionCompletedData,
  type AgentInitiativeData,
  type AnyEventDefinition,
  type DecisionTraceData,
  type EventDraft,
  type EventPayload,
  familyCovers,
  type ModuleStateData,
  type PlatformReadyData,
  type PlatformTypingData,
  type TurnCompletedData,
  type TurnStartedData,
  type VoiceJoinedData,
  type VoiceLeftData,
  type VoiceParticipantsData,
  type VoicePlayback,
  type VoiceSpeakingData,
} from "@miyoria/contracts/events";
import { type EventId, type ModuleId, newId, type TurnId } from "./ids.js";
import type { JsonValue } from "./json.js";
import type { IncomingMessage } from "./platform.js";
import { type Timestamp, toTimestamp } from "./time.js";
import type { VoiceUtterance } from "./voice.js";

// The payload of every typed variant is a contract (`@miyoria/contracts/events`, one schema per
// bus topic); the types here are inferred from those schemas.

export type ModuleStateKind = ModuleStateData["state"];

/** Why the agent did or did not respond. Shown in the panel for debugging. */
export type DecisionTrace = DecisionTraceData;

/**
 * Every bus event. Adjacently tagged (snake_case type names):
 * `{"type": "platform_message_created", "data": {...}}`.
 *
 * Optional (`Option<T>`) fields are always present, `null` when unset.
 */
export type Event =
  /**
   * A platform connection is up. `self_account` is one of her own accounts; messages from her
   * own accounts are never treated as input.
   */
  | { type: "platform_ready"; data: PlatformReadyData }
  | { type: "platform_message_created"; data: IncomingMessage }
  /** Someone started typing (used to extend the reply debounce). */
  | { type: "platform_typing"; data: PlatformTypingData }
  | { type: "agent_turn_started"; data: TurnStartedData }
  | { type: "agent_decision"; data: DecisionTrace }
  | { type: "agent_turn_completed"; data: TurnCompletedData }
  /** `message`: the message a successful `send_message` created (may be missing in old JSON). */
  | { type: "action_completed"; data: ActionCompletedData }
  /** She joined a voice channel (`context.kind === "voice"`). */
  | { type: "voice_joined"; data: VoiceJoinedData }
  | { type: "voice_left"; data: VoiceLeftData }
  /** Who is in the voice channel changed. */
  | { type: "voice_participants"; data: VoiceParticipantsData }
  /** Someone started or stopped speaking (raw signal, before ASR). */
  | { type: "voice_speaking"; data: VoiceSpeakingData }
  | { type: "voice_utterance"; data: VoiceUtterance }
  /**
   * Her own speech playback. `emotion`, `heard_ms`, `total_ms` and `blocked` are missing from
   * older publishers; `blocked`: moderation replaced what she meant (the rule), so this is not
   * her line reaching anyone. (`speaker` is what the recorder adds when it stores the line.)
   */
  | { type: "voice_playback"; data: Omit<VoicePlayback, "speaker"> }
  /** Asks the agent to start a turn on her own initiative (no new input). */
  | { type: "agent_initiative"; data: AgentInitiativeData }
  | { type: "module_state_changed"; data: ModuleStateData }
  /** Escape hatch for extensions and experimental modules; `topic` is the bus topic. */
  | { type: "custom"; data: { topic: string; payload: JsonValue } };

export type EventType = Event["type"];
/** The event variant with tag `T`. */
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;
/** The `data` of the event variant with tag `T`. */
export type EventData<T extends EventType> = EventOf<T>["data"];

/** Dotted bus topic of every built-in variant (`custom` carries its own). */
export const EVENT_TOPICS: Readonly<Record<Exclude<EventType, "custom">, string>> = {
  platform_ready: "platform.ready",
  platform_message_created: "platform.message.created",
  platform_typing: "platform.typing",
  agent_turn_started: "agent.turn.started",
  agent_decision: "agent.decision",
  agent_turn_completed: "agent.turn.completed",
  action_completed: "action.completed",
  voice_joined: "voice.joined",
  voice_left: "voice.left",
  voice_participants: "voice.participants",
  voice_speaking: "voice.speaking",
  voice_utterance: "voice.utterance",
  voice_playback: "voice.playback",
  agent_initiative: "agent.initiative",
  module_state_changed: "system.module.state",
};

/** Dotted topic used for subscription filters, e.g. `platform.message.created`. */
export function eventTopic(event: Event): string {
  return event.type === "custom" ? event.data.topic : EVENT_TOPICS[event.type];
}

/** Narrows an event to one variant. */
export function isEvent<T extends EventType>(event: Event, type: T): event is EventOf<T> {
  return event.type === type;
}

/** A `custom` event. */
export function customEvent(topic: string, payload: JsonValue): EventOf<"custom"> {
  return { type: "custom", data: { topic, payload } };
}

// ---- the envelope ---------------------------------------------------------------------------
//
// The bus carries one envelope (K12b in docs/design/v5-contracts.md): the contract's event draft
// (`EventDraft` in @miyoria/contracts/events) with every key present, plus the `source` the bus
// stamps. `type` is the dotted topic and `data` the payload, for every event.
//
// Until the old forms are gone, every envelope also carries them as a view (`ts`, `causation`,
// `correlation`, `event`), so code that reads `env.event` keeps working. The view is made once,
// when the envelope is, and never changes; it is the only place the old `{type, data}` form is
// derived from the new one inside the process.

/** A bus topic's definition and the payload type it gives (re-exported from the contract). */
export type { AnyEventDefinition, EventPayload };

/** The bus envelope: the contract's draft plus the publishing module the bus stamps. */
export type BusEnvelope<Type extends string = string, Data = unknown> = Omit<
  EventDraft,
  "type" | "data"
> & {
  type: Type;
  /** The module that published it. */
  source: ModuleId;
  data: Data;
};

/**
 * The old envelope form: what the admin event stream, extension notifications and the CLI carry
 * on the wire today (protocol 1). Built from a bus envelope by `toLegacyEnvelope`.
 */
export interface LegacyEnvelope {
  id: EventId;
  ts: Timestamp;
  source: ModuleId;
  /** The event that caused this one. */
  causation: EventId | null;
  /** The agent turn this event belongs to. */
  correlation: TurnId | null;
  event: Event;
}

/** The old fields every envelope carries as a view of its new ones (removed with the old forms). */
export interface LegacyEnvelopeView {
  /** `at`. */
  ts: Timestamp;
  /** `parent`. */
  causation: EventId | null;
  /** `turn`. */
  correlation: TurnId | null;
  /** `type` and `data` as the old `{type, data}` event (`custom` for every other topic). */
  event: Event;
}

/** Every event on the bus is wrapped in an envelope. Treat envelopes as immutable. */
export interface Envelope extends BusEnvelope, LegacyEnvelopeView {}

/** An envelope whose `data` is the payload of `D`. */
export type EnvelopeOf<D extends AnyEventDefinition> = Envelope & { data: EventPayload<D> };

/** What a publisher may say about an event besides its payload. */
export type EventMeta = Partial<
  Pick<
    EventDraft,
    | "parent"
    | "turn"
    | "session"
    | "space_id"
    | "room_id"
    | "person_id"
    | "account_id"
    | "scope"
    | "key"
  >
> & {
  /** Epoch ms for `at`; defaults to `Date.now()`. */
  now?: number;
};

/** Whether a definition's type is a family pattern (`**.task.done`, `game.*.*`). */
export type IsEventFamily<Type extends string> = Type extends `${string}*${string}` ? true : false;

/**
 * The meta argument of a publish by definition: a family needs the concrete `type` (one it
 * covers, `worklane.task.done` for `**.task.done`); a fixed type takes none.
 */
export type PublishMetaArgs<D extends AnyEventDefinition> =
  IsEventFamily<D["type"]> extends true
    ? [meta: EventMeta & { type: string }]
    : [meta?: EventMeta & { type?: undefined }];

/** Dotted topic -> old variant, for the view. */
const VARIANT_OF_TOPIC: ReadonlyMap<string, Exclude<EventType, "custom">> = new Map(
  (Object.entries(EVENT_TOPICS) as [Exclude<EventType, "custom">, string][]).map(([k, v]) => [
    v,
    k,
  ]),
);

/**
 * The old `{type, data}` form of an event of dotted `type`: the typed variant for the 15 topics
 * that have one, else `custom` with the topic and payload.
 */
export function legacyEvent(type: string, data: unknown): Event {
  const variant = VARIANT_OF_TOPIC.get(type);
  if (variant !== undefined) return { type: variant, data } as Event;
  return { type: "custom", data: { topic: type, payload: data as JsonValue } };
}

/** The payload of an old-form event (`data`, or a custom event's `payload`). */
export function eventPayload(event: Event): unknown {
  return event.type === "custom" ? event.data.payload : event.data;
}

/** The envelope with its view; `event`: the old form to keep, when the publisher gave one. */
function withView(base: BusEnvelope, event?: Event): Envelope {
  return {
    ...base,
    ts: base.at,
    causation: base.parent,
    correlation: base.turn,
    event: event ?? legacyEvent(base.type, base.data),
  };
}

function stamped(
  source: ModuleId,
  type: string,
  v: number,
  data: unknown,
  meta: EventMeta,
): BusEnvelope {
  return {
    id: newId(),
    at: toTimestamp(meta.now ?? Date.now()),
    type,
    v,
    source,
    parent: meta.parent ?? null,
    turn: meta.turn ?? null,
    session: meta.session ?? null,
    space_id: meta.space_id ?? null,
    room_id: meta.room_id ?? null,
    person_id: meta.person_id ?? null,
    account_id: meta.account_id ?? null,
    scope: meta.scope ?? null,
    key: meta.key ?? null,
    data,
  };
}

/** Whether a value is an event definition rather than an old-form `Event`. */
export function isEventDefinition(value: unknown): value is AnyEventDefinition {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Partial<AnyEventDefinition>;
  return typeof d.type === "string" && typeof d.v === "number" && typeof d.tier === "string";
}

/**
 * A fresh envelope of one event of `definition` from `source`. For a family, `meta.type` is the
 * concrete type; it must be one the family covers (a programming error otherwise: throws).
 */
export function eventEnvelope<D extends AnyEventDefinition>(
  source: ModuleId,
  definition: D,
  data: EventPayload<D>,
  ...[meta]: PublishMetaArgs<D>
): EnvelopeOf<D> {
  const m = (meta ?? {}) as EventMeta & { type?: string };
  let type: string = definition.type;
  if (definition.type.includes("*")) {
    if (m.type === undefined || !familyCovers(definition.type, m.type)) {
      throw new Error(`event family \`${definition.type}\` does not cover \`${String(m.type)}\``);
    }
    type = m.type;
  }
  return withView(stamped(source, type, definition.v, data, m)) as EnvelopeOf<D>;
}

/**
 * Whether `envelope` is an event of `definition` (its type, or a type its family covers, at its
 * version). Narrows `data` to the payload; the payload is not parsed: a bus payload is what its
 * publisher built (tests check publishers against the schemas).
 */
export function is<D extends AnyEventDefinition, E extends Pick<BusEnvelope, "type" | "v">>(
  definition: D,
  envelope: E,
): envelope is E & { data: EventPayload<D> } {
  if (envelope.v !== definition.v) return false;
  return definition.type.includes("*")
    ? familyCovers(definition.type, envelope.type)
    : envelope.type === definition.type;
}

/** Topic of an envelope's event (its `type`). */
export function envelopeTopic(envelope: Pick<BusEnvelope, "type">): string {
  return envelope.type;
}

// ---- adapters of the old forms (K12b part 2 removes them) ------------------------------------

export interface EnvelopeOptions {
  causation?: EventId | null;
  correlation?: TurnId | null;
  /** Epoch ms for `ts`; defaults to `Date.now()`. */
  now?: number;
}

/**
 * The envelope of an old-form event: `type` is its topic, `data` its payload, and the view keeps
 * `event` itself. Payload version 1 (every bus type is at 1).
 */
export function newEnvelope(
  source: ModuleId,
  event: Event,
  options: EnvelopeOptions = {},
): Envelope {
  const base = stamped(source, eventTopic(event), 1, eventPayload(event), {
    parent: options.causation ?? null,
    turn: options.correlation ?? null,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return withView(base, event);
}

/** A bus envelope read from the old wire form (`ts`, `causation`, `correlation`, `event`). */
export function fromLegacyEnvelope(legacy: LegacyEnvelope): Envelope {
  return withView(
    {
      id: legacy.id,
      at: legacy.ts,
      type: eventTopic(legacy.event),
      v: 1,
      source: legacy.source,
      parent: legacy.causation,
      turn: legacy.correlation,
      session: null,
      space_id: null,
      room_id: null,
      person_id: null,
      account_id: null,
      scope: null,
      key: null,
      data: eventPayload(legacy.event),
    },
    legacy.event,
  );
}

/**
 * The old wire form of a bus envelope, with today's keys in today's order. The one function the
 * boundaries that still speak it (the admin event stream, extension notifications) build it with.
 */
export function toLegacyEnvelope(envelope: BusEnvelope): LegacyEnvelope {
  return {
    id: envelope.id,
    ts: envelope.at,
    source: envelope.source,
    causation: envelope.parent,
    correlation: envelope.turn,
    event: legacyEvent(envelope.type, envelope.data),
  };
}

/**
 * Any envelope as the bus delivers it: an `Envelope` as it is (the same object), a bus envelope
 * without the view gets one, an old-form envelope is read with `fromLegacyEnvelope`.
 */
export function toEnvelope(envelope: Envelope | BusEnvelope | LegacyEnvelope): Envelope {
  if (!("at" in envelope)) return fromLegacyEnvelope(envelope);
  if ("event" in envelope) return envelope;
  return withView(envelope);
}

/** Module id of the kernel itself: source of `system.module.state` events. */
export const KERNEL_MODULE: ModuleId = "kernel";
