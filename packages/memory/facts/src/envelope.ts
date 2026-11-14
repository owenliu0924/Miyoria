// The facts writer's side of the event log (docs/design/v5-data.md §2): how a log line becomes an
// envelope in the store's `events` table, and how a stored envelope reads back as a log line.
// Pure: the store resolves places and people when it commits the batch, so nothing here touches
// the disk or waits.
//
// A line's envelope:
// - `type`: `facts.<kind>`; an observation is `facts.observation.said` when people said it (a
//   chat or voice line, kept 365 days), `facts.observation.ambient` when it is ambient (folded
//   after 14 days), `facts.observation` otherwise. The bus topic it came from stays in
//   `data.origin.topic`. The kind comes back from the type, so a redacted line keeps it;
// - `parent` is the line's `cause`, `turn` the turn its body names, `key` its attention key;
// - the place: the line's `context` goes to the store, which resolves it through identity into
//   `session`, `space_id` and `room_id`; the author of a chat or voice line gives `person_id` and
//   `account_id`; otherwise the line's handle gives `person_id`;
// - `scope` is left to the store: no `facts.*` type has a default, so the session decides (a
//   room, a DM, or `self` for a line without a place).

import {
  type EventQuery,
  type EventWrite,
  FACTS_EVENTS,
  FACTS_TYPE_PREFIX,
  FactsObservation,
  FactsObservationAmbient,
  FactsObservationSaid,
  type LoggedEvent,
  type PlaceAuthor,
} from "@miyoria/store";
import {
  isJsonObject,
  isLogEventKind,
  type LogEvent,
  type LogEventFilter,
  type LogEventKind,
} from "@miyoria/types";

/**
 * Bus topics whose observations are what people said, with the field of the bus event's data
 * that names who said it. Only the author's account and name are read here, never the text.
 */
const SAID_TOPICS: ReadonlyMap<string, string> = new Map([
  ["platform.message.created", "author"],
  ["voice.utterance", "speaker"],
]);

const OBSERVATION_TYPES: readonly string[] = [
  FactsObservation.type,
  FactsObservationSaid.type,
  FactsObservationAmbient.type,
];

/** Every type the facts writer records. */
export const FACTS_TYPES: readonly string[] = FACTS_EVENTS.map((d) => d.type);

/** The key an event is filed under: its observation's, or the one in its body. */
export function attentionOf(event: LogEvent): string | null {
  const body = event.body;
  if (!isJsonObject(body)) return null;
  const fields = isJsonObject(body.observation) ? body.observation : body;
  return typeof fields.attention_key === "string" ? fields.attention_key : null;
}

/** The turn a line's body names (`turn`, or the `turn_outcome` of a turn's result), if any. */
export function turnOf(event: LogEvent): string | null {
  const body = event.body;
  if (!isJsonObject(body)) return null;
  if (typeof body.turn === "string") return body.turn;
  const outcome = body.turn_outcome;
  return isJsonObject(outcome) && typeof outcome.turn === "string" ? outcome.turn : null;
}

/** The event type of a line. */
export function lineType(event: LogEvent): string {
  if (event.kind !== "observation") return `${FACTS_TYPE_PREFIX}${event.kind}`;
  const body = event.body;
  if (!isJsonObject(body) || !isJsonObject(body.observation)) return FactsObservation.type;
  const origin = body.origin;
  const topic = isJsonObject(origin) && typeof origin.topic === "string" ? origin.topic : null;
  if (body.speech === true || (topic !== null && SAID_TOPICS.has(topic))) {
    return FactsObservationSaid.type;
  }
  return body.observation.salience === "ambient"
    ? FactsObservationAmbient.type
    : FactsObservation.type;
}

/** The line kind of an event type; `null` for a type the facts writer does not record. */
export function lineKind(type: string): LogEventKind | null {
  if (OBSERVATION_TYPES.includes(type)) return "observation";
  if (!type.startsWith(FACTS_TYPE_PREFIX)) return null;
  const kind = type.slice(FACTS_TYPE_PREFIX.length);
  return isLogEventKind(kind) && kind !== "observation" ? kind : null;
}

/** The event types of `kinds`; every facts type without them. */
export function typesOf(kinds?: readonly LogEventKind[]): string[] {
  if (kinds === undefined) return [...FACTS_TYPES];
  return kinds.flatMap((k) =>
    k === "observation" ? OBSERVATION_TYPES : [`${FACTS_TYPE_PREFIX}${k}`],
  );
}

/** Who wrote a chat or voice line, from the bus event its observation keeps. */
export function authorOf(event: LogEvent): PlaceAuthor | null {
  const body = event.body;
  if (event.kind !== "observation" || !isJsonObject(body) || !isJsonObject(body.origin)) {
    return null;
  }
  const { topic, event: bus } = body.origin;
  const field = typeof topic === "string" ? SAID_TOPICS.get(topic) : undefined;
  if (field === undefined || !isJsonObject(bus) || !isJsonObject(bus.data)) return null;
  const who = bus.data[field];
  if (!isJsonObject(who) || !isJsonObject(who.account)) return null;
  const { platform, id } = who.account;
  if (typeof platform !== "string" || typeof id !== "string") return null;
  const name = typeof who.display_name === "string" ? who.display_name : id;
  return { account: { platform, id }, display_name: name };
}

/** What the store appends for a line. */
export function toWrite(event: LogEvent): EventWrite {
  return {
    draft: {
      id: event.id,
      at: event.at,
      type: lineType(event),
      v: 1,
      parent: event.cause,
      turn: turnOf(event),
      key: attentionOf(event),
      data: event.body,
    },
    source: event.source,
    context: event.context,
    author: authorOf(event),
    handle: event.person,
  };
}

/** A stored event as a line; `null` when another writer recorded it. */
export function fromLogged(logged: LoggedEvent): LogEvent | null {
  const e = logged.envelope;
  const kind = lineKind(e.type);
  if (kind === null) return null;
  return {
    id: e.id,
    at: e.at,
    kind,
    source: e.source,
    cause: e.parent,
    context: logged.context,
    person: logged.handle,
    body: e.data,
  };
}

/**
 * The store's query for a log filter. The filter keeps its V3 fields: `context` is looked up as
 * its session and `person` (a handle) as its person, both by the store.
 */
export function toQuery(filter: LogEventFilter): EventQuery {
  const query: EventQuery = { types: typesOf(filter.kinds) };
  if (filter.sources) query.sources = filter.sources;
  if (filter.context) query.context = filter.context;
  if (filter.person !== undefined) query.handle = filter.person;
  if (filter.attention_key !== undefined) query.key = filter.attention_key;
  if (filter.turn !== undefined) query.turn = filter.turn;
  if (filter.since !== undefined) query.since = filter.since;
  if (filter.until !== undefined) query.until = filter.until;
  if (filter.before !== undefined) query.before = filter.before;
  if (filter.after !== undefined) query.after = filter.after;
  if (filter.order !== undefined) query.order = filter.order;
  if (filter.limit !== undefined) query.limit = filter.limit;
  return query;
}
