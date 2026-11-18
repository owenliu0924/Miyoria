// `[modules.karaoke]` (docs/design/karaoke.md 「做了什麼(第一步)」): single-player karaoke on the
// member page. The module's own switch is `enabled` (the system page); `open` closes asking for
// and singing songs to members while the module keeps running (results and her comments still
// arrive; a panel admin can still use everything, to try it first). A person singing alone gets no
// coins (owner 2026-11-17); rooms (step 4) cost and pay coins through the economy's karaoke wallet.

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
          help: "關掉時會員不能點歌、唱、開房間;唱完的結果和她的講評照常。面板管理員關著時也能用,可以先試",
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
    /**
     * The official score from a recording of the singer (docs/design/karaoke.md 「做了什麼第三步」):
     * the browser records the microphone during the song and sends it once at the end; the song
     * worker reads its pitch (RMVPE) and Core scores that. The recording is deleted on both as soon
     * as it is scored. Off: only the browser's estimate (預估).
     */
    voice_score: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "用錄音算正式分數",
          help: "唱的時候錄下麥克風,唱完送到唱歌的機器讀音高、算正式分數,算完兩邊都刪掉;關掉時只有瀏覽器的預估分數",
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
    /** Her comment waits this long for the official score; then she hears of the estimate. */
    voice_wait_secs: z
      .number()
      .int()
      .min(0)
      .max(600)
      .default(90)
      .meta(
        setting({
          kind: "duration",
          unit: "s",
          label: "講評等正式分數",
          help: "唱完後最多等正式分數這麼久再告訴她;等不到就用預估分數",
          group: "comment",
        }),
      ),
    /**
     * A background video for the songs prepared from now on: the source's picture, no sound, at
     * most 720p, played muted behind the lyrics on the backing's clock. Off: none is made, and
     * none already made is shown.
     */
    video: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "背景影片",
          help: "準備歌時留一份來源的畫面(最高 720p、沒有聲音),唱的時候放在歌詞後面;關掉時不做也不放",
          group: "video",
        }),
      ),
    /** Hours a song's video stays on Core after it was last sung (the worker keeps its own). */
    video_keep_hours: z
      .number()
      .int()
      .min(1)
      .max(720)
      .default(24)
      .meta(
        setting({
          kind: "number",
          label: "影片在 Core 留幾小時",
          help: "最後一次唱過後這麼久就刪掉 Core 上的那一份,再唱時從唱歌的機器再拿",
          group: "video",
        }),
      ),
    /**
     * How a song's lyrics are aligned to the singing (docs/design/karaoke.md 「做了什麼第二步」):
     * `w2v`, a wav2vec2 CTC model per language (Apache-2.0); `mms`, torchaudio's MMS_FA weights,
     * better on hard songs, licensed CC-BY-NC-4.0 (non-commercial use only: this project is
     * non-commercial). Sent with every song asked for; a song prepared before keeps its own.
     */
    aligner: z
      .enum(["w2v", "mms"])
      .default("w2v")
      .meta(
        setting({
          kind: "select",
          label: "歌詞對齊",
          help: "mms 在難的歌上準很多,但權重是 CC-BY-NC-4.0(只能非商業使用);w2v 是 Apache-2.0。只影響之後準備的歌",
          labels: { w2v: "w2v(Apache-2.0)", mms: "mms(CC-BY-NC-4.0)" },
          group: "lyrics",
        }),
      ),
    /** A looked-up line at least this similar to what was heard is matched (aligned, notes per character). */
    lyrics_matched: z
      .number()
      .min(0)
      .max(1)
      .default(0.75)
      .meta(
        setting({
          kind: "ratio",
          label: "一行算對上",
          help: "查到的一行和聽到的至少這麼像,才逐字對齊、照字切音符",
          group: "lyrics",
        }),
      ),
    /** Below `lyrics_matched` but at least this: uncertain (shown, not aligned); below: failed. */
    lyrics_uncertain: z
      .number()
      .min(0)
      .max(1)
      .default(0.5)
      .meta(
        setting({
          kind: "ratio",
          label: "一行算不確定",
          help: "比這個低就算對不上",
          group: "lyrics",
        }),
      ),
    /** Of the looked-up lines, at least this share matched keeps them. */
    lyrics_keep_share: z
      .number()
      .min(0)
      .max(1)
      .default(0.5)
      .meta(
        setting({
          kind: "ratio",
          label: "整首留下查到的歌詞",
          help: "對上的行至少這麼多,查到的歌詞就用",
          group: "lyrics",
        }),
      ),
    /** Fewer than this share matched: the wrong song, the lyrics become what was heard. */
    lyrics_wrong_share: z
      .number()
      .min(0)
      .max(1)
      .default(0.2)
      .meta(
        setting({
          kind: "ratio",
          label: "整首算查錯歌",
          help: "對上的行比這個少,就不用查到的歌詞,改用聽寫",
          group: "lyrics",
        }),
      ),
    /**
     * Rooms (docs/design/karaoke.md 「做了什麼第四步」): up to `room_singers` people sing the same
     * song at once, each in their own browser, while she is in a voice channel (the comment
     * channel's server) and hosts. Opened and joined on the member page.
     */
    rooms: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "多人房間",
          help: "她在語音頻道時,會員可以在會員頁開房間,大家同時唱同一首;要先設講評頻道(房間開在那個伺服器)",
          group: "rooms",
        }),
      ),
    /** What opening a room costs (burned). 0: free. */
    room_price: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .default(20)
      .meta(
        setting({
          kind: "number",
          label: "開房費",
          help: "開房的人付;一輪都沒唱完就關掉的房間全退",
          group: "rooms",
        }),
      ),
    /** What the winner of a round gets (two finishers at least, the official score). 0: none. */
    room_prize: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .default(15)
      .meta(
        setting({
          kind: "number",
          label: "第一名獎勵",
          help: "至少兩個人唱完才有;要是正式分數、沒有被標記;同分都給",
          group: "rooms",
        }),
      ),
    /** What everyone who sings a round through gets. 0: none. */
    room_finish: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .default(3)
      .meta(
        setting({
          kind: "number",
          label: "唱完的獎勵",
          help: "唱到原唱一半以上的人各拿這麼多",
          group: "rooms",
        }),
      ),
    /** Of the song's voice a singer must have sung for the round to count as finished. */
    room_finish_share: z
      .number()
      .min(0.1)
      .max(1)
      .default(0.5)
      .meta(
        setting({
          kind: "ratio",
          label: "算唱完",
          help: "原唱有聲的地方唱到這麼多才算唱完",
          group: "rooms",
        }),
      ),
    /** Prizes one person may win per day. */
    room_prizes_per_day: z
      .number()
      .int()
      .min(0)
      .max(50)
      .default(2)
      .meta(setting({ kind: "number", label: "每人每天第一名獎勵幾次", group: "rooms" })),
    /** Finishing rewards one person may get per day. */
    room_finishes_per_day: z
      .number()
      .int()
      .min(0)
      .max(50)
      .default(5)
      .meta(setting({ kind: "number", label: "每人每天唱完獎勵幾次", group: "rooms" })),
    /**
     * Rounds one room may sing for its one opening charge; then it closes. (One charge per room,
     * not per round: the simpler rule.)
     */
    room_rounds: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(4)
      .meta(
        setting({
          kind: "number",
          label: "一間房最多唱幾首",
          help: "開房費包含這麼多首,唱完要再開一間",
          group: "rooms",
        }),
      ),
    /** Singers in a room (spectators are not counted). */
    room_singers: z
      .number()
      .int()
      .min(2)
      .max(8)
      .default(8)
      .meta(setting({ kind: "number", label: "一間房最多幾人唱", group: "rooms" })),
    /** Rooms open at once. */
    room_max: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2)
      .meta(setting({ kind: "number", label: "同時最多幾間房", group: "rooms" })),
    /** A room with nothing going on (no round started, nobody joining) closes after this. */
    room_idle_mins: z
      .number()
      .int()
      .min(2)
      .max(120)
      .default(10)
      .meta(
        setting({
          kind: "duration",
          unit: "min",
          label: "房間閒置多久關掉",
          group: "rooms",
        }),
      ),
    /** Seconds from the start to the first beat, for everyone's browser to be ready. */
    room_countdown_secs: z
      .number()
      .int()
      .min(3)
      .max(30)
      .default(6)
      .meta(setting({ kind: "duration", unit: "s", label: "開始前倒數", group: "rooms" })),
    /**
     * The singers' microphones are streamed to a song worker during the round and scored live (the
     * official score); off, or a worker without it: the browser's estimate during the round and
     * the recording each singer uploads at the end.
     */
    room_stream: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "唱的時候即時算正式分數",
          help: "唱的時候把麥克風的聲音即時送到唱歌的機器算音高(不存);關掉時唱的時候只有預估,唱完再送錄音",
          group: "rooms",
        }),
      ),
    /** Where the backing tracks and references are kept on Core, relative to `miyoria.toml`. */
    cache_dir: z.string().default("data/karaoke"),
  })
  .meta(
    settingGroups([
      { id: "songs", label: "點歌" },
      { id: "score", label: "評分" },
      { id: "rooms", label: "多人房間" },
      { id: "lyrics", label: "歌詞" },
      { id: "video", label: "背景影片" },
      { id: "comment", label: "講評" },
    ]),
  );

/** `karaoke_lyrics` of a song's job: the lyrics settings as the worker takes them. */
export function lyricsOptions(cfg: KaraokeConfig): {
  aligner: "w2v" | "mms";
  matched: number;
  uncertain: number;
  keep_share: number;
  wrong_share: number;
} {
  return {
    aligner: cfg.aligner,
    matched: cfg.lyrics_matched,
    uncertain: Math.min(cfg.lyrics_uncertain, cfg.lyrics_matched),
    keep_share: cfg.lyrics_keep_share,
    wrong_share: Math.min(cfg.lyrics_wrong_share, cfg.lyrics_keep_share),
  };
}
export type KaraokeConfig = z.output<typeof KaraokeConfigSchema>;
