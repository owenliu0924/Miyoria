// `/api/people*`: people the active profile knows and how she feels about them, read from the
// heart's rows (`heart_person`, phase 4 step 5; the old `relationships` table is only read by the
// heart's migration). The contract's `relationship` is the row in the old words: `affinity` is the
// bond, `notes` her impression. Every change goes to the row. Everyone in the people store is
// listed; people without a row yet have `relationship: null` and the label of a stranger.

import type {
  AdjustPersonRequest,
  PersonDetail,
  PersonPage,
  PersonSummary,
  Relationship,
  RelationshipDelta,
  UpdatePersonRequest,
} from "@miyoria/contracts/api";
import {
  BLOCKED_TAG,
  type HeartHistoryEntry,
  type HeartPerson,
  type HeartStore,
  labelOf,
} from "@miyoria/heart/person";
import { MemoryEngineKey } from "@miyoria/memory/memory";
import {
  type IdentityStore,
  IdentityStoreKey,
  type MemoryFilter,
  MemoryRecordStoreKey,
  type PeopleStore,
  PeopleStoreKey,
  type Person,
} from "@miyoria/store";
import { isUlid, type PersonId, type ProfileId } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { heartRows } from "./heart-rows.js";
import { type ApiContext, type ApiState, actorOf, toJson } from "./state.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const MAX_HISTORY = 500;
const MAX_TAGS = 32;
const MAX_TAG_CHARS = 32;
const MAX_NOTES_CHARS = 2000;
const MAX_CALL_NAME_CHARS = 64;

function chars(s: string): number {
  return [...s].length;
}

function unknownPerson(id: string): ApiError {
  return ApiError.notFound(`unknown person \`${id}\``);
}

function parsePerson(id: string): PersonId {
  const upper = id.toUpperCase();
  if (!isUlid(upper)) throw unknownPerson(id);
  return upper;
}

function ms(ts: string | null): number {
  return ts === null ? Number.NEGATIVE_INFINITY : Date.parse(ts);
}

/** The label of someone without a row yet. */
const NEUTRAL_LABEL = labelOf(null);

/** A row in the contract's old words. */
export function relationshipOf(profile: ProfileId, p: HeartPerson): Relationship {
  return {
    profile,
    person: p.person_id,
    affinity: p.bond,
    trust: p.trust,
    familiarity: p.familiarity,
    tags: [...p.tags],
    notes: p.impression,
    call_name: p.call_name,
    interactions: p.interactions,
    last_interaction: p.last_interaction,
    updated_at: p.updated_at,
  };
}

/** The services people routes read from. */
class PeopleCtx {
  readonly profile: ProfileId;
  readonly identity: IdentityStore;
  readonly people: PeopleStore | undefined;
  readonly heart: HeartStore;

  constructor(state: ApiState) {
    this.profile = state.profile();
    this.identity = state.service(IdentityStoreKey, "identity store");
    this.people = state.optional(PeopleStoreKey);
    const heart = heartRows(state);
    if (heart === null) throw ApiError.unavailable("the heart's rows are not available");
    this.heart = heart;
  }

  row(person: PersonId): HeartPerson | null {
    return this.heart.get(person);
  }

  /** The person with their accounts; `null` when nobody has this id. */
  async person(id: PersonId): Promise<Person | null> {
    const accounts = await this.identity.accountsOf(id);
    const first = accounts[0];
    if (!first) return null;
    if (this.people) {
      const person = await this.people.personByAccount(first.account);
      if (person && person.id === id) return person;
    }
    let created = first.first_seen;
    for (const a of accounts) {
      if (Date.parse(a.first_seen) < Date.parse(created)) created = a.first_seen;
    }
    return { id, display_name: first.display_name, created_at: created, accounts };
  }

  summarize(person: Person, row: HeartPerson | null): PersonSummary {
    return {
      person,
      relationship: row === null ? null : relationshipOf(this.profile, row),
      label: row === null ? NEUTRAL_LABEL : labelOf(row),
      blocked: row?.tags.includes(BLOCKED_TAG) ?? false,
    };
  }

  async requireSummary(id: PersonId): Promise<PersonSummary> {
    const person = await this.person(id);
    if (!person) throw unknownPerson(id);
    return this.summarize(person, this.row(id));
  }
}

/** When one of the person's accounts was last seen. */
function lastSeen(person: Person): number {
  let last = Number.NEGATIVE_INFINITY;
  for (const a of person.accounts) last = Math.max(last, Date.parse(a.last_seen));
  return last;
}

/**
 * Most recent interaction first, then the most recently changed row, then whoever was seen last
 * (people without a row sort after those with one of the same recency).
 */
function byRecency(a: PersonSummary, b: PersonSummary): number {
  const ra = a.relationship;
  const rb = b.relationship;
  return (
    ms(rb?.last_interaction ?? null) - ms(ra?.last_interaction ?? null) ||
    ms(rb?.updated_at ?? null) - ms(ra?.updated_at ?? null) ||
    lastSeen(b.person) - lastSeen(a.person) ||
    0
  );
}

function matches(summary: PersonSummary, needle: string): boolean {
  const has = (s: string) => s.toLowerCase().includes(needle);
  return (
    has(summary.person.display_name) ||
    summary.person.id.toLowerCase() === needle ||
    summary.person.accounts.some((a) => has(a.display_name) || has(a.account.id)) ||
    (summary.relationship?.call_name != null && has(summary.relationship.call_name))
  );
}

/** Every heart row (the list is paged in the store). */
function allRows(heart: HeartStore): HeartPerson[] {
  const out: HeartPerson[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = heart.list({ offset, limit: 200 });
    for (const e of page.entries) out.push(e.person);
    offset = page.next;
  }
  return out;
}

/**
 * `GET /api/people?q=&limit=&cursor=`: every known person, most recent interaction first. Without
 * a people store only people with a row are known.
 */
async function list(
  state: ApiState,
  q: { q?: string | undefined; limit?: number | undefined; cursor?: string | undefined },
): Promise<PersonPage> {
  const ctx = new PeopleCtx(state);
  let offset = 0;
  const cursor = q.cursor?.trim() ?? "";
  if (cursor !== "") {
    if (!/^\+?\d+$/.test(cursor)) throw ApiError.badRequest(`invalid cursor \`${cursor}\``);
    offset = Number.parseInt(cursor, 10);
  }
  const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const needle = q.q?.trim().toLowerCase() || null;

  const rows = new Map<PersonId, HeartPerson>();
  for (const r of allRows(ctx.heart)) rows.set(r.person_id, r);
  const all: PersonSummary[] = [];
  if (ctx.people) {
    for (const person of await ctx.people.all()) {
      all.push(ctx.summarize(person, rows.get(person.id) ?? null));
    }
  } else {
    for (const r of rows.values()) {
      const person = await ctx.person(r.person_id);
      if (person) all.push(ctx.summarize(person, r));
    }
  }
  const items = all
    .filter((summary) => needle === null || matches(summary, needle))
    .sort(byRecency);
  return {
    items: items.slice(offset, offset + limit),
    next_cursor: items.length > offset + limit ? String(offset + limit) : null,
  };
}

/**
 * Her changes of the bond, trust and familiarity (`heart.changed`, newest first) as the levels
 * after each one, oldest first, walking back from the current values. The reason is the cause and
 * the quote (`feel: 他記得我說過的話`).
 */
export function absoluteHistory(
  changes: readonly HeartHistoryEntry[],
  current: HeartPerson | null,
): RelationshipDelta[] {
  let a = current?.bond ?? 0;
  let t = current?.trust ?? 0;
  let f = current?.familiarity ?? 0;
  const out: RelationshipDelta[] = [];
  for (const { at, change } of changes) {
    if (change.field !== "bond" && change.field !== "trust" && change.field !== "familiarity") {
      continue;
    }
    const quote = change.reason_quote.trim();
    out.push({
      at,
      affinity: a,
      trust: t,
      familiarity: f,
      reason: quote === "" ? change.cause : `${change.cause}: ${quote}`,
    });
    if (change.field === "bond") a -= change.delta;
    if (change.field === "trust") t -= change.delta;
    if (change.field === "familiarity") f -= change.delta;
  }
  return out.reverse();
}

async function memoryCount(state: ApiState, profile: ProfileId, person: PersonId): Promise<number> {
  const records = state.optional(MemoryEngineKey)?.records ?? state.optional(MemoryRecordStoreKey);
  if (!records) return 0;
  const filter: MemoryFilter = {
    subject: person,
    scope: null,
    kind: null,
    before: null,
    include_superseded: false,
    limit: 100_000,
  };
  try {
    if (records.count) return await records.count(profile, filter);
    return (await records.list(profile, filter)).length;
  } catch {
    return 0;
  }
}

/** `GET /api/people/{id}`. */
async function detail(state: ApiState, id: string): Promise<PersonDetail> {
  const person = parsePerson(id);
  const ctx = new PeopleCtx(state);
  const summary = await ctx.requireSummary(person);
  const changes = ctx.heart.log.history(person, { limit: MAX_HISTORY });
  return {
    ...summary,
    history: absoluteHistory(changes, ctx.row(person)),
    memory_count: await memoryCount(state, ctx.profile, person),
  };
}

function cleanTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === "" || tag === BLOCKED_TAG) continue;
    if (chars(tag) > MAX_TAG_CHARS) {
      throw ApiError.badRequest(`tag \`${tag}\` is longer than ${MAX_TAG_CHARS} characters`);
    }
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > MAX_TAGS) throw ApiError.badRequest(`at most ${MAX_TAGS} tags are allowed`);
  return out;
}

/** What a `PATCH` changes: the fields it sent, a `null` meaning "not sent" (except `call_name`). */
interface PersonChange {
  tags?: string[];
  notes?: string;
  call_name?: string | null;
  blocked?: boolean;
}

function changeOf(r: UpdatePersonRequest): PersonChange {
  const out: PersonChange = {};
  if (r.tags != null) out.tags = r.tags;
  if (r.notes != null) out.notes = r.notes;
  if (r.call_name !== undefined) out.call_name = r.call_name;
  if (r.blocked != null) out.blocked = r.blocked;
  return out;
}

function validate(request: PersonChange): void {
  if (request.notes !== undefined && chars(request.notes) > MAX_NOTES_CHARS) {
    throw ApiError.badRequest(`notes are longer than ${MAX_NOTES_CHARS} characters`);
  }
  if (
    typeof request.call_name === "string" &&
    chars(request.call_name.trim()) > MAX_CALL_NAME_CHARS
  ) {
    throw ApiError.badRequest(`call_name is longer than ${MAX_CALL_NAME_CHARS} characters`);
  }
}

function applyUpdate(
  ctx: PeopleCtx,
  person: PersonId,
  request: PersonChange,
  wanted: string[] | null,
  now: number,
): void {
  const heart = ctx.heart;
  if (wanted !== null) {
    const current = heart.get(person)?.tags ?? [];
    const kept = current.filter((t) => t === BLOCKED_TAG);
    heart.edit(person, { tags: [...kept, ...wanted] }, { now });
  }
  if (request.blocked !== undefined) heart.setTag(person, BLOCKED_TAG, request.blocked, { now });
  if (request.call_name !== undefined) {
    heart.edit(person, { call_name: request.call_name?.trim() || null }, { now });
  }
  // The panel's notes are her impression of them.
  if (request.notes !== undefined)
    heart.edit(person, { impression: request.notes.trim() }, { now });
}

/** `PATCH /api/people/{id}`. */
async function update(
  state: ApiState,
  c: ApiContext,
  id: string,
  body: UpdatePersonRequest,
): Promise<PersonSummary> {
  const request = changeOf(body);
  const person = parsePerson(id);
  validate(request);
  const wanted = request.tags ? cleanTags(request.tags) : null;
  const ctx = new PeopleCtx(state);
  if (!(await ctx.person(person))) throw unknownPerson(id);
  let failure: unknown = null;
  try {
    applyUpdate(ctx, person, request, wanted, state.now());
  } catch (error) {
    failure = error;
  }
  const detailJson = toJson(request) as Record<string, unknown>;
  if (failure !== null) detailJson.error = ApiError.internal(failure).message;
  await state.audit(c, "person.update", person, toJson(detailJson), failure === null);
  if (failure !== null) throw ApiError.internal(failure);
  return ctx.requireSummary(person);
}

/** `POST /api/people/{id}/adjust`: adds to the bond, ignoring caps (cause `admin`). */
async function adjust(
  state: ApiState,
  c: ApiContext,
  id: string,
  request: AdjustPersonRequest,
): Promise<PersonSummary> {
  const person = parsePerson(id);
  if (!Number.isFinite(request.affinity) || Math.abs(request.affinity) > 1100) {
    throw ApiError.badRequest("`affinity` must be a number between -1100 and 1100");
  }
  const ctx = new PeopleCtx(state);
  if (!(await ctx.person(person))) throw unknownPerson(id);
  let failure: unknown = null;
  try {
    const bond = ctx.row(person)?.bond ?? 0;
    ctx.heart.adminSet(person, "bond", bond + request.affinity, {
      now: state.now(),
      quote: `adjust by ${actorOf(c)}`,
    });
  } catch (error) {
    failure = error;
  }
  await state.audit(c, "person.adjust", person, { affinity: request.affinity }, failure === null);
  if (failure !== null) throw ApiError.internal(failure);
  return ctx.requireSummary(person);
}

/** The people routes on the route table (`@miyoria/contracts/api`). */
export const peopleRpc = {
  list: os.people.list.handler(({ input, context }) => list(context.state, input.query)),
  get: os.people.get.handler(({ input, context }) => detail(context.state, input.params.id)),
  update: os.people.update.handler(({ input, context }) =>
    update(context.state, context.c, input.params.id, input.body),
  ),
  adjust: os.people.adjust.handler(({ input, context }) =>
    adjust(context.state, context.c, input.params.id, input.body),
  ),
};
