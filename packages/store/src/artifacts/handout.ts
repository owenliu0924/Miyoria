// What hands an artifact out (v5-architecture §11.2), as services other packages look up: the store
// itself has no image encoder and no web origin, so the `api` module provides both.
//
// - `ArtifactCleanerKey`: what is handed out of an image is a re-encoded copy, without EXIF, text
//   chunks or anything else hidden in the file. The copy is an artifact of its own
//   (`derived_from` the original, plugin `CLEAN_PLUGIN`, the same place, scope, person and
//   retention), so it is made once and its shares are revoked with the original's.
// - `FileLinksKey`: share links (`https://<file origin>/f/<token>`). Present only while a file
//   origin is configured; without one no link is ever issued and attachments still work.

import type { ShareAudience } from "@miyoria/contracts/events";
import { type PersonId, serviceKey } from "@miyoria/types";
import type { ArtifactRow } from "./schema.js";

/** The plugin name of a cleaned copy. */
export const CLEAN_PLUGIN = "files.clean";

/** Whether `artifact` is a cleaned copy made for handing out. */
export function isCleanCopy(artifact: Pick<ArtifactRow, "plugin" | "derived_from">): boolean {
  return artifact.plugin === CLEAN_PLUGIN && artifact.derived_from !== null;
}

/** What is handed out of an artifact. */
export interface HandOut {
  /** The artifact to send or link: a cleaned copy of an image, else the artifact itself. */
  artifact: ArtifactRow;
  /** Whether image metadata was stripped (an image's cleaned copy). */
  stripped: boolean;
}

/** Makes the copy of an artifact that may leave the store. */
export interface ArtifactCleaner {
  /**
   * The artifact to hand out in place of `artifact`: for an image its cleaned copy (made now, or
   * the one made before); anything else as it is. Throws when an image cannot be re-encoded: an
   * image is never handed out with its metadata.
   */
  handOut(artifact: ArtifactRow, signal?: AbortSignal): Promise<HandOut>;
}

export const ArtifactCleanerKey = serviceKey<ArtifactCleaner>("ArtifactCleaner");

/** A link asked for. */
export interface FileLinkRequest {
  artifact_id: string;
  audience: ShareAudience;
  /** The person of a `person` link. */
  person_id?: PersonId | null;
  /** The space of a `space` link. */
  space_id?: string | null;
  /** How long it lives; default 7 days, never past the artifact. */
  ttlMs?: number | null;
  /** Who asked, and in which turn (the audit event). */
  requested_by?: PersonId | null;
  turn?: string | null;
  /** Its own person asked for the link audience themself (the member page only). */
  widen?: boolean;
}

/** Why no link was issued. */
export type FileLinkRefusal =
  | "unavailable"
  | "no_login"
  | "not_found"
  | "song_cover"
  | "type_not_allowed"
  | "audience"
  | "quota"
  | "secret";

export type FileLinkResult =
  | {
      ok: true;
      url: string;
      share_id: string;
      /** The artifact the link opens (an image's cleaned copy). */
      artifact_id: string;
      audience: ShareAudience;
      expires_at: string | null;
      metadata_stripped: boolean;
    }
  | { ok: false; refused: FileLinkRefusal; message: string };

/** Issues share links on the file origin. */
export interface FileLinks {
  /** Whether a link of `audience` can be issued at all (a scoped one needs the Discord login). */
  available(audience: ShareAudience): boolean;
  issue(request: FileLinkRequest, signal?: AbortSignal): Promise<FileLinkResult>;
}

export const FileLinksKey = serviceKey<FileLinks>("FileLinks");

/** A web page asked for: an HTML artifact and the files it loads, by relative path. */
export interface PagePublishRequest {
  artifact_id: string;
  assets: readonly { path: string; artifact_id: string }[];
  audience: ShareAudience;
  person_id?: PersonId | null;
  space_id?: string | null;
  /** How many days it stays up; default and cap are the file origin's. */
  days?: number | null;
  /** Whose page it is (its quota), and in which turn. */
  requested_by: PersonId | null;
  turn?: string | null;
  /** Its own person asked for anyone to open it (`to: anyone`). */
  widen?: boolean;
}

/** Why no page was published. */
export type PagePublishRefusal =
  | "unavailable"
  | "not_public"
  | "no_login"
  | "not_found"
  | "song_cover"
  | "not_html"
  | "type_not_allowed"
  | "asset_path"
  | "too_large"
  | "secret"
  | "audience"
  | "quota";

export type PagePublishResult =
  | {
      ok: true;
      url: string;
      page_id: string;
      audience: ShareAudience;
      expires_at: string;
      size: number;
    }
  /** `path`: the file of the page the refusal is about, when it is one of its files. */
  | { ok: false; refused: PagePublishRefusal; message: string; path?: string };

/** Publishes web pages on the file origin (present only while a file origin is configured). */
export interface FilePages {
  /** Whether a page of `audience` can be published (anyone: `pages_public`; scoped: the login). */
  available(audience: ShareAudience): boolean;
  publish(request: PagePublishRequest, signal?: AbortSignal): Promise<PagePublishResult>;
  /** The address of a page by its slug. */
  urlOf(slug: string): string;
}

export const FilePagesKey = serviceKey<FilePages>("FilePages");
