// Share links on the file origin (v5-architecture §11.2): `https://<file origin>/f/<token>`. The
// `share` tool asks for one when it hands a file over, and the member page when its person changes
// who may open their item. Every rule is checked here, before a token exists:
//
// - only what is in the artifact store, by id: never a path;
// - live (not expired, deleted, blocked or taken down); never a song cover;
// - a type of the allow-list (`allowedType`): images, audio, video, PDF, plain text and the zip
//   family, read again from the bytes for text and zips (`checkContent`, the same check `share`
//   makes): a text, and every text entry of a zip or Office file, passes the secret check (a
//   credential refuses it), and a zip is read whole under the zip limits and goes only to the
//   person it was made for;
// - an audience no wider than where it was made (`share-policy.ts` in the store);
// - a per-person quota of links in any rolling 24 hours (web pages count toward it too);
// - an image is linked as its cleaned copy (`clean.ts`), never with its metadata.
//
// A link for one person or a server's members needs the Discord login to be opened, so without it
// only links anyone may open are issued.

import type { ShareAudience } from "@miyoria/contracts/events";
import {
  ActuatorRegistryKey,
  checkContent,
  ZIP_MIMES,
  type ZipLimits,
  zipLimits,
} from "@miyoria/gate/actions";
import type { ServiceLookup } from "@miyoria/runtime/kernel";
import {
  type Artifact,
  type ArtifactCleaner,
  ArtifactShareError,
  type ArtifactStore,
  type FileLinkRequest,
  type FileLinkResult,
  type FileLinks,
  MEDIA_TYPES,
} from "@miyoria/store";
import {
  type ContextKey,
  type ModerationService,
  maskSecrets,
  type PersonId,
  toTimestamp,
} from "@miyoria/types";

const DAY_MS = 86_400_000;

/** Links and pages made for `person` in the last 24 hours: one quota for both. */
export function handedToday(store: ArtifactStore, person: PersonId, nowMs: number): number {
  const since = toTimestamp(nowMs - DAY_MS);
  return store.shares.countFor(person, since) + store.pages.countFor(person, since);
}

/** The types a link may open: what the store accepts, all of the allow-list. */
const ALLOWED = new Set(MEDIA_TYPES.map((t) => t.mime));

/** Whether a stored type may leave through the file origin. */
export function allowedType(mime: string): boolean {
  return ALLOWED.has(mime);
}

/** The place a secret check is made for (no platform: the web). */
const WEB: ContextKey = { platform: "web", scope: null, channel: "files", kind: "dm" };

/** Why a text may not leave, if it may not: a credential, or another output rule. */
export function textBlocked(
  text: string,
  moderation: ModerationService | undefined,
): string | null {
  const verdict = moderation?.screen({ path: "other", visible: text, context: WEB, turn: null });
  const block = verdict?.blocked[0];
  if (block !== undefined) return block.rule;
  return maskSecrets(text) === text ? null : "secrets.known-format";
}

/** The zip limits `share` applies, while the actions module is there. */
export function shareZip(services: ServiceLookup): ZipLimits | undefined {
  const share = services.get(ActuatorRegistryKey)?.config.share;
  return share === undefined ? undefined : zipLimits(share);
}

export type ContentRefusal = "type_not_allowed" | "secret";

export interface ContentCheckOptions {
  /** The link goes to the person the artifact was made for (a zip goes to nobody else). */
  owner: boolean;
  /** The zip limits (`[modules.actions.share]`); default: its defaults. */
  zip?: ZipLimits;
  signal?: AbortSignal;
}

/** Zips read whole are judged once per content for a while: every request opens them again. */
const ZIP_VERDICTS = new Map<string, { at: number; refusal: ContentRefusal | null }>();
const ZIP_VERDICT_MS = 10 * 60_000;
const ZIP_VERDICTS_KEPT = 64;

/**
 * Checks an artifact's own bytes before they leave: the type again from the content, a text
 * through the secret check, a zip (or Office file) read whole with its text entries through the
 * secret check, and only for its own person. `null`: fine; else why not.
 */
export async function contentRefusal(
  store: ArtifactStore,
  artifact: Artifact,
  moderation: ModerationService | undefined,
  options: ContentCheckOptions,
): Promise<ContentRefusal | null> {
  if (!allowedType(artifact.mime)) return "type_not_allowed";
  const zip = ZIP_MIMES.includes(artifact.mime);
  if (artifact.kind !== "text" && !zip) return null;
  if (zip && !options.owner) return "type_not_allowed";
  const key = `${artifact.sha256}:${artifact.mime}:${options.zip?.maxUnpackedBytes ?? 0}:${options.zip?.maxEntries ?? 0}`;
  const now = Date.now();
  const known = zip ? ZIP_VERDICTS.get(key) : undefined;
  if (known !== undefined && now - known.at < ZIP_VERDICT_MS) return known.refusal;
  const bytes = await store.readContent(artifact, options.signal);
  const verdict = await checkContent(bytes, true, {
    mime: artifact.mime,
    ...(options.zip === undefined ? {} : { zip: options.zip }),
    screen: (text) => {
      const rule = textBlocked(text, moderation);
      return rule === null ? null : { code: "secret", rule };
    },
  });
  const refusal: ContentRefusal | null = verdict.ok
    ? verdict.mime === artifact.mime
      ? null
      : "type_not_allowed"
    : verdict.code === "type_not_allowed"
      ? "type_not_allowed"
      : "secret";
  if (zip) {
    if (ZIP_VERDICTS.size >= ZIP_VERDICTS_KEPT) {
      const oldest = ZIP_VERDICTS.keys().next().value;
      if (oldest !== undefined) ZIP_VERDICTS.delete(oldest);
    }
    ZIP_VERDICTS.set(key, { at: now, refusal });
  }
  return refusal;
}

export interface FileLinkOptions {
  store: () => ArtifactStore | undefined;
  cleaner: ArtifactCleaner;
  /** The file origin, `https://files.example.com`. */
  origin: string;
  /** Whether links for one person or a server's members can be opened (the Discord login). */
  scoped: () => boolean;
  /** Links per person (the one an artifact was made for) in any rolling 24 hours. */
  perPersonPerDay: number;
  moderation: () => ModerationService | undefined;
  now: () => number;
  /** The zip limits `share` applies (`[modules.actions.share]`); default: its defaults. */
  zip?: () => ZipLimits | undefined;
}

const refuse = (
  refused: Extract<FileLinkResult, { ok: false }>["refused"],
  message: string,
): FileLinkResult => ({ ok: false, refused, message });

/** Issues links on one file origin. */
export class FileLinkService implements FileLinks {
  readonly #o: FileLinkOptions;

  constructor(options: FileLinkOptions) {
    this.#o = options;
  }

  get origin(): string {
    return this.#o.origin;
  }

  available(audience: ShareAudience): boolean {
    return audience === "link" || this.#o.scoped();
  }

  /** How many links and pages were made for `person` in the last 24 hours, and the quota. */
  quota(person: PersonId): { used: number; per_day: number } {
    const store = this.#o.store();
    return {
      used: store === undefined ? 0 : handedToday(store, person, this.#o.now()),
      per_day: this.#o.perPersonPerDay,
    };
  }

  async issue(request: FileLinkRequest, signal?: AbortSignal): Promise<FileLinkResult> {
    const store = this.#o.store();
    if (store === undefined) return refuse("unavailable", "there is no artifact store");
    if (!this.available(request.audience)) {
      return refuse("no_login", "a link for one person or a server needs the Discord login");
    }
    const artifact = store.get(request.artifact_id);
    if (artifact === null || !store.isLive(artifact)) {
      return refuse("not_found", "no such artifact (or it is gone)");
    }
    if (artifact.source === "sing" || !artifact.downloadable) {
      return refuse("song_cover", "song covers are never downloadable");
    }
    // A zip goes only to the person it was made for, as an attachment does.
    const owner = artifact.made_for !== null && request.requested_by === artifact.made_for;
    const zip = this.#o.zip?.();
    const content = await contentRefusal(store, artifact, this.#o.moderation(), {
      owner,
      ...(zip === undefined ? {} : { zip }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (content === "type_not_allowed") {
      return refuse("type_not_allowed", "this type is not handed out");
    }
    if (content === "secret") return refuse("secret", "the text holds what looks like a secret");
    if (artifact.made_for !== null) {
      const { used, per_day } = this.quota(artifact.made_for as PersonId);
      if (used >= per_day) return refuse("quota", "today's links for this person are used up");
    }
    let handed: Artifact;
    let stripped: boolean;
    try {
      ({ artifact: handed, stripped } = await this.#o.cleaner.handOut(artifact, signal));
    } catch {
      return refuse("type_not_allowed", "the image cannot be cleaned, so it is not handed out");
    }
    try {
      const { share, token } = store.shares.create(handed.id, {
        audience: request.audience,
        person_id: request.person_id ?? null,
        space_id: request.space_id ?? null,
        ttlMs: request.ttlMs === undefined ? undefined : request.ttlMs,
        requested_by: request.requested_by ?? null,
        turn: request.turn ?? null,
        widen: request.widen === true,
      });
      return {
        ok: true,
        url: `${this.#o.origin}/f/${token}`,
        share_id: share.id,
        artifact_id: handed.id,
        audience: share.audience,
        expires_at: share.expires_at,
        metadata_stripped: stripped,
      };
    } catch (error) {
      if (error instanceof ArtifactShareError) return refuse("audience", error.message);
      throw error;
    }
  }
}
