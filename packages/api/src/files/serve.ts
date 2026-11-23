// The file origin (v5-architecture §11.2): a listener of its own on a host of its own, serving only
// what a share link or a member's ticket opens, and nothing else: no panel, no API, no cookies.
//
// * `GET|HEAD /f/<token>`: a share link. Anyone with it, for a link anyone may open; for one person
//   or a server's members, the browser is first sent to the member site
//   (`/api/member/files/pass/<token>`), which checks the login and sends it back with a ticket
//   (`?k=`). The ticket is for this share only and lives two minutes; the person it names is
//   checked against the share again here.
// * `GET|HEAD /d/<artifact id>?k=<ticket>`: one of the member's own items, from the member page.
// * `GET|HEAD /p/<slug>/<path>`: a web page (`page_publish`) and the files it loads, rendered, with
//   the page CSP and banner of `pages.ts`. A page for one person or a server's members sends the
//   browser to the member site first (`/api/member/files/page/<slug>`), which sends it back to
//   `/p/<slug>/~<ticket>/`: the ticket rides in the path, so the page's relative files carry it.
// * `GET /robots.txt`: nothing here is for indexing.
//
// Only `/p/` ever answers `text/html`; a file of a link is never rendered.
//
// Every answer carries `X-Content-Type-Options: nosniff`, a CSP that runs nothing
// (`default-src 'none'` with `sandbox`), `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`
// and `X-Robots-Tag: noindex`; no answer ever sets a cookie, and no request's cookies are read.
// A file has its stored type (sniffed from its bytes when it came in) and a `Content-Disposition`
// with the cleaned name: `attachment` for a PDF, for `?dl=1` and for a member's own download,
// else `inline`. A file that runs when opened (`runsWhenOpened`: .bat, .html, .sh, ...) is named
// with `.txt` added, unless only its own person can open the link (a member's own download, or a
// link for that one person). Song covers are never served. A text passes the secret check again, an image is
// served as its cleaned copy. A link anyone may open may be kept by a CDN for a few minutes; every
// other answer is `no-store`. Each address and each link have a rate limit. A use is counted once
// per request that starts at the first byte (a video's later ranges are not new uses).

import { randomBytes } from "node:crypto";
import type { ZipLimits } from "@miyoria/gate/actions";
import {
  type ArtifactCleaner,
  type ArtifactStore,
  outgoingFilename,
  type Artifact as StoredArtifact,
} from "@miyoria/store";
import type { ModerationService, PersonId } from "@miyoria/types";
import { Hono } from "hono";
import { byteRange } from "../panel.js";
import { clientKey, RateWindow } from "../public.js";
import type { ApiEnv } from "../state.js";
import { contentRefusal, textBlocked } from "./links.js";
import { PAGE_HEADERS, pageCsp, pageFileType, withBanner } from "./pages.js";
import type { Tickets } from "./tickets.js";

const MINUTE_MS = 60_000;

/** The CSP of every answer: nothing runs, nothing loads but the file itself. */
export const FILE_CSP =
  "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";

/** Headers every answer of the file origin carries. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "content-security-policy": FILE_CSP,
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "cross-origin-opener-policy": "same-origin",
};

export interface FileOriginOptions {
  store: () => ArtifactStore | undefined;
  cleaner: ArtifactCleaner;
  tickets: Tickets;
  /** The member site's origin, where a scoped link sends its visitor to log in; `null`: none. */
  site: () => string | null;
  /** Whether `person` is a member of `space` (`isSpaceMember`). */
  isMember: (person: PersonId, space: string) => boolean;
  moderation: () => ModerationService | undefined;
  now: () => number;
  perIpPerMinute: number;
  perLinkPerMinute: number;
  /** `max-age` of a file of a link anyone may open; 0: `no-store`. */
  publicCacheSecs: number;
  /** The header the proxy on this machine names the visitor in (`client_ip_header`). */
  clientIpHeader: string;
  /** The zip limits `share` applies (`[modules.actions.share]`); default: its defaults. */
  zip?: () => ZipLimits | undefined;
  /** The file origin as the browser sees it, for a page's CSP; without it no page is served. */
  origin?: string;
  /** Her name, for a page's banner. */
  name?: () => string;
}

/** A plain-text page (an error, a refusal), with the security headers and no cache. */
function page(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(`${text}\n`, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

const NOT_FOUND = () => page(404, "這個連結打不開:可能已經過期、被收回,或是網址不完整。");

/** `Content-Disposition` for `filename` (already cleaned by the store): an ASCII name and UTF-8. */
export function disposition(kind: "inline" | "attachment", filename: string): string {
  const name = filename.replace(/[\r\n"\\]/g, "_");
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/[;%]/g, "_") || "file";
  const utf8 = encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** The `Content-Type` an artifact is sent as. */
function contentType(mime: string): string {
  return mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime;
}

interface Serving {
  artifact: StoredArtifact;
  download: boolean;
  cache: string;
  /** Only the artifact's own person can open this (a file that runs keeps its name). */
  private: boolean;
}

/** The first bytes of a text (for an interpreter line); `null` for anything else. */
async function headOf(store: ArtifactStore, artifact: StoredArtifact): Promise<Uint8Array | null> {
  if (artifact.kind !== "text") return null;
  try {
    return (await store.readContent(artifact)).subarray(0, 4);
  } catch {
    return null;
  }
}

/** The file origin's app. */
export function fileOriginApp(options: FileOriginOptions): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const perIp = new RateWindow(options.perIpPerMinute, MINUTE_MS);
  const perLink = new RateWindow(options.perLinkPerMinute, MINUTE_MS);

  /** The bytes of `serving`, or a refusal; images cleaned, text checked, song covers never. */
  const send = async (request: Request, serving: Serving, count: () => boolean) => {
    const store = options.store();
    if (store === undefined) return page(503, "現在拿不到檔案,晚點再試。");
    let artifact = serving.artifact;
    if (artifact.source === "sing" || !artifact.downloadable) {
      return page(403, "翻唱的成品不開放下載,只在語音和直播裡聽。");
    }
    // Who may open it was checked when the link was made; the zip is read again all the same.
    const zip = options.zip?.();
    const refusal = await contentRefusal(store, artifact, options.moderation(), {
      owner: true,
      ...(zip === undefined ? {} : { zip }),
    });
    if (refusal !== null) return page(403, "這個檔案不能從這裡送出。");
    try {
      artifact = (await options.cleaner.handOut(artifact)).artifact;
    } catch {
      return page(403, "這個檔案不能從這裡送出。");
    }
    const size = artifact.size;
    const head = request.method === "HEAD";
    const range = head ? null : byteRange(request.headers.get("range"), size);
    if (range === "unsatisfiable") {
      return page(416, "要求的範圍不在檔案裡。", { "content-range": `bytes */${size}` });
    }
    // A use is a request from the first byte; the rest of a video's ranges are the same use.
    if (!head && (range === null || range[0] === 0) && !count()) return NOT_FOUND();
    const download = serving.download || artifact.mime === "application/pdf";
    const headers = new Headers({
      ...SECURITY_HEADERS,
      "content-type": contentType(artifact.mime),
      "content-disposition": disposition(
        download ? "attachment" : "inline",
        outgoingFilename(artifact.filename, await headOf(store, artifact), serving.private),
      ),
      "cache-control": serving.cache,
      "accept-ranges": "bytes",
      etag: `"${artifact.sha256}"`,
    });
    if (head) {
      headers.set("content-length", String(size));
      return new Response(null, { status: 200, headers });
    }
    let stream: ReadableStream;
    try {
      const node = await store.openContent(
        artifact,
        range === null ? undefined : { start: range[0], end: range[1] },
      );
      stream = ReadableStream.from(node) as ReadableStream;
    } catch {
      return page(410, "這個檔案的內容已經不在了。");
    }
    if (range === null) {
      headers.set("content-length", String(size));
      return new Response(stream, { status: 200, headers });
    }
    headers.set("content-length", String(range[1] - range[0] + 1));
    headers.set("content-range", `bytes ${range[0]}-${range[1]}/${size}`);
    return new Response(stream, { status: 206, headers });
  };

  app.use("*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return page(405, "這裡只能下載檔案。", { allow: "GET, HEAD" });
    }
    const wait = perIp.hit(clientKey(c, options.clientIpHeader), options.now());
    if (wait !== null) {
      return page(429, "太多次了,等一下再試。", { "retry-after": String(Math.ceil(wait / 1000)) });
    }
    await next();
    // Nothing on this origin ever sets a cookie.
    c.res.headers.delete("set-cookie");
    return undefined;
  });

  app.get(
    "/robots.txt",
    () =>
      new Response("User-agent: *\nDisallow: /\n", {
        headers: { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" },
      }),
  );

  app.get("/f/:token", async (c) => {
    const store = options.store();
    if (store === undefined) return page(503, "現在拿不到檔案,晚點再試。");
    const token = c.req.param("token");
    const found = store.shares.lookup(token);
    if (!found.ok) return NOT_FOUND();
    const { share, artifact } = found;
    // A song cover is refused before anyone is asked to log in for it.
    if (artifact.source === "sing" || !artifact.downloadable) {
      return page(403, "翻唱的成品不開放下載,只在語音和直播裡聽。");
    }
    if (perLink.hit(share.id, options.now()) !== null) {
      return page(429, "這個連結現在太多人在開,等一下再試。", { "retry-after": "60" });
    }
    if (share.audience !== "link") {
      const person = options.tickets.verify(c.req.query("k"), "s", share.id);
      if (person === null) {
        const site = options.site();
        if (site === null)
          return page(403, "這個連結只給特定的人,要登入才能打開,但這裡沒有開登入。");
        return new Response(null, {
          status: 302,
          headers: {
            ...SECURITY_HEADERS,
            location: `${site}/api/member/files/pass/${encodeURIComponent(token)}`,
            "cache-control": "no-store",
          },
        });
      }
      const allowed =
        share.audience === "person"
          ? share.person_id === person
          : share.space_id !== null && options.isMember(person, share.space_id);
      if (!allowed) return page(403, "這個檔案不是給你的。");
    }
    const cache =
      share.audience === "link" && options.publicCacheSecs > 0
        ? `public, max-age=${options.publicCacheSecs}`
        : "private, no-store";
    return send(
      c.req.raw,
      {
        artifact,
        download: share.mode === "download" && c.req.query("dl") === "1",
        cache,
        private: share.audience === "person",
      },
      () => store.shares.use(token).ok,
    );
  });

  app.get("/d/:id", async (c) => {
    const store = options.store();
    if (store === undefined) return page(503, "現在拿不到檔案,晚點再試。");
    const id = c.req.param("id");
    const person = options.tickets.verify(c.req.query("k"), "d", id);
    if (person === null) return NOT_FOUND();
    const artifact = store.get(id);
    if (artifact === null || artifact.made_for !== person || !store.isLive(artifact)) {
      return NOT_FOUND();
    }
    return send(
      c.req.raw,
      { artifact, download: true, cache: "private, no-store", private: true },
      () => true,
    );
  });

  app.get("/p/*", (c) => servePage(c.req.raw, options, perLink));

  app.notFound(() => NOT_FOUND());
  app.onError(() => page(500, "出了點問題,晚點再試。"));
  return app;
}

// ---- pages -------------------------------------------------------------------------------------

/** A refusal under `/p/`: plain text, with the page headers. */
function pageText(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(`${text}\n`, {
    status,
    headers: {
      ...PAGE_HEADERS,
      "content-security-policy": FILE_CSP,
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

const PAGE_GONE = () => pageText(404, "這個網頁打不開:可能已經過期、被收回,或是網址不完整。");

/** `GET|HEAD /p/<slug>/[~<ticket>/]<path>`: a page, or one of its files. */
async function servePage(
  request: Request,
  options: FileOriginOptions,
  perLink: RateWindow,
): Promise<Response> {
  const store = options.store();
  const origin = options.origin;
  if (store === undefined || origin === undefined) return PAGE_GONE();
  const parts = new URL(request.url).pathname.slice("/p/".length).split("/");
  const slug = parts[0] ?? "";
  const found = store.pages.bySlug(slug);
  if (!found.ok) return PAGE_GONE();
  const { page } = found;
  // The page's own folder: relative paths resolve under it.
  if (parts.length === 1) {
    return pageText(301, "", { location: `/p/${slug}/` });
  }
  if (perLink.hit(`page:${page.id}`, options.now()) !== null) {
    return pageText(429, "這個網頁現在太多人在開,等一下再試。", { "retry-after": "60" });
  }
  let rest = parts.slice(1);
  const ticket = rest[0]?.startsWith("~") === true ? rest[0].slice(1) : null;
  if (ticket !== null) rest = rest.slice(1);
  if (page.audience !== "link") {
    const person = ticket === null ? null : options.tickets.verify(ticket, "p", page.id);
    if (person === null) {
      const site = options.site();
      if (site === null) {
        return pageText(403, "這個網頁只給特定的人,要登入才能打開,但這裡沒有開登入。");
      }
      return pageText(302, "", {
        location: `${site}/api/member/files/page/${encodeURIComponent(slug)}`,
      });
    }
    const allowed =
      page.audience === "person"
        ? page.person_id === person
        : page.space_id !== null && options.isMember(person, page.space_id);
    if (!allowed) return pageText(403, "這個網頁不是給你看的。");
  }
  let path: string;
  try {
    path = rest.map((p) => decodeURIComponent(p)).join("/");
  } catch {
    return PAGE_GONE();
  }
  let artifact = path === "" ? found.artifact : store.pages.asset(page.id, path);
  if (artifact === null && path === "index.html") artifact = found.artifact;
  if (artifact === null) return PAGE_GONE();
  const type =
    artifact.id === found.artifact.id ? ({ page: true } as const) : pageFileType(artifact, path);
  if (type === null) return PAGE_GONE();
  const base = `${origin}/p/${slug}/`;
  // Never kept by a CDN: a page taken back is gone at once.
  const cache = page.audience === "link" ? "no-store" : "private, no-store";
  const headers = new Headers({
    ...PAGE_HEADERS,
    "content-security-policy": pageCsp(base),
    "cache-control": cache,
  });
  const head = request.method === "HEAD";
  if (type.page || type.text) {
    let text: string;
    try {
      text = new TextDecoder("utf-8").decode(await store.readContent(artifact));
    } catch {
      return pageText(410, "這個網頁的內容已經不在了。");
    }
    // Checked again as it goes out, like every text of the file origin.
    if (textBlocked(text, options.moderation()) !== null) {
      return pageText(403, "這個網頁不能從這裡送出。");
    }
    let body: Uint8Array;
    if (type.page) {
      const name = options.name?.() ?? "她";
      const id = `m${randomBytes(8).toString("hex")}`;
      body = new TextEncoder().encode(withBanner(text, name, id));
      headers.set("content-type", "text/html; charset=utf-8");
    } else {
      body = new TextEncoder().encode(text);
      headers.set("content-type", type.type);
    }
    headers.set("content-length", String(body.byteLength));
    return new Response(head ? null : (body as Uint8Array<ArrayBuffer>), { status: 200, headers });
  }
  try {
    artifact = (await options.cleaner.handOut(artifact)).artifact;
  } catch {
    return pageText(403, "這個檔案不能從這裡送出。");
  }
  const size = artifact.size;
  const range = head ? null : byteRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return pageText(416, "要求的範圍不在檔案裡。", { "content-range": `bytes */${size}` });
  }
  headers.set("content-type", type.type);
  headers.set("accept-ranges", "bytes");
  if (head) {
    headers.set("content-length", String(size));
    return new Response(null, { status: 200, headers });
  }
  let stream: ReadableStream;
  try {
    const node = await store.openContent(
      artifact,
      range === null ? undefined : { start: range[0], end: range[1] },
    );
    stream = ReadableStream.from(node) as ReadableStream;
  } catch {
    return pageText(410, "這個檔案的內容已經不在了。");
  }
  if (range === null) {
    headers.set("content-length", String(size));
    return new Response(stream, { status: 200, headers });
  }
  headers.set("content-length", String(range[1] - range[0] + 1));
  headers.set("content-range", `bytes ${range[0]}-${range[1]}/${size}`);
  return new Response(stream, { status: 206, headers });
}
