import { z } from "zod";

// What the song worker makes for karaoke (`POST /jobs` with `purpose: "karaoke"`,
// docs/design/karaoke.md 「做了什麼(第一步)」): a backing track to sing over and `reference.json`,
// the reference the singing is compared with. This file is the one definition of that format;
// the worker writes it, Core reads it from the worker and hands it to the singer's browser.
//
// Times are seconds from the start of the backing track. Everything about the song (title,
// artist, lyrics) comes from YouTube or lrclib and is untrusted.
//
// Version 1 is what the first milestone fills: the lead vocal's pitch curve, notes cut from the
// pitch alone (`source: "pitch"`), lyrics with line times. The fields the later milestones fill
// are already here so the format does not change for them: notes cut by the lyrics' characters
// (`source: "lyric"`, with `line` and `char`), per-character times (`chars`), and per line whether
// the looked-up lyrics were checked against what is heard (`check`, `confidence`).

/** The value of `format`. */
export const KARAOKE_REFERENCE_FORMAT = "miyoria.karaoke.reference";
/** The version this file describes. */
export const KARAOKE_REFERENCE_VERSION = 1;
/** Frames per second of the reference pitch curve (and of a singer's submitted track). */
export const KARAOKE_FRAME_HZ = 50;
/** The files of a prepared karaoke song (`GET /karaoke/{id}/files/{name}`). */
export const KARAOKE_FILES = ["karaoke.m4a", "reference.json"] as const;

/**
 * The lead vocal's pitch, one frame every `1 / hz` seconds from `start`: MIDI note numbers with a
 * fraction (60 = C4, 60.5 = a quarter tone above), `null` where the lead is not voiced (the voiced
 * flag). Made by `made.pitch` (RMVPE) on the lead vocal after the lead / backing split.
 */
export const WorkersKaraokePitchSchema = z
  .object({
    hz: z.number().int().positive(),
    start: z.number(),
    midi: z.array(z.number().nullable()),
  })
  .meta({ id: "WorkersKaraokePitch" });
export type WorkersKaraokePitch = z.output<typeof WorkersKaraokePitchSchema>;

/**
 * One bar of the guide. Only a guide on screen: the score compares the pitch curves, so a note cut
 * wrong costs nobody anything (owner 2026-11-17).
 *
 * `source`: `pitch`, cut from the pitch curve alone (stable-pitch runs); `lyric`, one per
 * character of a checked line, aligned (later milestones). `line` / `char`: the lyric line and the
 * character in it a `lyric` note sings (a character may have several notes); `null` for `pitch`.
 */
export const WorkersKaraokeNoteSchema = z
  .object({
    start: z.number(),
    end: z.number(),
    midi: z.number(),
    source: z.enum(["pitch", "lyric"]),
    line: z.number().int().nullable(),
    char: z.number().int().nullable(),
  })
  .meta({ id: "WorkersKaraokeNote" });
export type WorkersKaraokeNote = z.output<typeof WorkersKaraokeNoteSchema>;

/** One character of a line with its time (later milestones: forced alignment). */
export const WorkersKaraokeCharSchema = z
  .object({ text: z.string(), start: z.number(), end: z.number() })
  .meta({ id: "WorkersKaraokeChar" });
export type WorkersKaraokeChar = z.output<typeof WorkersKaraokeCharSchema>;

/**
 * One line of lyrics. `end`: when the next line starts (or the lead's last voice), `null` when
 * nothing tells. `check`: `unchecked` (this milestone: the looked-up text as it is), `matched`
 * (the whole-song transcription agrees), `uncertain` (it does not: shown, not cut into notes),
 * `failed` (the alignment did not hold). `confidence`: 0..1 of that check, `null` unchecked.
 * `chars`: per-character times, `null` until aligned.
 */
export const WorkersKaraokeLineSchema = z
  .object({
    start: z.number(),
    end: z.number().nullable(),
    text: z.string(),
    check: z.enum(["unchecked", "matched", "uncertain", "failed"]),
    confidence: z.number().nullable(),
    chars: z.array(WorkersKaraokeCharSchema).nullable(),
  })
  .meta({ id: "WorkersKaraokeLine" });
export type WorkersKaraokeLine = z.output<typeof WorkersKaraokeLineSchema>;

/**
 * The lyrics: where they came from (`lrclib`, `netease`, ...), whether lines or characters have
 * times (`timing`), and the lines. `null` in the reference when none were found.
 */
export const WorkersKaraokeLyricsSchema = z
  .object({
    provider: z.string().nullable(),
    timing: z.enum(["line", "char"]),
    lines: z.array(WorkersKaraokeLineSchema),
  })
  .meta({ id: "WorkersKaraokeLyrics" });
export type WorkersKaraokeLyrics = z.output<typeof WorkersKaraokeLyricsSchema>;

/**
 * Whether the song can be sung: `ok` false with a `reason` when the lead is voiced in less than
 * the worker's share of the song, or there are too few notes (docs/design/karaoke.md §3.2).
 */
export const WorkersKaraokeQualitySchema = z
  .object({
    ok: z.boolean(),
    reason: z.string().nullable(),
    /** Voiced frames of the reference over all frames. */
    voiced_ratio: z.number(),
    notes: z.number().int(),
    /** The lead was split from the backing voices (else the whole vocal stem was used). */
    lead_split: z.boolean(),
  })
  .meta({ id: "WorkersKaraokeQuality" });
export type WorkersKaraokeQuality = z.output<typeof WorkersKaraokeQualitySchema>;

/** How each part was made, so a later milestone can tell what to redo: `rmvpe`, `pitch-runs-1`, `line` / `none`. */
export const WorkersKaraokeMadeSchema = z
  .object({ pitch: z.string(), notes: z.string(), lyrics: z.string() })
  .meta({ id: "WorkersKaraokeMade" });
export type WorkersKaraokeMade = z.output<typeof WorkersKaraokeMadeSchema>;

/** `reference.json`. */
export const WorkersKaraokeReferenceSchema = z
  .object({
    format: z.literal(KARAOKE_REFERENCE_FORMAT),
    version: z.literal(KARAOKE_REFERENCE_VERSION),
    id: z.string(),
    title: z.string(),
    artist: z.string().nullable(),
    duration_s: z.number(),
    /** The backing track: the instrumental with the backing voices kept, AAC in MP4. */
    backing: z.string(),
    pitch: WorkersKaraokePitchSchema,
    notes: z.array(WorkersKaraokeNoteSchema),
    lyrics: WorkersKaraokeLyricsSchema.nullable(),
    quality: WorkersKaraokeQualitySchema,
    made: WorkersKaraokeMadeSchema,
  })
  .meta({ id: "WorkersKaraokeReference" });
export type WorkersKaraokeReference = z.output<typeof WorkersKaraokeReferenceSchema>;

/**
 * A finished karaoke job (`job.karaoke`): the song's id among the worker's karaoke songs (not one
 * of her covers: it is never listed by `GET /songs`), and what `reference.json` says of it.
 */
export const WorkersKaraokeSongSchema = z
  .object({
    id: z.string(),
    title: z.string().catch(""),
    artist: z.string().nullable().catch(null),
    duration_s: z.number().nullable().catch(null),
    quality: WorkersKaraokeQualitySchema.nullable().catch(null),
  })
  .meta({ id: "WorkersKaraokeSong" });
export type WorkersKaraokeSong = z.output<typeof WorkersKaraokeSongSchema>;
