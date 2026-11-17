// `[modules.karaoke]` (docs/design/karaoke.md 「做了什麼(第一步)」): single-player karaoke on the
// member page. The module's own switch is `enabled` (the system page); `open` closes asking for
// and singing songs while the module keeps running (results and her comments still arrive). No
// coins in this milestone: a person singing alone gets none (owner 2026-11-17).

import { setting, settingGroups } from "@miyoria/runtime/kernel";
import { z } from "zod";

/** A Discord text channel as a context key, `discord:<guild>:<channel>` (empty: none). */
const channel = () =>
  z
    .string()
    .regex(/^(discord:\d{5,30}:\d{5,30})?$/, "discord:<guild>:<channel>")
    .default("");

/** The text channel of `key` (`discord:<guild>:<channel>`), or `null` for none. */
export function commentContext(
  key: string,
): { platform: "discord"; scope: string; channel: string; kind: "channel" } | null {
  const m = /^discord:(\d{5,30}):(\d{5,30})$/.exec(key);
  if (m === null) return null;
  return { platform: "discord", scope: m[1] as string, channel: m[2] as string, kind: "channel" };
}

/**
 * ```toml
 * [modules.karaoke]
 * comment_channel = "discord:111111111111111111:123456789012345678"
 * ```
 */
export const KaraokeConfigSchema = z
  .object({
    /** Her local time zone as a UTC offset: what a day is for the daily limit. */
    utc_offset_minutes: z
      .number()
      .int()
      .min(-720)
      .max(840)
      .default(8 * 60),
    /** Members may ask for songs and sing. */
    open: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "開放唱 K",
          help: "關掉時會員頁不能點歌、不能開始唱;唱完的結果和她的講評照常",
          group: "songs",
        }),
      ),
    /** The longest song that may be sung, in seconds; a longer one fails its preparation. */
    max_song_secs: z
      .number()
      .int()
      .min(60)
      .max(1200)
      .default(480)
      .meta(setting({ kind: "duration", unit: "s", label: "一首最長", group: "songs" })),
    /** Songs one person may have prepared per local day (a song already prepared is free). */
    daily_songs: z
      .number()
      .int()
      .min(0)
      .max(100)
      .default(10)
      .meta(
        setting({
          kind: "number",
          label: "每人每天準備幾首",
          help: "已經準備好的歌不算;0 是只能唱準備好的",
          group: "songs",
        }),
      ),
    /** Cents either way that count as on pitch; credit falls to nothing at twice this. */
    tolerance_cents: z
      .number()
      .int()
      .min(20)
      .max(100)
      .default(50)
      .meta(
        setting({
          kind: "number",
          label: "音準容許範圍(cents)",
          help: "離原唱這麼近算唱對,兩倍遠就不算",
          step: 5,
          group: "score",
        }),
      ),
    /** She comments on a finished song (one model call, through her usual turn). */
    comment: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "她講評",
          help: "唱完把系統分數告訴她,讓她在講評頻道用自己的話講一句",
          group: "comment",
        }),
      ),
    /** Where she comments; empty: she only hears of it and says nothing. */
    comment_channel: channel().meta(
      setting({
        kind: "channel",
        room: "text",
        ref: "context",
        scope: "space",
        label: "講評頻道",
        help: "她在這個頻道講評;沒設就只讓她知道,不開口",
        group: "comment",
      }),
    ),
    /** Where the backing tracks and references are kept on Core, relative to `miyoria.toml`. */
    cache_dir: z.string().default("data/karaoke"),
  })
  .meta(
    settingGroups([
      { id: "songs", label: "點歌" },
      { id: "score", label: "評分" },
      { id: "comment", label: "講評" },
    ]),
  );
export type KaraokeConfig = z.output<typeof KaraokeConfigSchema>;
