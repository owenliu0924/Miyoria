// Web pages on the file origin (`https://<file origin>/p/<slug>/`): an HTML artifact she made, the
// files it loads by relative path (style, script, images), who may open it and until when. What a
// page may hold and how it is served is the `api` module's (`files/pages.ts`); this is the record.
//
// - A page's audience follows the share rule (`share-policy.ts`) for the page and every file in it:
//   never wider than where each was made; `link` (anyone) only for a public artifact or when its
//   own person asked (`widen`).
// - The slug is 128 random bits, kept as it is so its person can be given the address again. A
//   page for one person or a server still needs the login to open.
// - A page ends at its expiry or when it is taken back (`revoke`), and with the artifact it shows:
//   one deleted, expired or taken down closes the page, and a file of it that is gone answers 404.

import { randomBytes } from "node:crypto";
import type { ShareAudience } from "@miyoria/contracts/events";
import { newId, type PersonId, type Timestamp, toTimestamp } from "@miyoria/types";
import { and, desc, eq, gt, gte, isNull, type SQL } from "drizzle-orm";
import type { Db } from "../db.js";
import type { SpaceMembership } from "./membership.js";
import {
  type ArtifactPageAssetRow,
  type ArtifactPageRow,
  type ArtifactRow,
  artifactPageAssets,
  artifactPages,
  SHARE_AUDIENCES,
} from "./schema.js";
import { audienceAllowed } from "./share-policy.js";
import { ArtifactShareError } from "./shares.js";

export type ArtifactPage = ArtifactPageRow;
export type ArtifactPageAsset = ArtifactPageAssetRow;

const SLUG = /^[A-Za-z0-9_-]{22}$/;

/** One part of a file's path in a page: a name, never `.`, `..` or hidden. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** The most files one page loads. */
export const PAGE_MAX_ASSETS = 64;

/**
 * `raw` as the relative path a page names a file by (`style.css`, `img/cat.png`), or `null` when
 * it is not one: plain names joined by `/`, at most 8 deep and 200 characters.
 */
export function pageAssetPath(raw: string): string | null {
  const path = raw.trim().replace(/^\.\//, "");
  if (path === "" || path.length > 200) return null;
  const parts = path.split("/");
  if (parts.length > 8 || !parts.every((p) => SEGMENT.test(p))) return null;
  return path;
}

export interface PageInput {
  /** The HTML artifact. */
  artifact_id: string;
  assets: readonly { path: string; artifact_id: string }[];
  audience: ShareAudience;
  person_id?: PersonId | null;
  space_id?: string | null;
  /** Whose page it is (who asked). */
  made_for: PersonId | null;
  /** The bytes of the page and its files together. */
  size: number;
  ttlMs: number;
  /** Its person asked for anyone to open it themself (see `ShareInput.widen`). */
  widen?: boolean;
}

/** Why a slug does not open a page. */
export type PageRefusal = "unknown" | "revoked" | "expired" | "gone";

export type PageLookup =
  | { ok: true; page: ArtifactPage; artifact: ArtifactRow }
  | { ok: false; reason: PageRefusal };

/** What the pages need of the artifact store. */
export interface PageDeps {
  get(id: string): ArtifactRow | null;
  isLive(artifact: ArtifactRow): boolean;
  isMember: SpaceMembership;
}

/** The web pages of one database's artifacts. */
export class ArtifactPages {
  readonly #db: Db;
  readonly #deps: PageDeps;

  constructor(db: Db, deps: PageDeps) {
    this.#db = db;
    this.#deps = deps;
  }

  #now(): number {
    return this.#db.clock.now();
  }

  /** Records a page; throws `ArtifactShareError` when a file is gone or the audience too wide. */
  create(input: PageInput): ArtifactPage {
    if (!SHARE_AUDIENCES.includes(input.audience)) {
      throw new ArtifactShareError(`unknown audience \`${String(input.audience)}\``);
    }
    if (input.audience === "person" && !input.person_id) {
      throw new ArtifactShareError("a `person` page needs the person");
    }
    if (input.audience === "space" && !input.space_id) {
      throw new ArtifactShareError("a `space` page needs the space");
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
      throw new ArtifactShareError("a page's lifetime must be more than 0");
    }
    if (input.assets.length > PAGE_MAX_ASSETS) {
      throw new ArtifactShareError(`a page loads at most ${PAGE_MAX_ASSETS} files`);
    }
    const paths = new Set<string>();
    for (const asset of input.assets) {
      if (pageAssetPath(asset.path) !== asset.path || paths.has(asset.path)) {
        throw new ArtifactShareError(`not a usable file path: \`${asset.path}\``);
      }
      paths.add(asset.path);
    }
    return this.#db.tx(() => {
      for (const id of [input.artifact_id, ...input.assets.map((a) => a.artifact_id)]) {
        const artifact = this.#deps.get(id);
        if (artifact === null || !this.#deps.isLive(artifact)) {
          throw new ArtifactShareError("a file of the page is gone");
        }
        const verdict = audienceAllowed(artifact, input, this.#deps.isMember, input.widen === true);
        if (!verdict.ok) throw new ArtifactShareError(verdict.message, verdict.reason);
      }
      const nowMs = this.#now();
      const id = newId();
      const page = this.#db.orm
        .insert(artifactPages)
        .values({
          id,
          slug: randomBytes(16).toString("base64url"),
          artifact_id: input.artifact_id,
          audience: input.audience,
          person_id: input.audience === "person" ? (input.person_id ?? null) : null,
          space_id: input.audience === "space" ? (input.space_id ?? null) : null,
          made_for: input.made_for,
          size: Math.max(1, Math.floor(input.size)),
          created_at: toTimestamp(nowMs),
          expires_at: toTimestamp(nowMs + input.ttlMs),
        })
        .returning()
        .get();
      for (const asset of input.assets) {
        this.#db.orm
          .insert(artifactPageAssets)
          .values({ page_id: id, path: asset.path, artifact_id: asset.artifact_id })
          .run();
      }
      return page;
    });
  }

  #check(page: ArtifactPage | undefined, nowMs: number): PageLookup {
    if (page === undefined) return { ok: false, reason: "unknown" };
    if (page.revoked_at !== null) return { ok: false, reason: "revoked" };
    if (Date.parse(page.expires_at) <= nowMs) return { ok: false, reason: "expired" };
    const artifact = this.#deps.get(page.artifact_id);
    if (artifact === null || !this.#deps.isLive(artifact)) return { ok: false, reason: "gone" };
    return { ok: true, page, artifact };
  }

  /** What a slug opens now. */
  bySlug(slug: string): PageLookup {
    if (typeof slug !== "string" || !SLUG.test(slug)) return { ok: false, reason: "unknown" };
    this.#db.ensureOpen();
    const row = this.#db.orm.select().from(artifactPages).where(eq(artifactPages.slug, slug)).get();
    return this.#check(row, this.#now());
  }

  /** Whether a page opens now. */
  isOpen(page: ArtifactPage): boolean {
    return this.#check(page, this.#now()).ok;
  }

  /** A page by id, whatever its state. */
  get(id: string): ArtifactPage | null {
    this.#db.ensureOpen();
    return this.#db.orm.select().from(artifactPages).where(eq(artifactPages.id, id)).get() ?? null;
  }

  /** The files of a page, by path. */
  assets(pageId: string): ArtifactPageAsset[] {
    return this.#db.orm
      .select()
      .from(artifactPageAssets)
      .where(eq(artifactPageAssets.page_id, pageId))
      .orderBy(artifactPageAssets.path)
      .all();
  }

  /** The live artifact a page names `path`, or `null`. */
  asset(pageId: string, path: string): ArtifactRow | null {
    const row = this.#db.orm
      .select()
      .from(artifactPageAssets)
      .where(and(eq(artifactPageAssets.page_id, pageId), eq(artifactPageAssets.path, path)))
      .get();
    if (row === undefined) return null;
    const artifact = this.#deps.get(row.artifact_id);
    return artifact !== null && this.#deps.isLive(artifact) ? artifact : null;
  }

  /** Pages, newest first: of one person (`made_for`), and only those still open (`open`). */
  list(filter: { made_for?: PersonId; open?: boolean; limit?: number } = {}): ArtifactPage[] {
    const t = artifactPages;
    const where: SQL[] = [];
    if (filter.made_for !== undefined) where.push(eq(t.made_for, filter.made_for));
    if (filter.open === true) {
      where.push(isNull(t.revoked_at));
      where.push(gt(t.expires_at, toTimestamp(this.#now())));
    }
    const rows = this.#db.orm
      .select()
      .from(t)
      .where(and(...where))
      .orderBy(desc(t.id))
      .limit(Math.min(Math.max(1, Math.floor(filter.limit ?? 50)), 500))
      .all();
    return filter.open === true ? rows.filter((p) => this.isOpen(p)) : rows;
  }

  /** Takes a page back at once. `false`: unknown or already taken back. */
  revoke(id: string): boolean {
    const row = this.#db.orm
      .update(artifactPages)
      .set({ revoked_at: toTimestamp(this.#now()) })
      .where(and(eq(artifactPages.id, id), isNull(artifactPages.revoked_at)))
      .returning({ id: artifactPages.id })
      .get();
    return row !== undefined;
  }

  /** How many pages were made for `person` since `since` (taken back ones included). */
  countFor(person: PersonId, since: Timestamp): number {
    this.#db.ensureOpen();
    return this.#db.orm
      .select({ id: artifactPages.id })
      .from(artifactPages)
      .where(and(eq(artifactPages.made_for, person), gte(artifactPages.created_at, since)))
      .all().length;
  }
}
