// `[modules.api.room]`: her room (docs/design/her-room.md §6), the page where a logged-in member is
// alone with her. Off by default; it also needs `[modules.api.public] enabled`. These are the
// transport's limits, not rules of hers: what she answers is decided where it always is.
//
// ```toml
// [modules.api.room]
// enabled = false
// messages_per_minute = 12
// messages_per_day = 400
// ```

import { z } from "zod";

const MB = 1024 * 1024;

export const RoomConfigSchema = z.object({
  /** The room's routes exist at all (`/api/member/room/*`); off: they are a 404. */
  enabled: z.boolean().default(false),
  /** Lines one person may send a minute. */
  messages_per_minute: z.number().int().positive().default(12),
  /** Lines one person may send a day (rolling 24 hours). */
  messages_per_day: z.number().int().positive().default(400),
  /** The longest line, in characters (one Discord message). */
  max_text_chars: z.number().int().positive().max(8000).default(2000),
  /** Files on one line. */
  max_files: z.number().int().min(0).max(8).default(4),
  /** The largest image (the image loader's own cap). */
  max_image_mb: z.number().positive().max(25).default(5),
  /** The largest other file. */
  max_file_mb: z.number().positive().max(25).default(8),
  /** Uploads one person may make an hour. */
  uploads_per_hour: z.number().int().positive().default(20),
  /** Every upload not yet dropped, together (memory only). */
  upload_pool_mb: z.number().positive().default(128),
  /** Open streams (tabs) of one person. */
  streams_per_account: z.number().int().positive().default(3),
  /** Open streams of everyone together. */
  streams_total: z.number().int().positive().default(64),
  /** Her voice may be played in the room when there is a TTS. */
  voice: z.boolean().default(true),
  /** Lines of her voice one person may hear an hour. */
  voice_lines_per_hour: z.number().int().positive().default(60),
  /** A longer line has no voice. */
  voice_max_chars: z.number().int().positive().default(300),
  /** Synthesized lines kept in memory. */
  voice_cache: z.number().int().min(0).default(64),
  /** Lines of one backlog page. */
  backlog_page: z.number().int().positive().max(200).default(50),
});
export type RoomConfig = z.output<typeof RoomConfigSchema>;

/** The limits in bytes. */
export function roomBytes(config: RoomConfig): { image: number; file: number; pool: number } {
  return {
    image: Math.floor(config.max_image_mb * MB),
    file: Math.floor(config.max_file_mb * MB),
    pool: Math.floor(config.upload_pool_mb * MB),
  };
}
