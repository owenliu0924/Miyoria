// @miyoria/contracts/events: the event envelope, defineEvent and the registry of event types
// (docs/design/v5-data.md §2.2, docs/design/v5-contracts.md §2.8). Payload schemas of real event
// types come later; nothing here does I/O, so a browser bundle can use it.

export {
  DEFAULT_EVENT_TIER,
  type EventDraft,
  type EventDraftInput,
  EventDraftSchema,
  type EventEnvelope,
  EventEnvelopeSchema,
  type EventScope,
  EventScopeSchema,
  type EventTier,
  EventTierSchema,
  isRedacted,
  REDACTED_DATA,
  type RedactedData,
  RedactedDataSchema,
} from "./envelope.js";
export {
  type AnyEventDefinition,
  defineEvent,
  type EventDataSource,
  type EventDefaults,
  type EventDefinition,
  EventDefinitionError,
  type EventDraftMeta,
  type EventDraftOf,
  EventMismatchError,
  type EventPayload,
  EventRegistry,
  type EventSpec,
  eventDraft,
  readEventData,
} from "./registry.js";
