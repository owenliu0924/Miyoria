// `miyoria profile list | show | use | new` (docs/design/v5-profiles.md): which characters this
// install has, which one runs, picking the one that runs next, and starting a new, empty one.
// None of them touches a profile's data; `new` refuses a folder that is already there.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  DEFAULT_DATABASE_URL,
  databaseDir,
  databaseUrl,
  isProfileFolderName,
  listProfileFolders,
  PROFILE_CONFIG_FILE,
  PROFILE_ENV,
  peekConfig,
  type ResolvedProfile,
} from "@miyoria/core/light";
import { type Config, characterOf } from "@miyoria/runtime/kernel";
import { exampleConfig, exampleEnv, PACKAGE_ROOT } from "../assets.js";
import { t } from "../i18n/index.js";
import { capturedProcessEnv } from "../process-env.js";
import { profileLine, selectProfile } from "../profile.js";
import { TomlDocument } from "../toml-patch.js";
import { dim, ok, println, warn } from "../ui.js";

export class ProfileCommandError extends Error {
  override readonly name = "ProfileCommandError";
}

/** A new profile's folder name: what `profile new` accepts. */
const NEW_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** How the running profile was chosen, in words. */
function sourceOf(source: ResolvedProfile["source"]): string {
  switch (source) {
    case "env":
      return t.profile.sourceEnv(PROFILE_ENV);
    case "config":
      return "core.profile";
    case "default":
      return t.profile.sourceDefault;
  }
}

/**
 * The real environment, as Core sees it when it picks the profile: a `MIYORIA_PROFILE` written in
 * the install's `.env` (loaded into `process.env` for these commands) does not pick one there.
 */
function realEnv(): Record<string, string> {
  return Object.fromEntries(capturedProcessEnv());
}

function lookup(name: string): string | undefined {
  return process.env[name];
}

function profilesDirOf(profile: ResolvedProfile): string {
  return dirname(profile.dir);
}

/** The config the profile runs on, read leniently (`null` when it cannot be read). */
function runningConfig(profile: ResolvedProfile): Config | null {
  return peekConfig(profile.configPath, lookup);
}

export async function list(installPath: string): Promise<void> {
  const running = selectProfile(installPath, realEnv());
  const folders = listProfileFolders(profilesDirOf(running));
  if (folders.length === 0) {
    warn(t.profile.noProfiles(profilesDirOf(running)));
    return;
  }
  for (const f of folders) {
    const mark = f.id === running.id ? "●" : "○";
    const where = f.own ? t.profile.ownData : t.profile.installData;
    println(`${mark} ${f.id}  ${dim(where)}`);
  }
}

export async function show(installPath: string): Promise<void> {
  const profile = selectProfile(installPath, realEnv());
  const config = runningConfig(profile);
  const character = characterOf(config?.section("character"));
  println(t.profile.current(profileLine(profile, character.name)));
  println(t.profile.showSource(sourceOf(profile.source)));
  println(t.profile.showConfig(profile.configPath));
  const url = config === null ? DEFAULT_DATABASE_URL : databaseUrl(config);
  println(t.profile.showData(databaseDir(url, profile.baseDir) ?? url));
  println(t.profile.showPersona(profile.dir));
}

/** Writes `core.profile` of the install's config (comments kept); runs from the next start. */
export async function use(installPath: string, id: string): Promise<void> {
  if (!existsSync(installPath)) {
    throw new ProfileCommandError(t.profile.noInstall(installPath));
  }
  if (!isProfileFolderName(id)) throw new ProfileCommandError(t.profile.notFolderName(id));
  const current = selectProfile(installPath, {});
  const dir = join(profilesDirOf(current), id);
  if (!existsSync(join(dir, "profile.toml"))) {
    throw new ProfileCommandError(t.profile.notProfile(dir));
  }
  const text = readFileSync(installPath, "utf8");
  const doc = TomlDocument.parse(text);
  doc.set(["core", "profile"], id);
  const next = doc.toString();
  if (next !== text) writeFileSync(installPath, next, "utf8");
  const own = existsSync(join(dir, PROFILE_CONFIG_FILE));
  ok(t.profile.nextStart(id, own ? t.profile.dataOwn : t.profile.dataOf(installPath)));
  const env = realEnv()[PROFILE_ENV]?.trim();
  if (env) warn(t.profile.envOverrides(PROFILE_ENV, env));
}

export interface NewProfileOptions {
  /** Her name (`[character] name` and the persona's display name); default: the id. */
  name?: string;
  /** Where the persona templates are (tests). */
  templates?: string;
}

/** The files `profile new` writes, by path relative to the new folder. */
export function scaffold(
  id: string,
  name: string,
  profileDir: string,
  installDir: string,
  templates = join(PACKAGE_ROOT, "templates", "profile"),
): Map<string, string> {
  const fill = (text: string) => text.replaceAll("{{id}}", id).replaceAll("{{name}}", name);
  const files = new Map<string, string>();
  for (const file of ["profile.toml", "persona/identity.md", "persona/style.md"]) {
    files.set(file, fill(readFileSync(join(templates, file), "utf8")));
  }
  const doc = TomlDocument.parse(exampleConfig());
  doc.set(["core", "profile"], id);
  // Its persona is this folder: the profiles directory is the one above it.
  doc.set(["core", "profiles_dir"], "..");
  // A plain path: an inherited DATABASE_URL must never point her at another character's data.
  doc.set(["core", "database_url"], DEFAULT_DATABASE_URL);
  // Extensions are the install's software, not hers.
  const extensions = relative(profileDir, join(installDir, "extensions")).replaceAll("\\", "/");
  doc.set(["modules", "extensions", "dirs"], [extensions]);
  doc.set(["character", "name"], name);
  doc.set(["character", "short_name"], "");
  doc.set(["character", "other_names"], []);
  files.set(PROFILE_CONFIG_FILE, doc.toString());
  files.set(".env", exampleEnv());
  return files;
}

/** Creates `profiles/<id>/` for a new, empty character. Never writes into a folder that exists. */
export async function create(
  installPath: string,
  id: string,
  options: NewProfileOptions = {},
): Promise<void> {
  if (!NEW_ID.test(id)) {
    throw new ProfileCommandError(t.profile.badId(id));
  }
  const name = options.name?.trim() || id;
  const current = selectProfile(installPath, {});
  const dir = join(profilesDirOf(current), id);
  if (existsSync(dir)) {
    throw new ProfileCommandError(t.profile.exists(dir));
  }
  const files = scaffold(id, name, dir, dirname(resolve(installPath)), options.templates);
  mkdirSync(join(dir, "persona", "examples"), { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  for (const [file, text] of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text, "utf8");
  }
  ok(t.profile.created(dir));
  println(t.profile.newPersona(join(dir, "persona")));
  println(t.profile.newConfig(join(dir, PROFILE_CONFIG_FILE)));
  println(t.profile.newSecrets(join(dir, ".env")));
  println(t.profile.newData(join(dir, "data")));
  println(t.profile.newNext(id));
}
