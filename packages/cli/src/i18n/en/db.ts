// Messages of `miyoria db import-links | archive | doctor`.

import type { CutoverErrorCode, DoctorReport } from "@miyoria/store";
import { common } from "./common.js";

export const db = {
  /** Why the store refused, by its error code (the store's English detail follows). */
  reasons: {
    missing: "File not found",
    not_database: "Not an SQLite database",
    not_v4: "Not a V4 database",
    not_v5: "The target database is not a V5 database",
    profile: "Cannot tell which character the bonds and cards belong to (check `core.profile`)",
    conflict:
      "Some accounts already belong to someone else in the new database. Import before anyone talks to the character on V5: run again with a new database file",
    held: "The database is still open. Stop Core first (`miyoria down`, or close the Core running in the foreground) and close any other program that has this file open",
    archive_state: "The state of the archive folder does not match the previous plan",
    same_file: "The old and the new database are the same file",
  } satisfies Record<CutoverErrorCode, string>,
  notSqlite: (error: string) => `\`core.database_url\` is not an SQLite file: ${error}`,
  inMemory: "`core.database_url` is an in-memory database; there is no file to work on",
  more: (n: number) => `  …and ${n} more`,
  // ---- counts ----
  /** `choice`: people created only to keep their preferences. */
  countPersons: (persons: number, choice: number, accounts: number) =>
    `People: ${persons}${choice > 0 ? ` (plus ${choice} created only to keep preferences)` : ""}, accounts: ${accounts}`,
  countHandles: (kept: number, renamed: number, made: number) =>
    `Handles: ${kept} kept, ${renamed} renamed, ${made} new`,
  countPrefs: (privacy: number, voiceConsent: number) =>
    `Preferences: privacy ${privacy}, voice consent ${voiceConsent}`,
  countLegacy: (withTier: number, cards: number) =>
    `Keepsake card data: ${withTier} people with an old bond level, ${cards} old cards`,
  countSkipped: (existing: number, noAccounts: number, orphans: number, unusedHandles: number) =>
    `Skipped: ${existing} already imported, ${noAccounts} without accounts, ${orphans} accounts without a person, ${unusedHandles} unused handles`,
  // ---- one person ----
  personAccounts: (accounts: string) => `accounts ${accounts}`,
  personPrefs: (prefs: string) => `preferences: ${prefs}`,
  prefPrivacy: "privacy",
  prefVoiceConsent: "voice consent",
  personChoiceOnly: "created only to keep preferences",
  personLegacy: (tier: string | null, cards: number) =>
    `bond ${tier ?? common.none}, ${cards} ${cards === 1 ? "card" : "cards"}`,
  personOldHandle: (handle: string) => `${handle} in V4`,
  // ---- import-links ----
  needFrom:
    "--from <FILE> is required: the V4 database (usually the .single.db made by `miyoria db archive`)",
  /** `flag`: ` -c <config>`, or empty. */
  stillOldFile: (file: string, flag: string) =>
    `\`core.database_url\` still points to ${file}. The new database needs a new file name so that the old version does not open it. Run \`miyoria config set core.database_url sqlite:data/core.db${flag}\` first`,
  importSection: (dryRun: boolean) => `Import identities from V4${dryRun ? " (dry run)" : ""}`,
  oldDatabase: (file: string) => `Old database: ${file} (read-only; it is not changed)`,
  newDatabase: (file: string, exists: boolean) =>
    `New database: ${file}${exists ? "" : " (does not exist yet; it will be created)"}`,
  profile: (id: string) => `Profile: ${id}`,
  peopleSection: (dryRun: boolean): string => (dryRun ? "People to import" : "Imported people"),
  noPeople: "No people to import",
  renamedSection: "Handles that differed only in case, renamed",
  prefsAddedSection: "Preferences added to people already in the new database",
  skippedNoAccounts: (name: string, id: string) => `Person without accounts: ${name} (${id})`,
  skippedOrphan: (account: string, person: string) =>
    `Account without a person: ${account} (person ${person})`,
  skippedUnreadable: (key: string) => `Unreadable setting: ${key}`,
  skippedSection: "Old data skipped",
  conflictsSection: "Accounts that already belong to someone else",
  conflict: (account: string, name: string, owner: string) =>
    `  ${account}  ${name} in V4, ${owner} in the new database`,
  countsSection: "Counts",
  dryRunDone: "Dry run complete; nothing was written",
  /** `created`: the new database file, when the import created it. */
  importDone: (persons: number, accounts: number, events: number, created: string | null) =>
    `Import complete: ${persons} people, ${accounts} accounts, ${events} identity.imported events${created !== null ? `; created ${created}` : ""}`,
  // ---- archive ----
  archiveTo: (dir: string) => `Archive to: ${dir}`,
  movedBefore: " (moved earlier)",
  singleCopy: (file: string) => `  Single-file copy → ${file}`,
  hashes: (file: string) => `  Hashes → ${file}`,
  nextSection: "Next steps",
  rollback:
    "  To go back to V4: stop V5 and rename the three archived files to their original names.",
  archiveSection: (dryRun: boolean) => `Archive the V4 database${dryRun ? " (dry run)" : ""}`,
  database: (file: string) => `Database: ${file}`,
  alreadyArchived: (date: string) => `Already archived (${date}); nothing to do`,
  resumed: "The previous archive did not finish; continuing it",
  archiveDryRunDone: "Dry run complete: no file is open; nothing was moved",
  needYes: "Not running in a terminal: add --yes to confirm",
  typeToConfirm: (word: string) => `The files above will be moved. Type ${word} to confirm`,
  archiveCancelled: "Cancelled; no files were moved.",
  indexFile: "(index file, no hash recorded)",
  hashesWritten: (file: string) => `Hashes written to ${file}; no files were deleted`,
  // ---- doctor ----
  layouts: {
    missing: "File does not exist",
    empty: "Empty file (0 bytes): Core treats it as a new database",
    not_database: "Not an SQLite database",
    blank: "SQLite file with no tables: Core treats it as a new database",
    v4: "V4 database",
    v5: "V5 database",
    foreign: "Has tables, but is not a Miyoria database",
  } satisfies Record<DoctorReport["layout"], string>,
  v4Layout: (layout: string, version: string) => `${layout} (schema_version ${version})`,
  noWal: "no -wal",
  noShm: "no -shm",
  walMode: "WAL mode",
  rollbackMode: "rollback mode",
  doctorSection: (file: string) => `Database check: ${file} (read-only)`,
  checksFailed: (n: number) => `${n} ${n === 1 ? "check" : "checks"} failed`,
  coreOpens: "Core will open this file",
  coreRefuses: "Core will refuse to open this file",
  migrationsSection: "Migrations",
  pluginMigrations: (plugin: string, range: string) =>
    `${plugin}: ${range} (plugin migrations, checked when Core starts)`,
  unknownMigrations: (plugin: string, range: string) =>
    `${plugin}: ${range} newer than this version of Miyoria`,
  changedMigrations: (plugin: string, range: string) =>
    `${plugin}: ${range} changed after being applied`,
  pendingMigrations: (plugin: string, range: string) =>
    `${plugin}: ${range} not applied yet (Core applies them at its next start)`,
  appliedMigrations: (plugin: string, range: string) => `${plugin}: ${range}`,
  checksSection: "Checks",
  integrityOk: "integrity_check: ok",
  integrityProblems: (n: number) =>
    `integrity_check found ${n} ${n === 1 ? "problem" : "problems"}`,
  foreignKeysOk: "foreign_key_check: ok",
  foreignKeyRows: (n: number) =>
    `foreign_key_check: ${n} ${n === 1 ? "row points" : "rows point"} to missing data`,
  contentsSection: "Contents",
  eventsV4: "events (log_events)",
  events: "events",
  contents: (persons: number, accounts: number, eventsLabel: string, events: number) =>
    `  People: ${persons}, accounts: ${accounts}, ${eventsLabel}: ${events}`,
  newestEvent: (at: string | null) => `  Newest event: ${at ?? common.none}`,
  serversSection: "Servers",
  noServers: "No servers yet",
  members: (n: number) => `${n} ${n === 1 ? "member" : "members"}`,
  tagPrimaryPending: "will become primary",
  tagPrimary: "primary",
  tagLeft: "the character has left",
  primaryPending:
    "The primary server is not decided yet: Core picks the one marked above at its next start (identity v2)",
  importPreviewSection: "What import-links would bring over (into an empty database)",
  importUnknown: (error: string) => `Cannot be calculated: ${error}`,
};
