// Whether she is in a voice channel now, for the rooms (a room opens, starts and stays open only
// while she is). It follows her own voice connection's events, one channel per server:
//
// - `voice.joined`: she is in that channel of that server (a move to another channel of the same
//   server is a `joined` with no `left` before it, so the server's old channel is replaced).
// - `voice.participants`: who is in her channel changed; it names her channel too, so it also says
//   she is there (a voice node that reconnects reports its channels with it).
// - `voice.left`: she left that server's voice (also when the voice node went away).
//
// Without a channel from the events (Core started while she was in one, or an event was missed),
// the voice node's own state is asked about one server (the comment channel's). The page asks Core
// again every second or two while she is not in voice, so its button follows her joining.

import type { ContextKey } from "@miyoria/types";

export class VoicePresence {
  /** Server → the voice channel she is in there. */
  readonly #channels = new Map<string, string>();
  readonly #fallback: () => boolean;

  /** `fallback`: whether the voice node says she is in a channel now. */
  constructor(fallback: () => boolean) {
    this.#fallback = fallback;
  }

  joined(context: ContextKey): void {
    this.#channels.set(serverOf(context), context.channel);
  }

  /** Who is in her channel changed: she is in that channel. */
  participants(context: ContextKey): void {
    this.#channels.set(serverOf(context), context.channel);
  }

  left(context: ContextKey): void {
    const server = serverOf(context);
    // A `left` of a channel she already moved away from says nothing about the one she is in.
    const now = this.#channels.get(server);
    if (now === undefined || now === context.channel) this.#channels.delete(server);
  }

  /** She is in a voice channel now. */
  inVoice(): boolean {
    if (this.#channels.size > 0) return true;
    return this.#fallback();
  }
}

function serverOf(context: ContextKey): string {
  return `${context.platform}:${context.scope ?? ""}`;
}
