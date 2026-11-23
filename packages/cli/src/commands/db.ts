// `miyoria db`: the cut-over tools (docs/design/v5-data.md §7, §8 step 12), offline, printing what
// the store's functions did: `import-links` (who people are, from the V4 database), `archive`
// (moves a stopped V4 database aside with a single-file copy and hashes) and `doctor` (what a
// database file is, read-only).

import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { databaseUrl, profileId } from "@miyoria/core/light";
import { type Config, configureLogging } from "@miyoria/runtime/kernel";
import type {
  ArchiveOptions,
  ArchiveResult,
  LinkFileImportResult,
  LinkImportCounts,
  PlannedPerson,
} from "@miyoria/store";
import { t } from "../i18n/index.js";
import type { Prompter } from "../prompt.js";
import { bold, dim, fail, note, ok, println, section, warn } from "../ui.js";
import { loadConfig } from "./node.js";

export class DbCommandError extends Error {
  override readonly name = "DbCommandError";
}

/** What `archive` asks a person to type before it moves the database. */
export const ARCHIVE_WORD = "archive";

/** How many of each kind the import lists before the counts. */
const SAMPLE = 5;

/** The store, loaded only by these commands (`node:sqlite` and Drizzle stay out of the others). */
const loadStore = () => import("@miyoria/store");

/** Rethrows a store refusal in the CLI's words (the store's English detail after them). */
/**
 * These commands print a report; the store's own log lines (each migration it applies) would land
 * in the middle of it. Warnings and errors still show; `MIYORIA_LOG_LEVEL` overrides.
 */
function quietLogs(): void {
  if (!process.env.MIYORIA_LOG_LEVEL) configureLogging({ level: "warn" });
}

async function explained(error: unknown): Promise<never> {
  const { CutoverError } = await loadStore();
  if (error instanceof CutoverError) {
    throw new DbCommandError(`${t.db.reasons[error.code]}\n  ${dim(error.message)}`);
  }
  throw error;
}

/** A path as a person would type it here: relative when it is under the working directory. */
function shown(path: string): string {
  const rel = relative(process.cwd(), path);
  const text = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
  const slashed = sep === "\\" ? text.replaceAll("\\", "/") : text;
  return /[\s"']/.test(slashed) ? `"${slashed}"` : slashed;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The database file `core.database_url` names, absolute. */
export async function configuredDatabase(config: Config, configPath: string): Promise<string> {
  const { parseStoreUrl } = await loadStore();
  let path: string;
  try {
    path = parseStoreUrl(databaseUrl(config)).path;
  } catch (error) {
    throw new DbCommandError(
      t.db.notSqlite(error instanceof Error ? error.message : String(error)),
    );
  }
  if (path === ":memory:") {
    throw new DbCommandError(t.db.inMemory);
  }
  return isAbsolute(path) ? path : resolve(dirname(configPath), path);
}

const configFlag = (configPath: string) =>
  configPath === "miyoria.toml" ? "" : ` -c ${shown(resolve(configPath))}`;

function countLines(c: LinkImportCounts): string[] {
  return [
    t.db.countPersons(c.persons, c.choice_persons, c.accounts),
    t.db.countHandles(c.handles_kept, c.handles_renamed, c.handles_made),
    t.db.countPrefs(c.privacy, c.voice_consent),
    t.db.countLegacy(c.with_tier, c.cards),
    t.db.countSkipped(c.skipped_existing, c.skipped_no_accounts, c.orphan_accounts, c.handles_left),
  ];
}

function personLine(p: PlannedPerson): string {
  const parts = [bold(p.handle)];
  if (p.name !== p.handle) parts.push(dim(`(${p.name})`));
  parts.push(
    t.db.personAccounts(t.common.list(p.accounts.map((a) => `${a.platform}:${a.external_id}`))),
  );
  const prefs = [
    p.prefs.privacy !== undefined ? t.db.prefPrivacy : null,
    p.prefs.voice_consent !== undefined ? t.db.prefVoiceConsent : null,
  ].filter((x) => x !== null);
  if (prefs.length > 0) parts.push(t.db.personPrefs(t.common.list(prefs)));
  if (p.legacy === null) parts.push(dim(t.db.personChoiceOnly));
  else parts.push(t.db.personLegacy(p.legacy.old_tier ?? null, p.legacy.cards));
  if (p.old_handle !== null && p.old_handle !== p.handle) {
    parts.push(dim(t.db.personOldHandle(p.old_handle)));
  }
  return `  ${parts.join("  ")}`;
}

function list<T>(items: readonly T[], line: (item: T) => string): void {
  for (const item of items.slice(0, SAMPLE)) println(line(item));
  if (items.length > SAMPLE) println(dim(t.db.more(items.length - SAMPLE)));
}

// ---- import-links ---------------------------------------------------------------------------

export interface ImportLinksCommandOptions {
  from: string | undefined;
  dryRun: boolean;
}

/** `miyoria db import-links --from <file> [--dry-run]`. */
export async function importLinksCommand(
  configPath: string,
  options: ImportLinksCommandOptions,
): Promise<void> {
  quietLogs();
  if (options.from === undefined || options.from === "") {
    throw new DbCommandError(t.db.needFrom);
  }
  const config = await loadConfig(configPath);
  const from = resolve(options.from);
  const target = await configuredDatabase(config, configPath);
  if (basename(target).toLowerCase() === "miyoria.db") {
    throw new DbCommandError(t.db.stillOldFile(shown(target), configFlag(configPath)));
  }
  const profile = profileId(config);

  section(t.db.importSection(options.dryRun));
  note(t.db.oldDatabase(shown(from)));
  note(t.db.newDatabase(shown(target), existsSync(target)));
  note(t.db.profile(profile));

  const { importLinksFromFile, linkImportCounts } = await loadStore();
  let result: LinkFileImportResult;
  try {
    result = importLinksFromFile(from, target, { dryRun: options.dryRun, profile });
  } catch (error) {
    return await explained(error);
  }

  const counts = linkImportCounts(result);
  section(t.db.peopleSection(options.dryRun));
  if (result.persons.length === 0) note(t.db.noPeople);
  list(result.persons, personLine);
  const renamed = result.persons.filter((p) => p.old_handle !== null && p.old_handle !== p.handle);
  if (renamed.length > 0) {
    section(t.db.renamedSection);
    list(renamed, (p) => `  ${p.old_handle} → ${bold(p.handle)}`);
  }
  if (result.prefs_added.length > 0) {
    section(t.db.prefsAddedSection);
    list(result.prefs_added, (p) => `  ${p.account.platform}:${p.account.id}  ${p.pref}`);
  }
  const odd = [
    ...result.skipped.no_accounts.map((p) => t.db.skippedNoAccounts(p.name, String(p.id))),
    ...result.skipped.orphan_accounts.map((a) =>
      t.db.skippedOrphan(`${a.platform}:${a.external_id}`, String(a.person_id)),
    ),
    ...result.skipped.unreadable.map((key) => t.db.skippedUnreadable(key)),
  ];
  if (odd.length > 0) {
    section(t.db.skippedSection);
    list(odd, (line) => `  ${line}`);
  }
  if (result.conflicts.length > 0) {
    section(t.db.conflictsSection);
    list(result.conflicts, (c) => t.db.conflict(`${c.platform}:${c.external_id}`, c.name, c.owner));
    fail(t.db.reasons.conflict);
  }

  section(t.db.countsSection);
  for (const line of countLines(counts)) println(`  ${line}`);
  if (options.dryRun) {
    ok(t.db.dryRunDone);
  } else {
    ok(
      t.db.importDone(
        counts.persons + counts.choice_persons,
        counts.accounts,
        counts.events,
        result.created ? shown(target) : null,
      ),
    );
  }
}

// ---- archive ----------------------------------------------------------------------------------

export interface ArchiveCommandOptions {
  file: string | undefined;
  dryRun: boolean;
  yes: boolean;
  /** Replaces the store's seams in tests. */
  store?: Pick<ArchiveOptions, "clock" | "held">;
}

function printArchive(result: ArchiveResult): void {
  note(t.db.archiveTo(shown(result.dir)));
  for (const f of result.files) {
    const where = f.moved ? dim(t.db.movedBefore) : "";
    println(`  ${shown(f.from)} → ${basename(f.to)}  ${dim(bytes(f.size))}${where}`);
  }
  println(t.db.singleCopy(basename(result.single.path)));
  println(t.db.hashes(basename(result.manifest)));
}

function printNext(result: ArchiveResult, configPath: string): void {
  const data = dirname(result.files.find((f) => f.from.endsWith(".db"))?.from ?? result.dir);
  const fresh = join(data, "core.db");
  const url = relative(dirname(resolve(configPath)), fresh).replaceAll("\\", "/");
  const c = configFlag(configPath);
  const single = shown(result.single.path);
  section(t.db.nextSection);
  for (const command of [
    `miyoria config set core.database_url sqlite:${url}${c}`,
    `miyoria db import-links --from ${single} --dry-run${c}`,
    `miyoria db import-links --from ${single}${c}`,
    `miyoria db doctor ${shown(fresh)}${c}`,
    `miyoria core${c}`,
  ]) {
    println(`  ${command}`);
  }
  println(dim(t.db.rollback));
}

/** `miyoria db archive [file] [--dry-run]`. */
export async function archiveCommand(
  configPath: string,
  options: ArchiveCommandOptions,
  prompter: Prompter | null,
): Promise<void> {
  quietLogs();
  const path =
    options.file !== undefined
      ? resolve(options.file)
      : await configuredDatabase(await loadConfig(configPath), configPath);
  const { archiveDatabase } = await loadStore();
  const seams = options.store ?? {};
  section(t.db.archiveSection(options.dryRun));
  note(t.db.database(shown(path)));

  let plan: ArchiveResult;
  try {
    plan = await archiveDatabase({ path, ...seams, dryRun: true });
  } catch (error) {
    return await explained(error);
  }
  if (plan.state === "already") {
    printArchive(plan);
    ok(t.db.alreadyArchived(String(plan.date)));
    printNext(plan, configPath);
    return;
  }
  if (plan.resumed) warn(t.db.resumed);
  printArchive(plan);
  if (options.dryRun) {
    ok(t.db.archiveDryRunDone);
    return;
  }
  if (!options.yes) {
    if (prompter === null) throw new DbCommandError(t.db.needYes);
    const typed = await prompter.text(t.db.typeToConfirm(ARCHIVE_WORD), "");
    if (typed.trim() !== ARCHIVE_WORD) {
      println(t.db.archiveCancelled);
      return;
    }
  }

  let result: ArchiveResult;
  try {
    result = await archiveDatabase({ path, ...seams });
  } catch (error) {
    return await explained(error);
  }
  for (const f of result.files) {
    if (f.sha256 !== null) ok(`${basename(f.to)}  ${dim(`sha256 ${f.sha256.slice(0, 16)}…`)}`);
    else ok(`${basename(f.to)}  ${dim(t.db.indexFile)}`);
  }
  ok(
    `${basename(result.single.path)}  ${dim(`sha256 ${result.single.sha256?.slice(0, 16) ?? "?"}…`)}`,
  );
  ok(t.db.hashesWritten(shown(result.manifest)));
  printNext(result, configPath);
}

// ---- doctor -------------------------------------------------------------------------------------

function range(versions: readonly number[]): string {
  if (versions.length === 0) return t.common.none;
  const first = versions[0] as number;
  const last = versions.at(-1) as number;
  return versions.length === last - first + 1 && versions.length > 1
    ? `${first}–${last}`
    : versions.join(", ");
}

/** `miyoria db doctor [file]`. Throws when a check failed. */
export async function doctorCommand(configPath: string, file: string | undefined): Promise<void> {
  quietLogs();
  let path: string;
  let profile: string | null = null;
  if (file !== undefined) {
    path = resolve(file);
    if (existsSync(configPath)) profile = profileId(await loadConfig(configPath));
  } else {
    const config = await loadConfig(configPath);
    path = await configuredDatabase(config, configPath);
    profile = profileId(config);
  }
  const { inspectDatabase } = await loadStore();
  const r = inspectDatabase(path, { profile });
  let failures = 0;
  const bad = (msg: string) => {
    failures++;
    fail(msg);
  };

  section(t.db.doctorSection(shown(path)));
  const kind =
    r.layout === "v4"
      ? t.db.v4Layout(t.db.layouts.v4, String(r.v4_version))
      : t.db.layouts[r.layout];
  if (r.layout === "not_database") bad(kind);
  else if (r.layout === "missing" || r.layout === "foreign") warn(kind);
  else ok(kind);
  if (r.facts.exists) {
    const facts = [
      bytes(r.facts.size),
      r.facts.wal === null ? t.db.noWal : `-wal ${bytes(r.facts.wal)}`,
      r.facts.shm === null ? t.db.noShm : `-shm ${bytes(r.facts.shm)}`,
    ];
    if (r.facts.walMode !== null) facts.push(r.facts.walMode ? t.db.walMode : t.db.rollbackMode);
    note(t.common.list(facts));
  }
  if (!r.facts.exists || r.facts.walMode === null) {
    if (failures > 0) throw new DbCommandError(t.db.checksFailed(failures));
    return;
  }

  if (r.refusal === null) ok(t.db.coreOpens);
  else {
    warn(t.db.coreRefuses);
    println(dim(`    ${r.refusal}`));
  }

  if (r.migrations !== null) {
    section(t.db.migrationsSection);
    for (const m of r.migrations) {
      if (m.code === null) {
        note(t.db.pluginMigrations(m.plugin, range(m.applied)));
        continue;
      }
      if (m.unknown.length > 0) bad(t.db.unknownMigrations(m.plugin, range(m.unknown)));
      if (m.changed.length > 0) bad(t.db.changedMigrations(m.plugin, range(m.changed)));
      if (m.pending.length > 0) {
        warn(t.db.pendingMigrations(m.plugin, range(m.pending)));
      } else if (m.unknown.length === 0 && m.changed.length === 0) {
        ok(t.db.appliedMigrations(m.plugin, range(m.applied)));
      }
    }
  }

  section(t.db.checksSection);
  if (r.integrity !== null) {
    if (r.integrity.length === 1 && r.integrity[0] === "ok") ok(t.db.integrityOk);
    else {
      bad(t.db.integrityProblems(r.integrity.length));
      for (const line of r.integrity.slice(0, SAMPLE)) println(dim(`    ${line}`));
    }
  }
  if (r.foreign_keys !== null) {
    if (r.foreign_keys.count === 0) ok(t.db.foreignKeysOk);
    else {
      warn(t.db.foreignKeyRows(r.foreign_keys.count));
      for (const line of r.foreign_keys.first) println(dim(`    ${line}`));
    }
  }

  if (r.counts !== null) {
    section(t.db.contentsSection);
    const events = r.layout === "v4" ? t.db.eventsV4 : t.db.events;
    println(t.db.contents(r.counts.persons, r.counts.accounts, events, r.counts.events));
    println(t.db.newestEvent(r.counts.newest_event ?? null));
  }
  if (r.spaces !== null) {
    section(t.db.serversSection);
    if (r.spaces.length === 0) note(t.db.noServers);
    for (const s of r.spaces) {
      const tags = [
        s.primary ? (r.primary_pending ? t.db.tagPrimaryPending : t.db.tagPrimary) : null,
        s.left ? t.db.tagLeft : null,
      ].filter((tag) => tag !== null);
      println(
        `  ${s.name}  ${dim(`${s.platform}:${s.external_id}`)}  ${t.db.members(s.members)}${tags.length > 0 ? `  ${t.common.list(tags)}` : ""}`,
      );
    }
    if (r.primary_pending && r.spaces.length > 1) {
      warn(t.db.primaryPending);
    }
  }
  if (r.layout === "v4") {
    section(t.db.importPreviewSection);
    if (r.import !== null) for (const line of countLines(r.import)) println(`  ${line}`);
    else warn(t.db.importUnknown(r.import_error ?? "?"));
  }
  if (failures > 0) throw new DbCommandError(t.db.checksFailed(failures));
}
