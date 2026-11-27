// Web pages on the file origin (`page_publish`): an HTML file she made, and the files it loads by
// relative path, published at `https://<file origin>/p/<slug>/` where a browser renders it.
//
// The harms this guards against, and only these (owner 2026-11-23: default to capability):
//
// 1. The page reaching the panel or anything of ours. It is on the file origin, never the panel's
//    host; nothing there sets or reads a cookie; and every answer of a page carries a CSP `sandbox`
//    without `allow-same-origin`, so the page runs in an opaque origin of its own and cannot read
//    another page or file of this host. `X-Frame-Options: DENY` and `frame-ancestors 'none'` keep
//    it out of other sites' frames.
// 2. Phishing and data theft under the owner's domain (a fake login page). Forms never submit (no
//    `allow-forms`, `form-action 'none'`), scripts reach no server (`connect-src 'none'`), nothing
//    loads from anywhere but the page's own files and `data:` / `blob:` (`default-src 'none'`,
//    each source limited to `<origin>/p/<slug>/`), no frames, no `<base>`. A link out (`<a href>`)
//    still opens with a click: that is intended, a page may point at other sites. A banner the
//    server puts at the top of every page says members made it with her help, it is not an
//    official site, and never to type a password there.
// 3. Who can open it: the scopes links have (`person`, `space`, after the login), and anyone only
//    while `[modules.api.files] pages_public` is on.
// 4. Space and hosting: a page counts toward the person's links of the day, has a size cap and an
//    expiry, and ends at once when it is taken back.
// 5. Search engines: `X-Robots-Tag: noindex, nofollow`.
//
// What a hostile page can still do is in docs/design/v6-agent.md (「她能發網頁」).

import { activeText } from "@miyoria/gate/actions";
import {
  type Artifact,
  ArtifactBlobMissingError,
  type ArtifactCleaner,
  ArtifactShareError,
  type ArtifactStore,
  type FilePages,
  PAGE_MAX_ASSETS,
  type PagePublishRefusal,
  type PagePublishRequest,
  type PagePublishResult,
  pageAssetPath,
} from "@miyoria/store";
import type { ModerationService } from "@miyoria/types";
import type { FilesConfig } from "./config.js";
import { handedToday, textBlocked } from "./links.js";

const DAY_MS = 86_400_000;
const KIB = 1024;

/** The sandbox of every page: scripts, popups, dialogs and pointer lock; nothing else. */
export const PAGE_SANDBOX = "sandbox allow-scripts allow-popups allow-modals allow-pointer-lock";

/**
 * The CSP of a page and its files: `base` is the page's own folder, `<origin>/p/<slug>/`, the only
 * place anything loads from. `<a href>` links out still work with a click (intended).
 */
export function pageCsp(base: string): string {
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${base}`,
    `style-src 'unsafe-inline' ${base}`,
    `img-src ${base} data: blob:`,
    `media-src ${base} data: blob:`,
    `font-src ${base} data:`,
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    PAGE_SANDBOX,
  ].join("; ");
}

/** Headers every answer under `/p/` carries besides its CSP. */
export const PAGE_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-site",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "x-robots-tag": "noindex, nofollow",
  "x-frame-options": "DENY",
};

/** What a file of a page is served as: a page (with the banner), or bytes of a type. */
export type PageFileType = { page: true } | { page: false; type: string; text: boolean };

/** The types a text file of a page is served as, by the extension of its path. */
const TEXT_TYPES: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
};

const extensionOf = (path: string) => (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? "").toLowerCase();

/** Whether a stored text is a web page: named `.html` / `.htm`, or HTML by its content. */
export function isHtml(filename: string, text: string): boolean {
  const ext = extensionOf(filename);
  return ext === "html" || ext === "htm" || activeText(text) === "HTML";
}

/**
 * How a file of a page at `path` is served, or `null` when a page may not load it: pictures,
 * sound and video as stored; text as a page (`.html`), a style, a script, JSON or plain text by
 * its extension. PDFs, archives, Office files and SVG files are not served as part of a page.
 */
export function pageFileType(artifact: Artifact, path: string): PageFileType | null {
  if (artifact.kind === "image" || artifact.kind === "audio" || artifact.kind === "video") {
    return { page: false, type: artifact.mime, text: false };
  }
  if (artifact.kind !== "text" || artifact.mime !== "text/plain") return null;
  const ext = extensionOf(path);
  if (ext === "html" || ext === "htm") return { page: true };
  const type = TEXT_TYPES[ext];
  return type === undefined ? null : { page: false, type, text: true };
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );

/** The banner's words, in zh-TW and English. */
export function bannerText(name: string): string {
  return (
    `這個網頁是成員請 ${name} 幫忙做的,不是官方網站。不要在這裡輸入任何密碼。` +
    ` / This page was made by members with ${name}'s help. It is not an official site. Never enter passwords here.`
  );
}

const BANNER_BOX =
  "all:initial!important;display:block!important;box-sizing:border-box!important;" +
  "margin:0!important;padding:4px 8px!important;font:12px/1.5 system-ui,sans-serif!important;" +
  "text-align:center!important;opacity:1!important;visibility:visible!important;";

/**
 * Text in which a `<body>` is not a tag, scanned left to right so whichever starts first wins:
 * a comment; a raw-text, RCDATA or inert element (script, style, title, textarea, ...; template
 * and noscript would hide the banner) up to its end tag or, unclosed, the end of the page; and
 * any other tag, whose quoted attribute values are masked by the caller. Every branch runs to
 * the end of the page when unclosed, so each `<` is tried once and the scan stays linear.
 */
const HIDDEN_FROM_TAGS =
  /<!--[\s\S]*?(?:-->|$)|<(script|style|title|textarea|xmp|iframe|noembed|noframes|noscript|template|plaintext)\b(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^'">])*(?:>|$)[\s\S]*?(?:<\/\1\s*>|$)|<[a-z][^\s/>]*(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^'">])*(?:>|$)/gi;
const QUOTED = /"[^"]*(?:"|$)|'[^']*(?:'|$)/g;

/**
 * `html` with the banner as the first child of its body: a fixed bar (inline styles marked
 * important, a random id) and an invisible copy in the flow that keeps the page's own top clear.
 * A page's stylesheet cannot hide it in the trivial case; a page that means to (a script, an
 * element drawn over it) can, which the banner does not pretend to stop.
 */
export function withBanner(html: string, name: string, id: string): string {
  const words = escapeHtml(bannerText(name));
  const banner =
    `<div id="${id}" role="note" lang="zh-Hant" style="${BANNER_BOX}position:fixed!important;` +
    "top:0!important;left:0!important;right:0!important;z-index:2147483647!important;" +
    "background:#1d1d1f!important;color:#f5f5f7!important;border-bottom:1px solid #444!important;" +
    `pointer-events:none!important;">${words}</div>` +
    `<div id="${id}-gap" aria-hidden="true" style="${BANNER_BOX}visibility:hidden!important;">${words}</div>`;
  // Where the body starts, not counting what the parser never reads as tags (lengths kept).
  const masked = html.replace(HIDDEN_FROM_TAGS, (m, rawText: string | undefined) =>
    rawText === undefined && !m.startsWith("<!--")
      ? m.replace(QUOTED, (q) => " ".repeat(q.length))
      : " ".repeat(m.length),
  );
  const after = (re: RegExp): number | null => {
    const m = re.exec(masked);
    return m === null ? null : m.index + m[0].length;
  };
  const at =
    after(/<body\b[^>]*>/i) ??
    after(/<\/head\s*>/i) ??
    after(/<html\b[^>]*>/i) ??
    after(/<!doctype\b[^>]*>/i) ??
    0;
  return `${html.slice(0, at)}${banner}${html.slice(at)}`;
}

export interface PageServiceOptions {
  store: () => ArtifactStore | undefined;
  cleaner: ArtifactCleaner;
  /** The file origin, `https://files.example.com`. */
  origin: string;
  /** Whether pages for one person or a server's members can be opened (the Discord login). */
  scoped: () => boolean;
  config: () => FilesConfig;
  moderation: () => ModerationService | undefined;
  now: () => number;
}

const refuse = (
  refused: PagePublishRefusal,
  message: string,
  path?: string,
): PagePublishResult => ({
  ok: false,
  refused,
  message,
  ...(path === undefined ? {} : { path }),
});

/** Which file of the page, in her words. */
const where = (path: string | null) => (path === null ? "網頁本身" : `網頁裡的 ${path} `);

/** Why a text may not go out, as a page refusal; `null`: it may. */
function screen(
  text: string,
  moderation: ModerationService | undefined,
  path: string | null,
): PagePublishResult | null {
  const rule = textBlocked(text, moderation);
  if (rule === null) return null;
  return rule.startsWith("secrets.")
    ? refuse(
        "secret",
        `${where(path)}有看起來像密碼或密鑰的內容,不能發。先把那段拿掉再重新匯出。`,
        path ?? undefined,
      )
    : refuse("secret", `${where(path)}沒有通過輸出檢查,不能發。`, path ?? undefined);
}

const NOT_HTML =
  "網頁本身要是 HTML(.html 檔)。先把網頁寫成 .html,用 workspace_export 匯出,再用它的 id。";
const AUDIENCE =
  "這個網頁不能給這麼多人看:私訊裡做的只給對方本人,頻道裡做的最多給那個伺服器的成員,有網址的人都能看只限他自己的東西。";

/** A stored text, or `null` when its bytes are gone. */
async function readText(
  store: ArtifactStore,
  artifact: Artifact,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    return new TextDecoder("utf-8").decode(await store.readContent(artifact, signal));
  } catch (error) {
    if (error instanceof ArtifactBlobMissingError) return null;
    throw error;
  }
}

/** Publishes pages on one file origin. */
export class PageService implements FilePages {
  readonly #o: PageServiceOptions;

  constructor(options: PageServiceOptions) {
    this.#o = options;
  }

  available(audience: PagePublishRequest["audience"]): boolean {
    return audience === "link" ? this.#o.config().pages_public : this.#o.scoped();
  }

  urlOf(slug: string): string {
    return `${this.#o.origin}/p/${slug}/`;
  }

  async publish(request: PagePublishRequest, signal?: AbortSignal): Promise<PagePublishResult> {
    const store = this.#o.store();
    if (store === undefined) return refuse("unavailable", "現在沒有產物庫,發不了網頁。");
    const config = this.#o.config();
    if (request.audience === "link" && !config.pages_public) {
      return refuse(
        "not_public",
        "主人沒有開放「有網址的人都打得開」的網頁,所以只能給對方本人,或這個伺服器的成員登入後看。",
      );
    }
    if (!this.available(request.audience)) {
      return refuse(
        "no_login",
        "網站沒有開 Discord 登入,只給特定的人看的網頁沒人打得開,所以沒有發。",
      );
    }
    if (request.assets.length > PAGE_MAX_ASSETS) {
      return refuse("too_large", `一個網頁最多放 ${PAGE_MAX_ASSETS} 個檔案。`);
    }
    const moderation = this.#o.moderation();
    const main = store.get(request.artifact_id);
    if (main === null || !store.isLive(main)) {
      return refuse("not_found", "網頁本身的產物不在了(過期、刪除或被下架)。");
    }
    if (main.source === "sing" || !main.downloadable) {
      return refuse("song_cover", "翻唱的成品不開放下載,不能當網頁。");
    }
    if (main.kind !== "text" || main.mime !== "text/plain") {
      return refuse("not_html", NOT_HTML);
    }
    if (main.size > config.page_max_kb * KIB) {
      return refuse("too_large", `網頁本身超過 ${config.page_max_kb} KiB,太大了發不了。`);
    }
    const html = await readText(store, main, signal);
    if (html === null) return refuse("not_found", "網頁本身的內容已經不在了。");
    if (!isHtml(main.filename, html)) return refuse("not_html", NOT_HTML);
    const blocked = screen(html, moderation, null);
    if (blocked !== null) return blocked;
    let total = main.size;
    const assets: { path: string; artifact_id: string }[] = [];
    const paths = new Set<string>();
    for (const asset of request.assets) {
      const path = pageAssetPath(asset.path);
      if (path === null || paths.has(path)) {
        return refuse(
          "asset_path",
          `${asset.path} 不能當檔案路徑:要是 style.css、img/cat.png 這種相對路徑,不能有 ..、不能以點開頭,也不能重複。`,
          asset.path,
        );
      }
      paths.add(path);
      const artifact = store.get(asset.artifact_id);
      if (artifact === null || !store.isLive(artifact)) {
        return refuse("not_found", `${where(path)}的產物不在了(過期、刪除或被下架)。`, path);
      }
      if (artifact.source === "sing" || !artifact.downloadable) {
        return refuse("song_cover", "翻唱的成品不開放下載,不能放進網頁。", path);
      }
      const type = pageFileType(artifact, path);
      if (type === null) {
        return refuse(
          "type_not_allowed",
          `${where(path)}這種檔案網頁不能放:可以放 .html、.css、.js、.json、.txt、.md、.csv、圖片、音訊和影片(字型請用 data: 寫進 CSS)。`,
          path,
        );
      }
      if (type.page || type.text) {
        const text = await readText(store, artifact, signal);
        if (text === null) return refuse("not_found", `${where(path)}的內容已經不在了。`, path);
        const stopped = screen(text, moderation, path);
        if (stopped !== null) return stopped;
      } else if (artifact.kind === "image") {
        try {
          await this.#o.cleaner.handOut(artifact, signal);
        } catch {
          return refuse(
            "type_not_allowed",
            `${where(path)}這張圖沒辦法清掉藏在檔案裡的資料,所以不能放。`,
            path,
          );
        }
      }
      total += artifact.size;
      assets.push({ path, artifact_id: artifact.id });
    }
    if (total > config.page_total_max_kb * KIB) {
      return refuse(
        "too_large",
        `網頁和它用到的檔案合計超過 ${config.page_total_max_kb} KiB,太大了發不了。`,
      );
    }
    const person = request.requested_by;
    if (
      person !== null &&
      handedToday(store, person, this.#o.now()) >= config.links_per_person_per_day
    ) {
      return refuse("quota", "今天給這個人的連結和網頁已經到上限了,明天再發。");
    }
    const days = Math.min(
      Math.max(1, Math.floor(request.days ?? config.page_days)),
      config.page_max_days,
    );
    const ttlMs = days * DAY_MS;
    let page: ReturnType<ArtifactStore["pages"]["create"]>;
    try {
      page = store.pages.create({
        artifact_id: main.id,
        assets,
        audience: request.audience,
        person_id: request.person_id ?? null,
        space_id: request.space_id ?? null,
        made_for: person,
        size: total,
        ttlMs,
        widen: request.widen === true,
      });
    } catch (error) {
      if (error instanceof ArtifactShareError) return refuse("audience", AUDIENCE);
      throw error;
    }
    // The files stay as long as the page does.
    const until = Date.parse(page.expires_at);
    for (const id of [main.id, ...assets.map((a) => a.artifact_id)]) store.extend(id, until);
    return {
      ok: true,
      url: this.urlOf(page.slug),
      page_id: page.id,
      audience: page.audience,
      expires_at: page.expires_at,
      size: total,
    };
  }
}
