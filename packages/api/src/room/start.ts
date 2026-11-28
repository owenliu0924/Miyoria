// Her room inside the `api` module (docs/design/her-room.md §2): the `web` platform. Started with
// the module when `[modules.api.room] enabled` (and the public side) is on, stopped with it:
//
// * registers the room's sink (`WebSink`) and says the platform is ready, with `ROOM_SELF` as her
//   account there, so the chat record and the host know her own lines;
// * provides `IncomingFilesKey` (the room's uploads, for the downloaders);
// * follows the bus for this room's turns (`thinking`, `step`, `face`, `done`) and for what changes
//   the room's state, and the heart for her bond moving in a turn of this room (`bond`).
//
// Every event goes to the hub of the account whose room it is, found from the event's own context
// (`roomAccount`) or turn; none is ever sent to every room.

import type { RoomState } from "@miyoria/contracts/api";
import { RoomFaceSchema } from "@miyoria/contracts/api";
import { errorMessage, interval, type ModuleContext } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  Events,
  type HeartChange,
  HeartKey,
  type HeartPeople,
  IncomingFilesKey,
  is,
  PlatformSinksKey,
  ROOM_PLATFORM,
  ROOM_SELF,
  roomAccount,
} from "@miyoria/types";
import { loadMemberOf } from "../member.js";
import type { ApiState } from "../state.js";
import { isBondMark, markId, markQuote } from "./backlog.js";
import type { RoomHub } from "./channel.js";
import type { Room } from "./room.js";
import { WebSink } from "./sink.js";
import { roomState } from "./state.js";
import { stepLabel } from "./texts.js";

/** What may change the room's state (the push `status` topic's triggers, and the budget). */
export const ROOM_STATE_TRIGGERS = [
  "activity.*",
  "sing.*",
  "speech.pause",
  "voice.joined",
  "voice.left",
  "voice.golive",
  "llm.budget",
] as const;

const TURN_TOPICS = [
  Events.AgentTurnStarted.type,
  Events.AgentToolRunning.type,
  Events.AgentEmotion.type,
  Events.AgentTurnCompleted.type,
];

/** How often the watched rooms' state is looked at again anyway (the quota frees up, voice). */
const STATE_EVERY_MS = 15_000;
/** A room's `state` goes out at most this often. */
const STATE_AT_MOST_MS = 1_000;

/** Works out a hub's state again and tells its streams when it changed. */
async function refresh(state: ApiState, room: Room, hub: RoomHub): Promise<void> {
  if (hub.streams === 0) return;
  let now: RoomState;
  try {
    now = await roomState(state, room, hub.account);
  } catch {
    return;
  }
  const text = JSON.stringify(now);
  if (text === hub.sentState) return;
  hub.sentState = text;
  hub.tell({ kind: "state", state: now });
}

/** Her bond moved in a turn of someone's room: that room gets the mark, nobody else. */
async function onChanged(state: ApiState, room: Room, change: HeartChange): Promise<void> {
  if (!isBondMark(change) || change.turn === null) return;
  const account: AccountRef | undefined = room.channel.turnOf(change.turn);
  if (account === undefined) return;
  const member = await loadMemberOf(state, account);
  // Her feel about someone else in this room's turn is that person's bond, not this one's.
  if (member.person?.id !== change.person || member.hidden) return;
  room.channel.hub(account).push({
    kind: "bond",
    id: markId(change.turn, change.at),
    at: change.at,
    turn: change.turn,
    sign: change.delta > 0 ? "plus" : "minus",
    quote: await markQuote(state, member, change.quote),
  });
}

/** Starts the room; everything it started ends when the module's signal does. */
export function startRoom(ctx: ModuleContext, state: ApiState, room: Room): void {
  const sinks = ctx.services.require(PlatformSinksKey);
  const sink = new WebSink(state, room);
  sinks.register(sink);
  ctx.provide(IncomingFilesKey, room.uploads);
  ctx.publish(Events.PlatformReady, { platform: ROOM_PLATFORM, self_account: ROOM_SELF });

  let dirty = false;
  const turns = ctx.subscribe(TURN_TOPICS);
  ctx.spawn("room.turns", async () => {
    for await (const env of turns) {
      if (is(Events.AgentTurnStarted, env)) {
        const account = roomAccount(env.data.context);
        if (account === null) continue;
        const hub = room.channel.hub(account);
        room.channel.turnIn(env.data.turn, account);
        hub.lastTurn = env.data.turn;
        hub.turn = { id: env.data.turn, phase: "thinking" };
        hub.tools.clear();
        hub.push({ kind: "thinking", turn: env.data.turn });
      } else if (is(Events.AgentToolRunning, env)) {
        const account = roomAccount(env.data.context);
        if (account === null) continue;
        const hub = room.channel.hub(account);
        const key = `${env.data.turn}:${env.data.tool}`;
        if (env.data.state === "started") hub.tools.set(key, env.data.tool);
        else hub.tools.delete(key);
        hub.push({
          kind: "step",
          turn: env.data.turn,
          label: stepLabel(env.data.tool),
          state: env.data.state,
        });
        dirty = true;
      } else if (is(Events.AgentEmotion, env)) {
        const account = roomAccount(env.data.context);
        const face = RoomFaceSchema.safeParse(env.data.emotion);
        if (account === null || !face.success) continue;
        const hub = room.channel.hub(account);
        hub.face = face.data;
        hub.push({ kind: "face", turn: env.data.turn, face: face.data });
      } else if (is(Events.AgentTurnCompleted, env)) {
        const account = roomAccount(env.data.context);
        if (account === null) continue;
        const hub = room.channel.hub(account);
        if (hub.turn?.id === env.data.turn) hub.turn = null;
        if (hub.tools.size > 0) dirty = true;
        for (const k of [...hub.tools.keys()])
          if (k.startsWith(`${env.data.turn}:`)) hub.tools.delete(k);
        hub.push({ kind: "done", turn: env.data.turn });
      }
    }
  });

  const changes = ctx.subscribe([...ROOM_STATE_TRIGGERS]);
  ctx.spawn("room.state.events", async () => {
    for await (const _ of changes) dirty = true;
  });

  // The heart is another module's: followed while it is there, and again after it restarts.
  let heart: HeartPeople | undefined;
  let unfollow: (() => void) | null = null;
  const follow = () => {
    const now = ctx.services.get(HeartKey);
    if (now === heart) return;
    unfollow?.();
    unfollow = null;
    heart = now;
    if (now?.onChanged === undefined) return;
    unfollow = now.onChanged((change) => {
      onChanged(state, room, change).catch((error: unknown) =>
        ctx.log.warn({ error: errorMessage(error) }, "room: cannot tell a bond mark"),
      );
    });
  };
  follow();

  ctx.spawn("room.state", async (signal) => {
    let last = 0;
    for await (const _ of interval(STATE_AT_MOST_MS, signal)) {
      follow();
      room.uploads.sweep();
      const now = ctx.clock.now();
      if (!dirty && now - last < STATE_EVERY_MS) continue;
      dirty = false;
      last = now;
      for (const hub of room.channel.watched()) await refresh(state, room, hub);
    }
  });

  ctx.signal.addEventListener(
    "abort",
    () => {
      unfollow?.();
      if (sinks.get(ROOM_PLATFORM) === sink) sinks.unregister(ROOM_PLATFORM);
      room.uploads.clear();
    },
    { once: true },
  );
}
