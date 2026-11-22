// Which profile runs, and where its config and data are (docs/design/v5-profiles.md).
//
// A profile is `profiles/<id>/`: the persona files it always had and, when it is a character of
// its own, a `miyoria.toml` (with `.env` and `data/` beside it). One runs at a time. It is picked
// by `MIYORIA_PROFILE`, else the install config's `core.profile`, else `deepseek-chan`. A profile
// without a `miyoria.toml` of its own runs on the install's config and data, which is how the
// install that existed before profiles keeps running exactly as it did. Machines (`host.toml`,
// the pairing) are the install's whatever profile runs.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { Config, type EnvLookup } from "@miyoria/runtime/kernel";
import {
  DEFAULT_PROFILE,
  DEFAULT_PROFILES_DIR,
  resolveDatabaseUrl,
  sqlitePath,
} from "./settings.js";

/** Picks the profile over the install config's `core.profile`. */
export const PROFILE_ENV = "MIYORIA_PROFILE";
/** A profile's own config file, in its folder. */
export const PROFILE_CONFIG_FILE = "miyoria.toml";

export type ProfileSource = "env" | "config" | "default";

export interface ResolvedProfile {
  /** The folder name under the profiles directory (the store's profile id). */
  id: string;
  /** `<profiles_dir>/<id>`. */
  dir: string;
  /** It has a `miyoria.toml` of its own: its own config, `.env` and data. */
  own: boolean;
  /** The config file the character runs on: the profile's own, else the install's. */
  configPath: string;
  /** What that config's relative paths (the database, `data/`) resolve against. */
  baseDir: string;
  /** The install's config: `host.toml` and the machines stay beside it. */
  installPath: string;
  source: ProfileSource;
}

export class ProfileSelectError extends Error {
  override readonly name = "ProfileSelectError";
}

/** A folder name that stays inside the profiles directory. */
export function isProfileFolderName(id: string): boolean {
  return id !== "" && id !== "." && id !== ".." && !/[\\/]/.test(id);
}

/** `.env` beside `configPath` as a map; empty when there is none. */
export function readDotenv(configPath: string): Map<string, string> {
  let text: string;
  try {
    text = readFileSync(join(dirname(configPath), ".env"), "utf8");
  } catch {
    return new Map();
  }
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(parseEnv(text))) if (typeof v === "string") out.set(k, v);
  return out;
}

/**
 * A config file read only for what it says about profiles: references expand from `env`, then
 * `dotenv`, and to `""` when neither has them, so this never fails on a missing variable (the
 * command that loads the file for real reports that). `null`: no file, or not TOML.
 */
export function peekConfig(
  path: string,
  env: EnvLookup,
  dotenv: ReadonlyMap<string, string> = readDotenv(path),
): Config | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return Config.fromToml(text, (name) => env(name) ?? dotenv.get(name) ?? "");
  } catch {
    return null;
  }
}

function coreString(config: Config | null, key: string): string | undefined {
  const value = config?.section(`core.${key}`);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * The profile to run for the install config at `installPath` (`install`: that file as
 * `peekConfig` read it, `null` when there is none). Throws `ProfileSelectError` when the profile
 * has a config of its own that names another profile or another profiles directory, so its
 * persona and its data could not be told apart.
 */
export function resolveProfile(
  installPath: string,
  install: Config | null,
  env: EnvLookup,
): ResolvedProfile {
  const absInstall = resolve(installPath);
  const installDir = dirname(absInstall);
  const fromEnv = env(PROFILE_ENV)?.trim() ?? "";
  const fromConfig = coreString(install, "profile");
  const id = fromEnv !== "" ? fromEnv : (fromConfig ?? DEFAULT_PROFILE);
  const source: ProfileSource = fromEnv !== "" ? "env" : fromConfig ? "config" : "default";
  const profilesDir = resolve(
    installDir,
    coreString(install, "profiles_dir") ?? DEFAULT_PROFILES_DIR,
  );
  const dir = join(profilesDir, id);
  const own = isProfileFolderName(id) && existsSync(join(dir, PROFILE_CONFIG_FILE));
  const base = { id, dir, installPath: absInstall, source };
  if (!own) {
    // The install's config names its persona itself; the variable cannot pick another one for it.
    if (source === "env" && id !== (fromConfig ?? DEFAULT_PROFILE)) {
      throw new ProfileSelectError(
        isProfileFolderName(id)
          ? `${PROFILE_ENV}=${id}:${dir} 沒有自己的 ${PROFILE_CONFIG_FILE}(用 \`miyoria profile new ${id}\` 建一個)`
          : `${PROFILE_ENV}=${id} 不是資料夾名稱`,
      );
    }
    return { ...base, own: false, configPath: absInstall, baseDir: installDir };
  }
  const configPath = join(dir, PROFILE_CONFIG_FILE);
  if (configPath !== absInstall) {
    const mine = peekConfig(configPath, env);
    const named = coreString(mine, "profile");
    if (named !== undefined && named !== id) {
      throw new ProfileSelectError(
        `${configPath} 的 core.profile 是「${named}」,要和它的資料夾名稱「${id}」一樣`,
      );
    }
    const itsDir = resolve(dir, coreString(mine, "profiles_dir") ?? DEFAULT_PROFILES_DIR);
    if (mine !== null && itsDir !== profilesDir) {
      throw new ProfileSelectError(
        `${configPath} 的 core.profiles_dir 要指向 ${profilesDir}(通常寫 ".."),不然讀不到它自己的人格`,
      );
    }
  }
  return { ...base, own: true, configPath, baseDir: dir };
}

/** One profile on disk, for `miyoria profile list`. */
export interface ProfileFolder {
  id: string;
  /** Has a `miyoria.toml` of its own. */
  own: boolean;
}

/** The folders under `profilesDir` with a `profile.toml`, sorted. */
export function listProfileFolders(profilesDir: string): ProfileFolder[] {
  if (!existsSync(profilesDir)) return [];
  return readdirSync(profilesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(profilesDir, e.name, "profile.toml")))
    .map((e) => ({ id: e.name, own: existsSync(join(profilesDir, e.name, PROFILE_CONFIG_FILE)) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The folder of a `sqlite:` database URL resolved against `baseDir`; `null` for other stores. */
export function databaseDir(url: string, baseDir: string): string | null {
  const path = sqlitePath(resolveDatabaseUrl(url, baseDir));
  if (path === null || path === ":memory:") return null;
  return dirname(path);
}
