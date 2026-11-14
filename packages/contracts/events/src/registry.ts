// Event types: `defineEvent` names a type, the version of its payload and the payload's schema,
// with the type's default scope and its tier; `EventRegistry` holds the definitions Core knows.
// No bus, no store, no I/O: this runs in a browser bundle as well as in Core.

import type { z } from "zod";
import type { EventId, Timestamp } from "../../wire/src/index.js";
import {
  DEFAULT_EVENT_TIER,
  type EventDraft,
  type EventEnvelope,
  type EventScope,
  type EventTier,
} from "./envelope.js";

/** One version of one event type. Treat it as immutable. */
export interface EventDefinition<Type extends string = string, Data extends z.ZodType = z.ZodType> {
  readonly type: Type;
  /** The payload version this definition describes. */
  readonly v: number;
  /** The payload schema at `v`. */
  readonly data: Data;
  /** Default scope when the producer sets none; `null`: the session decides. */
  readonly scope: EventScope | null;
  /** Retention, stamped on every event of the type. */
  readonly tier: EventTier;
}

/** A definition of any type, as the registry holds it. */
export type AnyEventDefinition = EventDefinition<string, z.ZodType>;

/** The payload type of a definition. */
export type EventPayload<D extends AnyEventDefinition> = z.output<D["data"]>;

export interface EventSpec<Type extends string, Data extends z.ZodType> {
  type: Type;
  v: number;
  data: Data;
  /** Default: none, so the session decides. */
  scope?: EventScope;
  /** Default: `short` (`DEFAULT_EVENT_TIER`). */
  tier?: EventTier;
}

/** An event definition is wrong, or two of them clash. */
export class EventDefinitionError extends Error {
  override name = "EventDefinitionError";
}

/** An envelope was read with the definition of another type or version. */
export class EventMismatchError extends Error {
  override name = "EventMismatchError";
  constructor(
    readonly expected: { type: string; v: number },
    readonly actual: { type: string; v: number },
  ) {
    super(
      `expected event \`${expected.type}\` v${expected.v}, got \`${actual.type}\` v${actual.v}`,
    );
  }
}

/** Defines one version of an event type. The payload type is inferred from `data`. */
export function defineEvent<const Type extends string, Data extends z.ZodType>(
  spec: EventSpec<Type, Data>,
): EventDefinition<Type, Data> {
  if (spec.type.trim() === "" || /\s/.test(spec.type)) {
    throw new EventDefinitionError(`event type \`${spec.type}\` is empty or has whitespace`);
  }
  if (!Number.isInteger(spec.v) || spec.v < 1) {
    throw new EventDefinitionError(`event \`${spec.type}\`: version ${spec.v} is not 1 or more`);
  }
  return Object.freeze({
    type: spec.type,
    v: spec.v,
    data: spec.data,
    scope: spec.scope ?? null,
    tier: spec.tier ?? DEFAULT_EVENT_TIER,
  });
}

/** The scope and tier Core uses for a type when the producer does not say. */
export interface EventDefaults {
  /** `null`: the session decides. */
  scope: EventScope | null;
  tier: EventTier;
}

/** The event types Core knows, by type and version. */
export class EventRegistry {
  readonly #types = new Map<string, Map<number, AnyEventDefinition>>();

  /**
   * Adds definitions. Refuses a second definition of a type and version already registered;
   * registering the same definition again does nothing.
   */
  register(...definitions: AnyEventDefinition[]): this {
    for (const definition of definitions) {
      const versions = this.#types.get(definition.type) ?? new Map<number, AnyEventDefinition>();
      const known = versions.get(definition.v);
      if (known === definition) continue;
      if (known !== undefined) {
        throw new EventDefinitionError(
          `event \`${definition.type}\` v${definition.v} is already registered`,
        );
      }
      versions.set(definition.v, definition);
      this.#types.set(definition.type, versions);
    }
    return this;
  }

  /** The definition of `type` at `v`; without `v`, its newest version. `null` when unknown. */
  get(type: string, v?: number): AnyEventDefinition | null {
    const versions = this.#types.get(type);
    if (versions === undefined) return null;
    if (v !== undefined) return versions.get(v) ?? null;
    return versions.get(Math.max(...versions.keys())) ?? null;
  }

  /** Every definition, by type, then version. */
  list(): AnyEventDefinition[] {
    return [...this.#types.keys()]
      .sort()
      .flatMap((type) => [...(this.#types.get(type)?.values() ?? [])].sort((a, b) => a.v - b.v));
  }

  /**
   * The default scope and the tier of `type`, from its newest version. A type nobody registered
   * gets no default scope and `DEFAULT_EVENT_TIER`.
   */
  defaults(type: string): EventDefaults {
    const definition = this.get(type);
    if (definition === null) return { scope: null, tier: DEFAULT_EVENT_TIER };
    return { scope: definition.scope, tier: definition.tier };
  }
}

/** A draft whose `type`, `v` and `data` are those of one definition. */
export type EventDraftOf<D extends AnyEventDefinition> = Omit<EventDraft, "type" | "v" | "data"> & {
  type: D["type"];
  v: number;
  data: EventPayload<D>;
};

/** What a producer says besides the payload: `id` and `at` always, the rest when it knows them. */
export type EventDraftMeta = { id: EventId; at: Timestamp } & Partial<
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
>;

/**
 * The draft of one event of `definition`. The payload is typed, not parsed: checking payloads
 * against their schemas is for tests and for readers (`readEventData`).
 */
export function eventDraft<D extends AnyEventDefinition>(
  definition: D,
  data: EventPayload<D>,
  meta: EventDraftMeta,
): EventDraftOf<D> {
  return {
    id: meta.id,
    at: meta.at,
    type: definition.type,
    v: definition.v,
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

/** The part of an envelope or a draft that `readEventData` reads. */
export type EventDataSource = Pick<EventEnvelope, "type" | "v"> & {
  data: unknown;
  /** Absent on a draft, which cannot be redacted. */
  redacted_at?: Timestamp | null;
};

/**
 * The payload of `event`, parsed with `definition`'s schema; `null` when the event was redacted.
 * Throws `EventMismatchError` when the event is another type or version, and zod's error when
 * the payload does not fit.
 */
export function readEventData<D extends AnyEventDefinition>(
  definition: D,
  event: EventDataSource,
): EventPayload<D> | null {
  if (event.type !== definition.type || event.v !== definition.v) {
    throw new EventMismatchError(
      { type: definition.type, v: definition.v },
      { type: event.type, v: event.v },
    );
  }
  if (event.redacted_at !== undefined && event.redacted_at !== null) return null;
  return definition.data.parse(event.data) as EventPayload<D>;
}
