// What the browser driver answers (`workers/sandbox/image/browser/driver.mjs`). It runs on
// someone else's computer next to pages anyone wrote, so every answer is checked for its shape
// and size before Core uses it; the strings in it are page content (untrusted data).

import { z } from "zod";

/** The methods of the driver. */
export const DRIVER = {
  ping: "browse.ping",
  open: "browse.open",
  act: "browse.act",
  read: "browse.read",
  shot: "browse.shot",
} as const;

/** Where the driver is in the browser image, and how a proc starts it. */
export const DRIVER_ARGV = ["node", "/opt/miyoria/browser/driver.mjs"] as const;

/** The environment variable that gives the driver one step's time (`step_timeout_ms`). */
export const STEP_ENV = "MIYORIA_BROWSE_STEP_MS";

/**
 * How long Core waits for one answer: the driver's own bound on a step is the action (`step`),
 * then up to 5.3 s for the page to settle and half a step for downloads to finish, so Core gives
 * up only after the driver would have answered, and a step that hangs still ends.
 */
export function stepWaitMs(step: number): number {
  return Math.ceil(step * 1.5) + 10_000;
}

/** Where the driver saves downloads, relative to `/workspace` (what comes back to her folder). */
export const DOWNLOADS_DIR = "downloads";

/** Largest screenshot the driver sends (it re-encodes or shrinks to fit). */
export const SHOT_MAX_BYTES = 2 * 1024 * 1024;

const url = z.string().max(8192);
const title = z.string().max(2000);

export const PingResultSchema = z.object({
  playwright: z.string().max(100),
  browser: z.string().max(100),
});

export const OpenResultSchema = z.object({
  url,
  title,
  status: z.number().int().nullable(),
});
export type OpenResult = z.output<typeof OpenResultSchema>;

export const ReadResultSchema = z.object({
  url,
  title,
  text: z.string().max(200_000),
  /** Characters of the whole text of this mode (for the next `offset`). */
  total_chars: z.number().int().min(0),
  offset: z.number().int().min(0),
  truncated: z.boolean(),
});
export type ReadResult = z.output<typeof ReadResultSchema>;

export const ActResultSchema = z.object({
  url,
  title,
  navigated: z.boolean(),
  new_tab: z.boolean(),
  /** Files saved in `/workspace/downloads/` during the step. */
  downloads: z
    .array(z.object({ path: z.string().max(400), bytes: z.number().int().min(0) }))
    .max(100),
  note: z.string().max(2000).nullable().optional(),
});
export type ActResult = z.output<typeof ActResultSchema>;

export const ShotResultSchema = z.object({
  mime: z.enum(["image/png", "image/jpeg"]),
  /** Base64 of the picture, at most `SHOT_MAX_BYTES` decoded. */
  data: z
    .string()
    .max(Math.ceil((SHOT_MAX_BYTES * 4) / 3) + 8)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  width: z.number().int().min(1).max(20_000),
  height: z.number().int().min(1).max(20_000),
  /** The page was taller than one picture takes; only the top is in it. */
  clipped: z.boolean(),
  url,
  title,
});
export type ShotResult = z.output<typeof ShotResultSchema>;

/** `browse.act`'s actions. */
export const ACTIONS = ["click", "type", "press", "select", "scroll", "back", "wait"] as const;
export type BrowseAction = (typeof ACTIONS)[number];

/** `browse.read`'s modes. */
export const READ_MODES = ["text", "links", "outline"] as const;
export type ReadMode = (typeof READ_MODES)[number];
