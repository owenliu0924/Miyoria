// What her room's page knows (docs/design/her-room.md §7.3): the room's state, the backlog, her
// current turn (its lines are the steps of her reply, one on the stage at a time), the member's own
// last line, sends still on their way (two tabs: `client_id` tells this tab's own apart), her bond
// changes and the stream's link. A pure reducer over the room's events and the page's own actions;
// no DOM, no timers.

import type { RoomBacklog, RoomEntry, RoomEvent, RoomFile, RoomSendResult, RoomState } from "@miyoria/contracts/api";

/** How the room's stream is going. */
export type RoomLink = "connecting" | "open" | "retrying";

/** One line of hers on the stage. */
export interface StageLine {
  id: string;
  text: string;
  files: RoomFile[];
  /** `roomVoicePath(id)` can be played. */
  voice: boolean;
}

/** Her reply going on (or the last one): its lines are the steps, `shown` the one on the stage. */
export interface HerTurn {
  /** `null`: lines that came without a turn (a result she was waiting for, a reminder). */
  id: string | null;
  phase: "thinking" | "speaking" | "done";
  lines: StageLine[];
  /** The step on the stage; -1 before her first line. */
  shown: number;
  /** A tool of hers running now, in a few words (`查資料`). */
  step: string | null;
  /** She is typing the next line. */
  typing: boolean;
}

/** The member's own line, faint above hers. */
export interface YouLine {
  /** The line's id once the Core gave it one. */
  id: string | null;
  /** This tab's id for the send, `null` for a line sent elsewhere. */
  client_id: string | null;
  text: string;
  files: RoomFile[];
  at: string;
  status: "sending" | "sent";
}

export interface BondChange {
  id: string;
  sign: "plus" | "minus";
  quote: string | null;
}

export interface Notice {
  text: string;
  /** `error`: something did not go through; `quiet`: she heard it but will not answer now. */
  tone: "error" | "quiet";
}

export interface RoomModel {
  state: RoomState | null;
  link: RoomLink;
  /** The backlog, oldest first; the stream's lines are added as they come. */
  entries: RoomEntry[];
  /** The cursor for the page before the oldest entry; `null`: nothing older. */
  older: string | null;
  /** The first page of the backlog is in. */
  loaded: boolean;
  turn: HerTurn | null;
  you: YouLine | null;
  /** This tab's sends the Core has not confirmed yet, by `client_id`. */
  pending: YouLine[];
  /** This tab's recent `client_id`s, so its own line coming back on the stream is known again. */
  mine: string[];
  /** Her face in this room's last line. */
  face: string | null;
  /** Her bond's last change in this conversation, shown in the corner for a while. */
  bond: BondChange | null;
  /** Her emoji answers, by the line they answer. */
  reactions: Record<string, string>;
  notice: Notice | null;
}

export type RoomAction =
  | { type: "event"; event: RoomEvent }
  | { type: "link"; link: RoomLink }
  | { type: "state"; state: RoomState }
  | { type: "backlog"; page: RoomBacklog; mode: "first" | "older" | "reset" }
  | { type: "send"; client_id: string; text: string; files: RoomFile[]; at: string }
  | { type: "sent"; client_id: string; result: RoomSendResult }
  | { type: "failed"; client_id: string; message: string }
  | { type: "advance" }
  | { type: "notice"; notice: Notice | null }
  | { type: "excluded"; id: string };

/** How many of this tab's sends are remembered for the stream's echo. */
const MINE_KEPT = 32;

export function initialModel(): RoomModel {
  return {
    state: null,
    link: "connecting",
    entries: [],
    older: null,
    loaded: false,
    turn: null,
    you: null,
    pending: [],
    mine: [],
    face: null,
    bond: null,
    reactions: {},
    notice: null,
  };
}

/** Whether her reply has a step after the one on the stage. */
export function hasMore(turn: HerTurn | null): boolean {
  return turn !== null && turn.shown < turn.lines.length - 1;
}

/** The step on the stage, or `null`. */
export function shownLine(turn: HerTurn | null): StageLine | null {
  return turn && turn.shown >= 0 ? (turn.lines[turn.shown] ?? null) : null;
}

/** She is working on a reply in this room. */
export function isAnswering(turn: HerTurn | null): boolean {
  return turn !== null && turn.phase !== "done";
}

/** Her newest line in the backlog, for the stage when nothing is going on. */
export function lastHerLine(entries: readonly RoomEntry[]): StageLine | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as RoomEntry;
    if (e.type !== "line") continue;
    if (e.who !== "her") return null;
    return { id: e.id, text: e.text, files: e.files, voice: false };
  }
  return null;
}

/** Entries with `add` merged in by id, oldest first (`at`, then the order they came in). */
function merge(entries: readonly RoomEntry[], add: readonly RoomEntry[], where: "before" | "after"): RoomEntry[] {
  const seen = new Set(entries.map((e) => e.id));
  const fresh = add.filter((e) => !seen.has(e.id));
  if (fresh.length === 0) return entries as RoomEntry[];
  return where === "before" ? [...fresh, ...entries] : [...entries, ...fresh];
}

function addEntry(m: RoomModel, entry: RoomEntry): RoomEntry[] {
  return merge(m.entries, [entry], "after");
}

function newTurn(id: string | null, phase: HerTurn["phase"]): HerTurn {
  return { id, phase, lines: [], shown: -1, step: null, typing: false };
}

function onEvent(m: RoomModel, e: RoomEvent): RoomModel {
  switch (e.kind) {
    case "hello": {
      const link: RoomLink = "open";
      if (e.turn === null) {
        // Nothing going on: a turn that was still thinking when the stream broke is over.
        const turn = m.turn && m.turn.phase !== "done" ? { ...m.turn, phase: "done" as const, step: null, typing: false } : m.turn;
        return { ...m, link, state: e.state, turn };
      }
      if (m.turn?.id === e.turn.id) return { ...m, link, state: e.state };
      return { ...m, link, state: e.state, turn: newTurn(e.turn.id, e.turn.phase) };
    }
    case "state":
      return { ...m, state: e.state };
    case "you": {
      const files = e.files;
      const entries = addEntry(m, { type: "line", id: e.id, at: e.at, who: "you", text: e.text, files });
      const mine = e.client_id !== null && m.mine.includes(e.client_id);
      const pending = mine ? m.pending.filter((p) => p.client_id !== e.client_id) : m.pending;
      const line: YouLine = { id: e.id, client_id: e.client_id, text: e.text, files, at: e.at, status: "sent" };
      // This tab's own send: the line is already on the stage. A line sent by another tab, or the
      // answer after this tab's newer send: only the newest stays on the stage.
      if (m.you && m.you.client_id !== null && m.you.client_id === e.client_id) return { ...m, entries, pending, you: { ...m.you, id: e.id, status: "sent" } };
      if (mine) return { ...m, entries, pending };
      return { ...m, entries, pending, you: line };
    }
    case "thinking":
      if (m.turn?.id === e.turn && m.turn.phase !== "done") return m;
      return { ...m, turn: newTurn(e.turn, "thinking") };
    case "typing":
      if (!m.turn || m.turn.phase === "done") return m;
      return { ...m, turn: { ...m.turn, typing: true } };
    case "step": {
      if (!m.turn || m.turn.id !== e.turn) return m;
      return { ...m, turn: { ...m.turn, step: e.state === "started" ? e.label : null } };
    }
    case "line": {
      const entries = addEntry(m, { type: "line", id: e.id, at: e.at, who: "her", text: e.text, files: e.files });
      const line: StageLine = { id: e.id, text: e.text, files: e.files, voice: e.voice };
      const current = m.turn;
      if (current?.lines.some((l) => l.id === e.id)) return { ...m, entries };
      if (current && (e.turn === null ? current.phase !== "done" : current.id === e.turn)) {
        const lines = [...current.lines, line];
        return {
          ...m,
          entries,
          turn: { ...current, phase: "speaking", lines, shown: Math.max(current.shown, 0), typing: false },
        };
      }
      // A line of a turn not seen start (a reconnect), or one with no turn at all.
      const turn: HerTurn = { ...newTurn(e.turn, e.turn === null ? "done" : "speaking"), lines: [line], shown: 0 };
      return { ...m, entries, turn };
    }
    case "face":
      return { ...m, face: e.face };
    case "reaction":
      return { ...m, reactions: { ...m.reactions, [e.to]: e.emoji } };
    case "done":
      if (!m.turn || m.turn.id !== e.turn) return m;
      return { ...m, turn: { ...m.turn, phase: "done", step: null, typing: false } };
    case "bond": {
      const entries = addEntry(m, { type: "mark", id: e.id, at: e.at, sign: e.sign, quote: e.quote });
      return { ...m, entries, bond: { id: e.id, sign: e.sign, quote: e.quote } };
    }
    case "reset":
    case "ping":
      return m;
  }
}

export function reduce(m: RoomModel, a: RoomAction): RoomModel {
  switch (a.type) {
    case "event":
      return onEvent(m, a.event);
    case "link":
      return m.link === a.link ? m : { ...m, link: a.link };
    case "state":
      return { ...m, state: a.state };
    case "backlog": {
      if (a.mode === "older") return { ...m, entries: merge(m.entries, a.page.entries, "before"), older: a.page.older };
      if (a.mode === "reset") return { ...m, entries: a.page.entries, older: a.page.older, loaded: true };
      // The first page: lines the stream brought meanwhile stay after it.
      const page = a.page.entries;
      const inPage = new Set(page.map((e) => e.id));
      return { ...m, entries: [...page, ...m.entries.filter((e) => !inPage.has(e.id))], older: a.page.older, loaded: true };
    }
    case "send": {
      const line: YouLine = { id: null, client_id: a.client_id, text: a.text, files: a.files, at: a.at, status: "sending" };
      return { ...m, pending: [...m.pending, line], mine: [...m.mine, a.client_id].slice(-MINE_KEPT), you: line, notice: null };
    }
    case "sent": {
      const { client_id, result } = a;
      const was = m.pending.find((p) => p.client_id === client_id);
      const pending = m.pending.filter((p) => p.client_id !== client_id);
      const notice: Notice | null = result.heard !== "ok" && result.notice ? { text: result.notice, tone: "quiet" } : m.notice;
      // Its `you` event may not come (the stream is down): the answer puts it in the backlog too.
      const entries = was
        ? addEntry(m, { type: "line", id: result.id, at: result.at, who: "you", text: was.text, files: was.files })
        : m.entries;
      const you = m.you && m.you.client_id === client_id ? { ...m.you, id: result.id, at: result.at, status: "sent" as const } : m.you;
      return { ...m, pending, entries, you, notice };
    }
    case "failed": {
      const pending = m.pending.filter((p) => p.client_id !== a.client_id);
      const you = m.you && m.you.client_id === a.client_id ? null : m.you;
      return { ...m, pending, you, notice: { text: a.message, tone: "error" } };
    }
    case "advance": {
      if (!m.turn || !hasMore(m.turn)) return m;
      return { ...m, turn: { ...m.turn, shown: m.turn.shown + 1 } };
    }
    case "notice":
      return { ...m, notice: a.notice };
    case "excluded":
      return { ...m, entries: m.entries.filter((e) => e.id !== a.id) };
  }
}
