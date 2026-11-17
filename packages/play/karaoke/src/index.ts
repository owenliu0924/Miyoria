// @miyoria/play/karaoke: karaoke on the member page, the first milestone (docs/design/karaoke.md
// 「做了什麼(第一步)」).
//
// - `score/`: the score, shared with the panel (`@miyoria/play/karaoke/score`, no Node, no DOM).
// - `config.ts`: `[modules.karaoke]`.
// - `schema.ts`, `migrations.ts`, `store.ts`: the `karaoke` store plugin (songs, requests,
//   sessions, tracks, results) and its event (`events.ts`).
// - `service.ts`: `KaraokeService`: asking for a song, following its preparation, sessions and
//   their signed links (`signing.ts`), scoring a submitted track, her comment.
// - `notes.ts`: what she hears of a finished song.
// - `module.ts`: module `karaoke` and `KaraokeKey`; `card.ts`: its card on the panel.

export { karaokeCard } from "./card.js";
export { commentContext, type KaraokeConfig, KaraokeConfigSchema } from "./config.js";
export { KARAOKE_SOURCE, karaokeScoredWrite } from "./events.js";
export { karaokeSchema } from "./migrations.js";
export { KaraokeKey, KaraokeModule, type KaraokeModuleOptions, TICK_MS } from "./module.js";
export { type NoteInput, resultNote } from "./notes.js";
export {
  COMMENT_WAIT_MS,
  FILES_KEEP_MS,
  failureText,
  KARAOKE_FILES,
  type KaraokeDeps,
  KaraokeError,
  type KaraokeNote,
  KaraokeService,
  type KaraokeWho,
  type Submission,
  sourceOf,
  TRACK_KEEP_MS,
} from "./service.js";
export { FILE_ROUTE, FileSigner, LINK_MS } from "./signing.js";
export {
  type CommentState,
  KaraokeStore,
  karaokeTables,
  type ResultRow,
  type SessionRow,
  type SongRow,
  type SongStatus,
} from "./store.js";
