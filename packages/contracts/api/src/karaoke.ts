// Karaoke on the member page, the first milestone (docs/design/karaoke.md 「做了什麼(第一步)」):
// one person sings in their own browser; a song is asked for by link or search and prepared by
// the song worker; its backing track and reference are fetched through short-lived signed links
// bound to the member's session; the pitch track the browser detected is sent once at the end,
// and Core scores it again with the same module. Without the `karaoke` module these are a `503`
// that names it. A member sees only their own results; there is no ranking of anyone else outside
// a room (`karaoke-rooms.ts`).

import { z } from "zod";
import { route } from "./route.js";

/** One prepared (or preparing) song as a member sees it. Title and artist are untrusted. */
export const KaraokeSongViewSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    artist: z.string().nullable(),
    duration_s: z.number().nullable(),
    state: z.enum(["preparing", "ready", "failed"]),
    /** The worker's stage while preparing (`download`, `separate`, `lead`, `reference`, ...). */
    stage: z.string().nullable(),
    /** 0..1 while preparing. */
    progress: z.number(),
    /** Its place in the worker's queue; `null` when it is not waiting. */
    position: z.number().int().nullable(),
    /** Why it failed, a sentence for people. */
    error: z.string().nullable(),
    /** It has lyrics with line times. */
    lyrics: z.boolean(),
    /**
     * Where they came from: `found` (looked up), `heard` (what the recogniser heard: shown as
     * 「聽寫」, may be wrong); `null` without lyrics, or for a song prepared before this was known.
     */
    lyrics_source: z.enum(["found", "heard"]).nullable(),
    /** Guide bars on screen. */
    notes: z.number().int(),
    /** It has a background video (the source's picture, no sound) and the module shows videos. */
    video: z.boolean(),
    /** The member asked for it. */
    mine: z.boolean(),
    /** The member's best ranked total on it. */
    best: z.number().nullable(),
    /** How often the member sang it. */
    sung: z.number().int(),
  })
  .meta({ id: "ApiKaraokeSongView" });
export type KaraokeSongView = z.output<typeof KaraokeSongViewSchema>;

/** One of the member's own results, for the list. */
export const KaraokeResultSummarySchema = z
  .object({
    session: z.string(),
    song: z.string(),
    title: z.string(),
    total: z.number(),
    unranked: z.boolean(),
    at: z.string(),
  })
  .meta({ id: "ApiKaraokeResultSummary" });
export type KaraokeResultSummary = z.output<typeof KaraokeResultSummarySchema>;

/** `GET /api/member/karaoke`. */
export const KaraokeOverviewSchema = z
  .object({
    /** Songs can be asked for and sung now (by members). */
    open: z.boolean(),
    /**
     * This person is a panel admin: they may use everything while it is not open (`open: false`),
     * to try it before members can. Members see it closed.
     */
    admin: z.boolean().default(false),
    /** A song worker is there to prepare songs. */
    preparing: z.boolean(),
    /** Ready songs (newest first) and the member's own that are preparing or failed lately. */
    songs: z.array(KaraokeSongViewSchema),
    limits: z.object({
      /** Songs a member may have prepared per day. */
      daily: z.number().int(),
      used: z.number().int(),
      max_minutes: z.number(),
    }),
    tolerance_cents: z.number(),
    /** She comments on a finished song in a Discord channel. */
    comments: z.boolean(),
    recent: z.array(KaraokeResultSummarySchema),
  })
  .meta({ id: "ApiKaraokeOverview" });
export type KaraokeOverview = z.output<typeof KaraokeOverviewSchema>;

/** Body of `POST /api/member/karaoke/songs`: a link, or words to search for. */
export const KaraokeRequestSchema = z
  .strictObject({ text: z.string().trim().min(1).max(500) })
  .meta({ id: "ApiKaraokeRequest" });
export type KaraokeRequest = z.input<typeof KaraokeRequestSchema>;

export const KaraokeRequestResultSchema = z
  .object({
    song: KaraokeSongViewSchema,
    /** A new preparation started (it counts against the day); `false`: the song was known. */
    created: z.boolean(),
  })
  .meta({ id: "ApiKaraokeRequestResult" });
export type KaraokeRequestResult = z.output<typeof KaraokeRequestResultSchema>;

/** `POST /api/member/karaoke/songs/{id}/sessions`: one singing of one song. */
export const KaraokeSessionSchema = z
  .object({
    session: z.string(),
    song: KaraokeSongViewSchema,
    /** Signed, bound to this session and the member, valid until `expires_at`. */
    backing_url: z.string(),
    reference_url: z.string(),
    /**
     * The background video (muted, played on the backing's clock), or `null` without one. Signed
     * like the others but valid as long as the session (a video is read in ranges while it plays).
     */
    video_url: z.string().nullable(),
    expires_at: z.string(),
    tolerance_cents: z.number(),
    /** Frames per second of the track to send. */
    frame_hz: z.number().int(),
    /**
     * Semitones the key was moved by: the backing at `backing_url` is in that key, and the
     * browser moves the reference's curve and notes by the same (`shiftKaraokeReference`).
     */
    shift: z.number().int(),
    /**
     * The official score comes from a recording of the singer (docs/design/karaoke.md
     * 「做了什麼第三步」): the browser may record the microphone during the song and upload it once,
     * after the result (`POST /api/member/karaoke/sessions/{id}/voice`), at most `max_bytes` and
     * `max_seconds` long. `null`: no recording is taken (the module's setting, or no song worker);
     * the result stays 預估.
     */
    recording: z.object({ max_bytes: z.number().int(), max_seconds: z.number().int() }).nullable(),
  })
  .meta({ id: "ApiKaraokeSession" });

/** Body of `POST /api/member/karaoke/songs/{id}/sessions` (may be left out: the song's own key). */
export const KaraokeStartSchema = z
  .strictObject({
    /** Semitones to move the key by, -6..6. */
    shift: z.number().int().min(-6).max(6).default(0),
  })
  .meta({ id: "ApiKaraokeStart" });
export type KaraokeStart = z.input<typeof KaraokeStartSchema>;
export type KaraokeSession = z.output<typeof KaraokeSessionSchema>;

/** Body of `POST /api/member/karaoke/sessions/{id}/result`. */
export const KaraokeSubmitSchema = z
  .strictObject({
    /** The detected pitch at `frame_hz`, one byte a frame (`encodeTrack`), base64. */
    track: z.string().max(80_000),
    /** The device's output plus input latency: the track is this late. */
    latency_ms: z.number().int().min(-500).max(1500),
    /** The latency was measured on this device. */
    calibrated: z.boolean(),
    /** What the browser showed; kept beside Core's for comparison, never used. */
    client_total: z.number().min(0).max(100).nullable(),
    /** The browser's name, for the owner. */
    browser: z.string().max(60).default(""),
    /**
     * A recording of the song follows (`POST .../voice`): her comment waits a bounded time for the
     * official score. `false` (the singer did not allow recording, or the browser cannot): 預估.
     */
    recording: z.boolean().default(false),
  })
  .meta({ id: "ApiKaraokeSubmit" });

/**
 * What became of the recording: `none` (there is none: the result is 預估), `waiting` (the result is
 * in, the recording not yet), `scoring` (at the song worker), `scored` (the result is the official
 * one), `failed` (the upload or the worker failed: the result stays 預估).
 */
export const KaraokeVoiceStateSchema = z
  .enum(["none", "waiting", "scoring", "scored", "failed"])
  .meta({ id: "ApiKaraokeVoiceState" });
export type KaraokeVoiceState = z.output<typeof KaraokeVoiceStateSchema>;

/**
 * What the checks of a recording found, shown to the singer: `quiet` (the voice is very quiet or far
 * from the microphone), `bleed` (pitch where the song has no voice: probably the backing from
 * speakers). Either keeps the result off the bests.
 */
export const KaraokeVoiceCheckSchema = z
  .enum(["quiet", "bleed"])
  .meta({ id: "ApiKaraokeVoiceCheck" });
export type KaraokeVoiceCheck = z.output<typeof KaraokeVoiceCheckSchema>;

/** The answer to an uploaded recording: it is being scored. */
export const KaraokeVoiceAcceptedSchema = z
  .object({ state: KaraokeVoiceStateSchema })
  .meta({ id: "ApiKaraokeVoiceAccepted" });
export type KaraokeVoiceAccepted = z.output<typeof KaraokeVoiceAcceptedSchema>;
export type KaraokeSubmit = z.input<typeof KaraokeSubmitSchema>;

const score = z.number();
const max = z.number();

/** A scored singing: Core's numbers (`scoreSinging`), her comment when she made one. */
export const KaraokeResultSchema = z
  .object({
    session: z.string(),
    /**
     * `voice`: scored from the recording of the singer (the official score); `estimate`: from the
     * pitch the browser detected (預估). Later features (coins) only trust `voice`.
     */
    source: z.enum(["voice", "estimate"]),
    voice: z.object({
      state: KaraokeVoiceStateSchema,
      /** Core's score of the browser's track, kept once the recording's replaced it. */
      estimate_total: z.number().nullable(),
      checks: z.array(KaraokeVoiceCheckSchema),
      /**
       * Core wants the recording now (`POST .../voice`): `waiting` for one, and no live stream of
       * this singing will give the official score (a room's singer whose stream held needs none).
       */
      upload: z.boolean().default(false),
    }),
    song: z.object({ id: z.string(), title: z.string(), artist: z.string().nullable() }),
    at: z.string(),
    total: z.number(),
    pitch: z.object({ score, max, hit: z.number() }),
    stability: z.object({
      score,
      max,
      wobble_cents: z.number().nullable(),
      held: z.number().int(),
    }),
    rhythm: z.object({
      score,
      max,
      calibrated: z.boolean(),
      measured: z.boolean(),
      offset_ms: z.number().nullable(),
      spread_ms: z.number().nullable(),
      onsets: z.number().int(),
      found: z.number().int(),
      feel: z.enum(["early", "late", "steady"]).nullable(),
    }),
    expression: z.object({
      score,
      max,
      vibrato_s: z.number(),
      long_tones: z.number().int(),
      scoops: z.number().int(),
      falls: z.number().int(),
    }),
    phrases: z.array(
      z.object({
        index: z.number().int(),
        start: z.number(),
        end: z.number(),
        score: z.number(),
        hit: z.number(),
        sung: z.number(),
        /** The lyric line, when the phrases are lines. */
        text: z.string().nullable(),
      }),
    ),
    facts: z.object({
      coverage: z.number(),
      best: z.number().int().nullable(),
      weakest: z.number().int().nullable(),
      octave: z.number().int(),
      offset_cents: z.number().nullable(),
      sung_s: z.number(),
      reference_s: z.number(),
    }),
    /** Not checked as sung (shown, but not a best); the reason is the owner's to see. */
    unranked: z.boolean(),
    client_total: z.number().nullable(),
    latency_ms: z.number().int(),
    /** The member's best on this song before this one (ranked). */
    best_before: z.number().nullable(),
    /** Her comment: `waiting` for it, `said` (in the channel), `none` (she will not). */
    comment: z.object({
      state: z.enum(["waiting", "said", "none"]),
      text: z.string().nullable(),
    }),
  })
  .meta({ id: "ApiKaraokeResult" });
export type KaraokeResult = z.output<typeof KaraokeResultSchema>;

/** `GET /api/karaoke/results`: the latest results with their flags, for the owner. */
export const KaraokeAdminResultsSchema = z
  .object({
    results: z.array(
      z.object({
        session: z.string(),
        person: z.string().nullable(),
        name: z.string(),
        song: z.string(),
        title: z.string(),
        total: z.number(),
        client_total: z.number().nullable(),
        unranked: z.boolean(),
        reasons: z.array(z.string()),
        source: z.enum(["voice", "estimate"]),
        voice_state: KaraokeVoiceStateSchema,
        estimate_total: z.number().nullable(),
        latency_ms: z.number().int(),
        calibrated: z.boolean(),
        browser: z.string(),
        at: z.string(),
      }),
    ),
  })
  .meta({ id: "ApiKaraokeAdminResults" });
export type KaraokeAdminResults = z.output<typeof KaraokeAdminResultsSchema>;

const member = () => route.meta({ audience: "member", permission: null, limited: true });
const id = z.object({ id: z.string().min(1).max(64) });

/** The member's side: needs a session (by cookie), limited per account. */
export const karaoke = {
  overview: member()
    .route({ method: "GET", path: "/api/member/karaoke" })
    .output(KaraokeOverviewSchema),
  /** A link or a search: the known song, or a new preparation (`409` with a sentence over the day's limit). */
  request: member()
    .route({ method: "POST", path: "/api/member/karaoke/songs" })
    .input(z.object({ body: KaraokeRequestSchema }))
    .output(KaraokeRequestResultSchema),
  song: member()
    .route({ method: "GET", path: "/api/member/karaoke/songs/{id}" })
    .input(z.object({ params: id }))
    .output(KaraokeSongViewSchema),
  /** Starts a singing of a ready song, in its key or moved (`shift`): its signed links. */
  start: member()
    .route({ method: "POST", path: "/api/member/karaoke/songs/{id}/sessions" })
    .input(z.object({ params: id, body: KaraokeStartSchema.optional() }))
    .output(KaraokeSessionSchema),
  /** The track, once, at the end: Core's score. */
  submit: member()
    .route({ method: "POST", path: "/api/member/karaoke/sessions/{id}/result" })
    .input(z.object({ params: id, body: KaraokeSubmitSchema }))
    .output(KaraokeResultSchema),
  /** A result again (her comment arrives later). */
  result: member()
    .route({ method: "GET", path: "/api/member/karaoke/sessions/{id}" })
    .input(z.object({ params: id }))
    .output(KaraokeResultSchema),
};

/** The owner's side. */
export const karaokeAdmin = {
  results: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/karaoke/results" })
    .output(KaraokeAdminResultsSchema),
};
