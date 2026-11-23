// Names that come from the model (input file paths, script and tool names) become host paths,
// so they are checked twice: lexically here (portable rules, strict enough for Windows), then
// `safeJoin` makes sure the resolved path stays inside its base directory.

import { isAbsolute, relative, resolve, sep } from "node:path";
import { SandboxError } from "./types.js";

/** Deepest accepted input path. */
export const MAX_PATH_DEPTH = 8;
const MAX_SEGMENT = 100;
const MAX_PATH = 255;

/** Device names Windows resolves anywhere, with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
/** Characters Windows does not allow in names, plus `\` so `/` is the only separator. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it rejects
const FORBIDDEN = /[\u0000-\u001f\u007f<>:"|?*\\]/;

function invalid(path: string, why: string): SandboxError {
  return new SandboxError("invalid_path", `invalid path \`${path.slice(0, 80)}\`: ${why}`);
}

/**
 * Checks a relative POSIX path from untrusted input and returns it normalized (no `./`, no
 * repeated `/`). Rejects absolute paths, drive letters, `..`, `.`, empty segments, characters
 * Windows forbids (`:` also blocks alternate data streams), reserved device names, trailing dots
 * or spaces (Windows strips them, which would alias another name), and paths deeper than
 * `MAX_PATH_DEPTH`. Throws `SandboxError` (`invalid_path`).
 */
export function normalizeRelativePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) throw invalid(String(path), "empty");
  if (path.length > MAX_PATH) throw invalid(path, "too long");
  if (FORBIDDEN.test(path)) throw invalid(path, "forbidden character");
  if (path.startsWith("/")) throw invalid(path, "absolute");
  const segments = path.split("/");
  if (segments.length > MAX_PATH_DEPTH) throw invalid(path, "too deep");
  for (const segment of segments) {
    if (segment === "") throw invalid(path, "empty segment");
    if (segment === "." || segment === "..") throw invalid(path, "relative segment");
    if (segment.length > MAX_SEGMENT) throw invalid(path, "segment too long");
    if (/[. ]$/.test(segment)) throw invalid(path, "trailing dot or space");
    if (WINDOWS_RESERVED.test(segment)) throw invalid(path, "reserved name");
  }
  return segments.join("/");
}

/** The workspace's directory of the people's folders (`people.ts`). */
const PEOPLE = "people";

/**
 * Whether `path` (already normalized) lies under `people/<folder>/` of her workspace: such a path
 * is checked by its person-relative part (`normalizeWorkspacePath`). Case-insensitive, as the
 * file systems that ignore case alias `People` to `people`.
 */
export function inPersonFolder(path: string): boolean {
  const parts = path.split("/");
  return parts.length >= 2 && (parts[0] ?? "").toLowerCase() === PEOPLE;
}

/**
 * The deepest a directory at `dir` (a workspace path) may hold: `MAX_PATH_DEPTH`, plus the two
 * segments of `people/<folder>` below a person's folder, so a person gets the room a path of
 * theirs has (`normalizeWorkspacePath`).
 */
export function workspaceDepth(dir: string): number {
  return inPersonFolder(dir) ? MAX_PATH_DEPTH + 2 : MAX_PATH_DEPTH;
}

/**
 * `normalizeRelativePath` for a path of her whole workspace: a path under `people/<folder>/` is
 * held to the limits by what follows the folder (what the person wrote), not by the whole, so a
 * person gets the same 8 segments and 255 characters as anyone; `people` and the folder name are
 * checked as segments too. Every other path as `normalizeRelativePath`.
 */
export function normalizeWorkspacePath(path: string): string {
  if (typeof path === "string") {
    const parts = path.split("/");
    if (parts.length >= 3 && (parts[0] ?? "").toLowerCase() === PEOPLE) {
      const head = normalizeRelativePath(parts.slice(0, 2).join("/"));
      return `${head}/${normalizeRelativePath(parts.slice(2).join("/"))}`;
    }
  }
  return normalizeRelativePath(path);
}

/**
 * `base` joined with a path that already passed `normalize` (default `normalizeRelativePath`),
 * verified to resolve strictly inside `base`. Throws `SandboxError` (`invalid_path`) otherwise.
 */
export function safeJoin(
  base: string,
  relativePath: string,
  normalize: (path: string) => string = normalizeRelativePath,
): string {
  const root = resolve(base);
  const full = resolve(root, ...normalize(relativePath).split("/"));
  const rel = relative(root, full);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw invalid(relativePath, "escapes the workspace");
  }
  return full;
}

/** Script and tool names: lowercase letter first, then lowercase letters, digits, `_`, `-`. */
export const NAME = /^[a-z][a-z0-9_-]{0,47}$/;

/** Throws `SandboxError` (`invalid_path`) unless `name` matches `NAME`. */
export function checkName(name: string): string {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw invalid(String(name), "names are 1-48 of a-z, 0-9, `_`, `-`, starting with a letter");
  }
  return name;
}

/** Profile ids become directory names. */
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function checkProfileId(profile: string): string {
  if (!PROFILE.test(profile) || profile.includes("..")) {
    throw invalid(profile, "not a usable profile id");
  }
  return profile;
}

/** Case-folded key for duplicate checks (Windows and macOS file systems ignore case). */
export function pathKey(path: string): string {
  return path.toLowerCase();
}
