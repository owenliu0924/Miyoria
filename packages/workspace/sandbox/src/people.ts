// Her workspace, one folder per person. A tool call made for someone (they asked, or a helper
// works for them) sees only `people/<their folder>/`: its paths are relative to that folder,
// listing shows nothing else, and nothing outside can be read, written, deleted, exported or
// mounted into a run. Her own calls with nobody behind them see the whole workspace with the paths
// they always had, except `people/`: a member can get such a call made (a glance at what they
// said, something left in her inbox), so other people's folders are not hers to reach. Only an
// owner (`WORKSPACE_ALL`) and the admin panel see everything.
//
// The folder view goes through the whole workspace's own methods, so every path defence stays:
// the person's path is checked lexically first (no `..`, absolute paths, drive letters or
// backslashes), then the workspace checks every component from its root with `lstat` (a link
// planted at `people`, at the folder or inside it is never followed) and opens with O_NOFOLLOW.

import { createHash } from "node:crypto";
import { WORKSPACE_ALL } from "@miyoria/gate/actions";
import type { ServiceLookup } from "@miyoria/runtime/kernel";
import { AuthorizerKey, type Principal, SocialSignalsKey } from "@miyoria/types";
import { normalizeRelativePath } from "./paths.js";
import { SandboxError } from "./types.js";
import type {
  ReadOptions,
  WorkspaceApi,
  WorkspaceEntry,
  WorkspaceLimits,
  WorkspaceRead,
  WorkspaceUsage,
} from "./workspace-store.js";

/** Where the people's folders are, in her workspace. */
export const PEOPLE_DIR = "people";

/** What `personFolder` makes: lowercase letters, digits, `_` and `-`. */
export const PERSON_FOLDER = /^[a-z0-9_][a-z0-9_-]{0,64}$/;

/** A person's caps in their folder (the per-file cap is the workspace's). */
export interface PersonLimits {
  maxBytes: number;
  maxFiles: number;
}

/** The defaults of `[modules.sandbox.workspace] person_max_mb` and `person_max_files`. */
export const DEFAULT_PERSON_LIMITS: PersonLimits = { maxBytes: 256 * 1024 * 1024, maxFiles: 2000 };

/**
 * The folder name of a person id: the id itself (lowercased: file systems that ignore case must
 * not alias two people) when it is a plain name, otherwise `_` and a hash, which no plain id
 * starts with.
 */
export function personFolder(id: string): string {
  const plain = id.toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(plain)) {
    try {
      if (normalizeRelativePath(plain) === plain) return plain;
    } catch {
      // A reserved device name: hashed below.
    }
  }
  return `_${createHash("sha256").update(id, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * What of the workspace a call reaches: `all` (an owner, the panel), `own` (her own call with
 * nobody behind it: everything but `people/`), or one person's `folder`.
 */
export type WorkspaceScope = { kind: "all" } | { kind: "own" } | { kind: "person"; folder: string };

/**
 * The scope of a call made for `principal`. Whoever asked is confined to their folder, whatever
 * the principal's kind, so a member cannot widen it by asking her to act "on her own"; someone
 * who holds `WORKSPACE_ALL` (owners) and the panel reach everything; her own call with nobody
 * behind it reaches everything but the people's folders. Without an authorizer nobody is taken
 * for an owner.
 */
export function scopeFor(principal: Principal, services: ServiceLookup): WorkspaceScope {
  if (principal.kind === "panel") return { kind: "all" };
  const requester = principal.requester;
  if (requester === null) return { kind: "own" };
  if (services.get(AuthorizerKey)?.allows(requester, WORKSPACE_ALL) === true) {
    return { kind: "all" };
  }
  // The heart's person id outlives a re-linked account; an account the heart does not know
  // gets a folder of its own.
  const person = services.get(SocialSignalsKey)?.attitude(requester)?.person ?? null;
  return {
    kind: "person",
    folder: personFolder(person ?? `${requester.platform}-${requester.id}`),
  };
}

/** The folder of `scopeFor`, or `null` when the call is not confined to one. */
export function folderFor(principal: Principal, services: ServiceLookup): string | null {
  const scope = scopeFor(principal, services);
  return scope.kind === "person" ? scope.folder : null;
}

/** The workspace a call for `principal` works in, its folder and its scope. */
export function workspaceFor(
  root: WorkspaceApi,
  principal: Principal,
  services: ServiceLookup,
  limits: PersonLimits = DEFAULT_PERSON_LIMITS,
): { workspace: WorkspaceApi; folder: string | null; scope: WorkspaceScope } {
  const scope = scopeFor(principal, services);
  return {
    workspace:
      scope.kind === "person"
        ? new PersonWorkspace(root, scope.folder, limits)
        : scope.kind === "own"
          ? new OwnWorkspace(root)
          : root,
    folder: scope.kind === "person" ? scope.folder : null,
    scope,
  };
}

/** Whether `path` names `people` or something in it (any case: file systems that ignore it alias). */
function inPeople(path: string): boolean {
  return (path.split("/")[0] ?? "").toLowerCase() === PEOPLE_DIR;
}

/**
 * Her whole workspace without the people's folders, for her own calls: `people` and everything
 * under it cannot be listed, read, written, deleted (the folder itself neither), exported or run.
 */
export class OwnWorkspace implements WorkspaceApi {
  readonly limits: WorkspaceLimits;

  constructor(readonly root: WorkspaceApi) {
    this.limits = root.limits;
  }

  /** The path, refused when it reaches into `people/`. */
  #mine(path: string): string {
    const normalized = normalizeRelativePath(path);
    if (inPeople(normalized)) {
      throw new SandboxError(
        "invalid_path",
        `invalid workspace path \`${normalized.slice(0, 80)}\`: people/ holds other people's folders`,
      );
    }
    return normalized;
  }

  usage(): Promise<WorkspaceUsage> {
    return this.root.usage();
  }

  async list(prefix?: string): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
    const base = prefix?.replace(/\/+$/, "") ?? "";
    const { entries, truncated } = await this.root.list(base === "" ? undefined : this.#mine(base));
    return { entries: entries.filter((e) => !inPeople(e.path)), truncated };
  }

  async read(path: string, options?: ReadOptions): Promise<WorkspaceRead> {
    return this.root.read(this.#mine(path), options);
  }

  async write(path: string, text: string, options?: { append?: boolean }): Promise<WorkspaceEntry> {
    return this.root.write(this.#mine(path), text, options);
  }

  async readBytes(path: string, maxBytes: number): Promise<Uint8Array> {
    return this.root.readBytes(this.#mine(path), maxBytes);
  }

  async remove(path: string): Promise<boolean> {
    return this.root.remove(this.#mine(path));
  }

  async exists(path: string): Promise<boolean> {
    return this.root.exists(this.#mine(path));
  }

  async saveScript(path: string, text: string): Promise<WorkspaceEntry> {
    return this.root.saveScript(this.#mine(path), text);
  }

  async approvedScript(path: string): Promise<Awaited<ReturnType<WorkspaceApi["approvedScript"]>>> {
    let mine: string;
    try {
      mine = this.#mine(path);
    } catch {
      return null;
    }
    return this.root.approvedScript(mine);
  }
}

/** One person's folder of the workspace, as a workspace of its own. */
export class PersonWorkspace implements WorkspaceApi {
  readonly limits: WorkspaceLimits;
  /** `people/<folder>`, the folder's path in the whole workspace. */
  readonly prefix: string;

  constructor(
    readonly root: WorkspaceApi,
    readonly folder: string,
    limits: PersonLimits,
  ) {
    if (!PERSON_FOLDER.test(folder)) {
      throw new SandboxError("invalid_path", "not a person's folder");
    }
    this.prefix = `${PEOPLE_DIR}/${folder}`;
    this.limits = {
      maxBytes: Math.min(limits.maxBytes, root.limits.maxBytes),
      maxFiles: Math.min(limits.maxFiles, root.limits.maxFiles),
      maxFileBytes: root.limits.maxFileBytes,
    };
  }

  /** The path in the whole workspace, after the person's path passed the lexical checks. */
  #inRoot(path: string): string {
    return `${this.prefix}/${normalizeRelativePath(path)}`;
  }

  /** The person's path back from a path of the whole workspace. */
  #own(path: string): string {
    return path.startsWith(`${this.prefix}/`) ? path.slice(this.prefix.length + 1) : path;
  }

  /** Runs `fn`, telling a refusal in the person's paths (their folder's name is not theirs to see). */
  async #in<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof SandboxError)) throw error;
      throw new SandboxError(error.kind, error.message.replaceAll(`${this.prefix}/`, ""));
    }
  }

  async #entries(): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
    return this.#in(() => this.root.list(this.prefix));
  }

  async usage(): Promise<WorkspaceUsage> {
    const { entries, truncated } = await this.#entries();
    return {
      files: entries.length,
      bytes: entries.reduce((n, e) => n + e.size, 0),
      overflow: truncated,
    };
  }

  async list(prefix?: string): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
    const base =
      prefix === undefined || prefix.replace(/\/+$/, "") === ""
        ? this.prefix
        : this.#inRoot(prefix.replace(/\/+$/, ""));
    const { entries, truncated } = await this.#in(() => this.root.list(base));
    return { entries: entries.map((e) => ({ path: this.#own(e.path), size: e.size })), truncated };
  }

  async read(path: string, options?: ReadOptions): Promise<WorkspaceRead> {
    const full = this.#inRoot(path);
    const r = await this.#in(() => this.root.read(full, options));
    return { ...r, path: this.#own(r.path) };
  }

  /** Refuses a write that would take the folder over its caps. */
  async #fits(path: string, size: (old: number | null) => number): Promise<void> {
    const { entries, truncated } = await this.#entries();
    if (truncated) {
      throw new SandboxError("limit", "the workspace has too many entries; delete some first");
    }
    const key = path.toLowerCase();
    const old = entries.find((e) => this.#own(e.path).toLowerCase() === key)?.size ?? null;
    const bytes = entries.reduce((n, e) => n + e.size, 0);
    if (old === null && entries.length + 1 > this.limits.maxFiles) {
      throw new SandboxError("limit", `at most ${this.limits.maxFiles} files in your folder`);
    }
    if (bytes - (old ?? 0) + size(old) > this.limits.maxBytes) {
      throw new SandboxError("limit", `your folder is full (${this.limits.maxBytes} bytes)`);
    }
  }

  async write(path: string, text: string, options?: { append?: boolean }): Promise<WorkspaceEntry> {
    const full = this.#inRoot(path);
    const add = Buffer.byteLength(text, "utf8");
    await this.#fits(
      normalizeRelativePath(path),
      (old) => (options?.append ? (old ?? 0) : 0) + add,
    );
    const written = await this.#in(() => this.root.write(full, text, options));
    return { path: this.#own(written.path), size: written.size };
  }

  async readBytes(path: string, maxBytes: number): Promise<Uint8Array> {
    const full = this.#inRoot(path);
    return this.#in(() => this.root.readBytes(full, maxBytes));
  }

  async remove(path: string): Promise<boolean> {
    const full = this.#inRoot(path);
    return this.#in(() => this.root.remove(full));
  }

  async exists(path: string): Promise<boolean> {
    const full = this.#inRoot(path);
    return this.#in(() => this.root.exists(full));
  }

  async saveScript(path: string, text: string): Promise<WorkspaceEntry> {
    const full = this.#inRoot(path);
    await this.#fits(normalizeRelativePath(path), () => Buffer.byteLength(text, "utf8"));
    const saved = await this.#in(() => this.root.saveScript(full, text));
    return { path: this.#own(saved.path), size: saved.size };
  }

  async approvedScript(path: string): Promise<Awaited<ReturnType<WorkspaceApi["approvedScript"]>>> {
    let full: string;
    try {
      full = this.#inRoot(path);
    } catch {
      return null;
    }
    return this.root.approvedScript(full);
  }
}

/**
 * Sessions are hers by name; one run for someone lives under a name of theirs: `<tag>-<name>`,
 * so they never reach a session (and its `/work`) of hers or of someone else.
 */
export interface SessionView {
  /** The session's real name for a name the caller used (`fresh` stays `fresh`). */
  real(name: string): string;
  /** The caller's name of a real session, or `null` when it is not theirs. */
  own(real: string): string | null;
  /** Longest name the caller may use. */
  readonly maxName: number;
}

const SESSION_NAME_MAX = 48;

/** The whole set of sessions, for the owners. */
export const ALL_SESSIONS: SessionView = {
  real: (name) => name,
  own: (real) => real,
  maxName: SESSION_NAME_MAX,
};

/** What `sessionView` puts in front of a person's session names. */
const PERSON_SESSION = /^p[0-9a-f]{7}-/;

/** Her own sessions: every one but the people's, whose `/work` is theirs. */
export const OWN_SESSIONS: SessionView = {
  real: (name) => name,
  own: (real) => (PERSON_SESSION.test(real) ? null : real),
  maxName: SESSION_NAME_MAX,
};

/**
 * The sessions of the person whose folder is `folder`; `null`: all of them, or with `own` her
 * own (`OWN_SESSIONS`). A name the caller may not use is one whose `own(real(name))` is `null`.
 */
export function sessionView(folder: string | null, own = false): SessionView {
  if (folder === null) return own ? OWN_SESSIONS : ALL_SESSIONS;
  const tag = `p${createHash("sha256").update(folder, "utf8").digest("hex").slice(0, 7)}-`;
  return {
    real: (name) => (name === "fresh" ? name : `${tag}${name}`),
    own: (real) => (real.startsWith(tag) ? real.slice(tag.length) : null),
    maxName: SESSION_NAME_MAX - tag.length,
  };
}
