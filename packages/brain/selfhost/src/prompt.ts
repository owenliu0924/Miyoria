// The blocks around the transcript (`PromptSource`), read from the services today's turn reads
// (agent/turn.ts `#extras`, `#mainPrompt`); no new memory:
//
//   1 fixed     the persona core (`PersonaHandle.corePrompt`); the runner adds its rules
//   3 pinned    the owner's rules (`MainLine.ownerRules`: directives, capabilities on hold)
//   4 place     the recap of this place (`ConversationStates`), the people here as person cards
//               (`PersonProfiles.render`, else today's `<person/>` lines, `peopleBody`) and the
//               persona's example dialogues, rotated per session. Rendered again only when the
//               people here change or the transcript was compacted
//   6 recalled  what memory retrieval finds for this run (`MemoryRetrieval`), the contributors'
//               sections (just now, elsewhere, ...: everything but the memory contributor and the
//               recap), and the flagged messages the transcript points to, each under its title
//   7 now       time and place, her state (`selfBlocks`), what she promised and by when
//
// Each source keeps today's limit (`contributor_timeout_ms`); a source that fails or is slow is
// left out, the run goes on.

import {
  FLAGGED_TITLE,
  flaggedBody,
  type TranscriptEntry,
  type TranscriptStore,
} from "@miyoria/memory/transcript";
import { errorMessage } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  ActivityManagerKey,
  AffectStateKey,
  ArbiterKey,
  type ContextKey,
  ConversationStatesKey,
  dataBlock,
  GoalAgendaKey,
  MemoryRetrievalKey,
  MindKey,
  type Participant,
  PersonProfilesKey,
  PromptContributorsKey,
  type PromptRequest,
  SelfStateKey,
  safeName,
  sameAccount,
  type TurnRetrievalQuery,
  toTimestamp,
  WorldStateKey,
} from "@miyoria/types";
import {
  type Agent,
  budgetBlocks,
  budgetSelf,
  contributedData,
  exampleDialogues,
  examplesBlock,
  gather,
  levelHint,
  PRESENT_TITLE,
  type PresentPerson,
  peopleBody,
  pinnedSection,
  rotatedExamples,
  selfBlocks,
  stableHash,
  timeout,
  truncate,
  whenAndWhere,
} from "../../agent/src/index.js";
import { type PromptInput, type PromptSource, wakeAuthor } from "../../self/src/index.js";

/** People shown in block 4 at most (today's `MAX_PEOPLE`). */
const MAX_PEOPLE = 10;
/** Lines before the run the contributors see (today's `CONTRIBUTOR_HISTORY`). */
const CONTRIBUTOR_HISTORY = 6;
/** Newest lines the flagged block looks through (today's `FLAGGED_HISTORY`). */
const FLAGGED_LINES = 12;
/** The waking author's newest lines that make the query. */
const QUERY_LINES = 3;
/** Contributors whose words come from elsewhere here: memory (retrieval), the recap (block 4). */
const MEMORY_CONTRIBUTOR = "memory";
const RECAP_CONTRIBUTOR = "conversation";
/** Contributor sections today's turn puts before the history; the runner leaves them out. */
const SLOW_SECTIONS: ReadonlySet<string> = new Set(["server_emoji", "notebook"]);
/** The recap's title (the conversation contributor's). */
export const RECAP_TITLE = "這段對話的前情提要";

/** Someone who spoke in a place, newest first. */
export interface Speaker {
  account: AccountRef;
  name: string;
}

/** The people who spoke in `entries`, newest first, bots and tombstones left out. */
export function speakersOf(entries: readonly TranscriptEntry[], max = MAX_PEOPLE): Speaker[] {
  const out: Speaker[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < max; i--) {
    const e = entries[i] as TranscriptEntry;
    if (e.kind !== "other" || e.bot || e.account === null || e.redacted_at !== null) continue;
    if (out.some((s) => sameAccount(s.account, e.account as AccountRef))) continue;
    out.push({ account: e.account, name: e.author ?? e.account.id });
  }
  return out;
}

/** `name: text` of the other people's lines (hers as `name`), the way contributors read lines. */
function lineText(e: TranscriptEntry, her: string): string | null {
  if (e.redacted_at !== null || e.content.trim() === "") return null;
  if (e.kind === "other") return `${safeName(e.author ?? "")}: ${e.content}`;
  if (e.kind === "self" || (e.kind === "tool_calls" && e.content !== "")) {
    return `${her}: ${e.content}`;
  }
  return null;
}

interface PlaceCache {
  key: string;
  text: string | null;
}

export interface HostPromptOptions {
  transcript: TranscriptStore;
  /** The session a place's transcript is under. */
  sessionOf(context: ContextKey): string;
}

export class HostPrompt implements PromptSource {
  readonly #agent: Agent;
  readonly #o: HostPromptOptions;
  /** Block 4 of each session as last rendered. */
  readonly #places = new Map<string, PlaceCache>();

  constructor(agent: Agent, options: HostPromptOptions) {
    this.#agent = agent;
    this.#o = options;
  }

  get #services() {
    return this.#agent.ctx.services;
  }

  /** Minutes east of UTC, as today's prompt takes them (the machine's zone). */
  #offset(now: number): number {
    return -new Date(now).getTimezoneOffset();
  }

  #limit(): number {
    return this.#agent.config.contributor_timeout_ms;
  }

  #present(speakers: readonly Speaker[]): PresentPerson[] {
    return speakers.map((s) => ({
      account: s.account,
      handle: this.#agent.handleOf(s.account, s.name),
      person: this.#agent.attitude(s.account)?.person ?? null,
      speaker: false,
    }));
  }

  // ---- block 1 ---------------------------------------------------------------------------------

  async fixed(): Promise<string | null> {
    return this.#agent.persona.corePrompt();
  }

  // ---- block 3 ---------------------------------------------------------------------------------

  async pinned(input: PromptInput): Promise<string | null> {
    const context = input.session.context;
    const rules = this.#agent.mainline.ownerRules(context);
    return pinnedSection(rules, [], input.now, this.#offset(input.now));
  }

  // ---- block 4 ---------------------------------------------------------------------------------

  async place(input: PromptInput): Promise<string | null> {
    const session = input.session.id;
    const tail = this.#o.transcript.tail(session);
    const speakers = speakersOf(tail.entries);
    const roster = speakers
      .map((s) => `${s.account.platform}:${s.account.id}`)
      .sort()
      .join(",");
    const key = `${roster}|${tail.summary?.id ?? 0}`;
    const cached = this.#places.get(session);
    if (cached !== undefined && cached.key === key) return cached.text;
    const text = await this.#renderPlace(input, speakers);
    this.#places.set(session, { key, text });
    return text;
  }

  /** Forgets block 4 of `session` (its people or its transcript changed under it). */
  forget(session: string): void {
    this.#places.delete(session);
  }

  async #renderPlace(input: PromptInput, speakers: readonly Speaker[]): Promise<string | null> {
    const agent = this.#agent;
    const context = input.session.context;
    const parts: string[] = [];
    const recap = this.#services.get(ConversationStatesKey)?.get(context)?.recap?.trim() ?? "";
    if (recap !== "") parts.push(dataBlock(RECAP_CONTRIBUTOR, RECAP_TITLE, recap));
    const people = await this.#people(input, speakers);
    if (people !== null) parts.push(dataBlock("people", PRESENT_TITLE, people));
    const chars = agent.config.mainline.examples_chars;
    if (chars > 0) {
      const dialogues = exampleDialogues(agent.persona.examples());
      const picked = rotatedExamples(dialogues, stableHash(input.session.id), chars);
      const examples = examplesBlock(picked, agent.persona.names());
      if (examples !== null) parts.push(examples);
    }
    return parts.length === 0 ? null : parts.join("\n\n");
  }

  async #people(input: PromptInput, speakers: readonly Speaker[]): Promise<string | null> {
    const agent = this.#agent;
    const present = this.#present(speakers);
    if (present.length === 0) return null;
    const chars = agent.config.mainline.people_chars;
    const profiles = this.#services.get(PersonProfilesKey);
    if (profiles !== undefined && chars > 0) {
      try {
        const where = {
          context: input.session.context,
          present: present.flatMap((p) => (p.person === null ? [] : [p.person])),
          talking_with: [],
          accounts: present.map((p) => p.account),
          now: toTimestamp(input.now),
        };
        const body = await timeout(this.#limit(), agent.ctx.signal, (s) =>
          profiles.render(where, chars, {}, s),
        );
        return body.trim() === "" ? null : body.trim();
      } catch (error) {
        agent.log.debug({ err: errorMessage(error) }, "no person profiles for the runner");
      }
    }
    const services = this.#services;
    const body = peopleBody(present, {
      affect: services.get(AffectStateKey) ?? null,
      attitude: (a) => agent.attitude(a),
      self: services.get(SelfStateKey) ?? null,
    });
    return body === "" ? null : body;
  }

  // ---- block 6 ---------------------------------------------------------------------------------

  async recalled(input: PromptInput): Promise<string | null> {
    const agent = this.#agent;
    const cfg = agent.config;
    const services = this.#services;
    const tail = this.#o.transcript.tail(input.session.id);
    const request = this.#request(input, tail.entries);
    const retrieval = services.get(MemoryRetrievalKey);
    const skip = [RECAP_CONTRIBUTOR, ...(retrieval ? [MEMORY_CONTRIBUTOR] : [])];
    const registry = services.get(PromptContributorsKey);
    const gathering =
      registry && registry.all().length > 0
        ? gather(registry, request, this.#limit(), agent.ctx.signal, skip)
        : null;
    gathering?.catch(() => undefined);
    const blocks: string[] = [];
    const memory = await this.#memory(input, request);
    if (memory !== null) blocks.push(memory);
    const gathered = gathering === null ? null : await gathering.catch(() => null);
    const sections = (gathered?.sections ?? []).filter((s) => !SLOW_SECTIONS.has(s.key));
    const { data } = contributedData(sections);
    const m = cfg.mainline;
    const contributed = budgetBlocks(data, {
      total: m.data_chars,
      budgets: { ...cfg.prompt.budgets, just_now: m.just_now_chars, elsewhere: m.elsewhere_chars },
      defaultBudget: cfg.prompt.default_budget,
    });
    blocks.push(...contributed.blocks);
    const flagged = flaggedBody(tail.entries.slice(-FLAGGED_LINES));
    if (flagged !== "") blocks.push(dataBlock("flagged", FLAGGED_TITLE, flagged));
    return blocks.length === 0 ? null : blocks.join("\n\n");
  }

  async #memory(input: PromptInput, request: PromptRequest): Promise<string | null> {
    const agent = this.#agent;
    const retrieval = this.#services.get(MemoryRetrievalKey);
    if (!retrieval || request.query.trim() === "") return null;
    const m = agent.config.mainline;
    const now = toTimestamp(input.now);
    try {
      const query: TurnRetrievalQuery = {
        context: input.session.context,
        present: request.participants.flatMap((p) => (p.person === null ? [] : [p.person])),
        accounts: request.participants.map((p) => p.account),
        now,
        text: request.query,
        recent: request.recent.slice(-m.memory_recent_lines),
        talking_with: request.participants.flatMap((p) =>
          p.person !== null && request.speakers.some((s) => sameAccount(s, p.account))
            ? [p.person]
            : [],
        ),
        ...(m.memory_lines > 0 ? { limit: m.memory_lines } : {}),
      };
      const memories = await timeout(this.#limit(), agent.ctx.signal, (signal) =>
        retrieval.retrieve(query, signal),
      );
      const body = retrieval.format(memories, now);
      if (body.trim() === "") return null;
      return dataBlock("memory", "你記得的事", truncate(body, Math.floor(m.data_chars / 2)));
    } catch (error) {
      agent.log.debug({ err: errorMessage(error) }, "no memories for the runner");
      return null;
    }
  }

  /** What the contributors are told of this run (today's `#promptRequest`). */
  #request(input: PromptInput, entries: readonly TranscriptEntry[]): PromptRequest {
    const agent = this.#agent;
    const her = agent.persona.displayName();
    const speakers = speakersOf(entries);
    const participants: Participant[] = speakers.map((s) => ({
      account: s.account,
      display_name: s.name,
      person: agent.attitude(s.account)?.person ?? null,
    }));
    const author = wakeAuthor(input.wake);
    if (author !== null && !participants.some((p) => sameAccount(p.account, author.account))) {
      participants.push({
        account: author.account,
        display_name: author.name,
        person: agent.attitude(author.account)?.person ?? null,
      });
    }
    // Since her last line: what the run is about.
    let since = entries.length;
    while (since > 0) {
      const e = entries[since - 1] as TranscriptEntry;
      if (e.kind === "self" || e.kind === "tool_calls") break;
      since -= 1;
    }
    const fresh = entries.slice(since).filter((e) => e.kind === "other" && e.redacted_at === null);
    const wake = input.wake;
    let query: string;
    let asked: TranscriptEntry[];
    if (wake.kind === "result") {
      query = wake.text;
      asked = [];
    } else if (wake.kind === "timer") {
      query = wake.note;
      asked = [];
    } else if (wake.kind === "world") {
      query = wake.what;
      asked = [];
    } else {
      const theirs =
        author === null
          ? fresh
          : fresh.filter((e) => e.account !== null && sameAccount(e.account, author.account));
      asked = theirs.slice(-QUERY_LINES);
      query = asked.map((e) => lineText(e, her) ?? "").join("\n");
    }
    const first = asked[0];
    const before = (first === undefined ? entries : entries.slice(0, entries.indexOf(first)))
      .map((e) => lineText(e, her))
      .filter((l): l is string => l !== null);
    return {
      profile: agent.persona.read((p) => p.id),
      turn: input.turn,
      context: input.session.context,
      participants,
      speakers: author === null ? [] : [author.account],
      query,
      recent: before.slice(-CONTRIBUTOR_HISTORY),
      voice: false,
      now: toTimestamp(input.now),
    };
  }

  // ---- block 7 ---------------------------------------------------------------------------------

  async now(input: PromptInput): Promise<string | null> {
    const agent = this.#agent;
    const services = this.#services;
    const context = input.session.context;
    const offset = this.#offset(input.now);
    const tail = this.#o.transcript.tail(input.session.id);
    const present = this.#present(speakersOf(tail.entries));
    const own = selfBlocks({
      context,
      now: input.now,
      affect: services.get(AffectStateKey) ?? null,
      activity: services.get(ActivityManagerKey)?.snapshot() ?? null,
      ledger: services.get(ArbiterKey)?.ledger(context) ?? null,
      goals: services.get(GoalAgendaKey)?.goals() ?? null,
      present: present.map((p) => p.handle),
      mood: agent.mood(),
      self: services.get(SelfStateKey) ?? null,
      her: services.get(WorldStateKey)?.snapshot().her ?? null,
      unanswered: services.get(MindKey)?.unanswered?.(context) ?? [],
      level: levelHint(agent.handle.channelMode(context), context),
      notices: [],
    });
    const lines = [whenAndWhere(context, new Date(input.now), offset)];
    for (const note of budgetSelf(own, agent.config.mainline.self_chars).notes) {
      const block = note.trim();
      if (block !== "") lines.push(block);
    }
    const promised = pinnedSection([], agent.mainline.commitments.open(context), input.now, offset);
    if (promised !== null) lines.push(promised);
    return lines.join("\n");
  }
}
