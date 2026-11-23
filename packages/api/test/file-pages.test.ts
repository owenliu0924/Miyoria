// Web pages on the file origin (`page_publish`): what may be published, the headers every page and
// its files carry, the banner, who can open a page, its expiry, taking it back, size caps, the
// secret check, the shared daily quota, and that only `/p/` ever answers `text/html`. In memory: the
// file origin is a Hono app called directly, nothing listens.

import { ArtifactStoreKey, PeopleStoreKey } from "@miyoria/store";
import type { AccountRef, PersonId } from "@miyoria/types";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImageCleaner } from "../src/files/clean.js";
import { type FilesConfig, FilesConfigSchema } from "../src/files/config.js";
import { FileLinkService } from "../src/files/links.js";
import { bannerText, PAGE_SANDBOX, PageService, pageCsp, withBanner } from "../src/files/pages.js";
import { filesPagePassRoute } from "../src/files/routes.js";
import { fileOriginApp } from "../src/files/serve.js";
import type { FilesSide } from "../src/files/side.js";
import { PAGE_TICKET_TTL_MS, Tickets } from "../src/files/tickets.js";
import type { ApiEnv } from "../src/state.js";
import {
  ACCOUNTS,
  contains,
  DAY,
  type FilesFixture,
  filesFixture,
  HIDDEN,
  pngWithTrailer,
  T0,
} from "./support/files.js";

const ORIGIN = "https://files.miyoria.test";
const SITE = "https://miyoria.test";
const NAME = "Miyoria";
const KEY = `sk-ant-api03-${"a".repeat(90)}`;

let f: FilesFixture;
beforeEach(() => {
  f = filesFixture();
});
afterEach(() => {
  f.close();
});

function rig(options: { scoped?: boolean; config?: Partial<FilesConfig> } = {}) {
  const config = FilesConfigSchema.parse({ origin: ORIGIN, ...options.config });
  const cleaner = new ImageCleaner(() => f.store);
  const tickets = new Tickets(() => f.clock.now());
  const scoped = () => options.scoped ?? true;
  const pages = new PageService({
    store: () => f.store,
    cleaner,
    origin: ORIGIN,
    scoped,
    config: () => config,
    moderation: () => undefined,
    now: () => f.clock.now(),
  });
  const links = new FileLinkService({
    store: () => f.store,
    cleaner,
    origin: ORIGIN,
    scoped,
    perPersonPerDay: config.links_per_person_per_day,
    moderation: () => undefined,
    now: () => f.clock.now(),
  });
  const app = fileOriginApp({
    store: () => f.store,
    cleaner,
    tickets,
    site: () => SITE,
    isMember: (p, s) => f.store.shares.isMember(p, s),
    moderation: () => undefined,
    now: () => f.clock.now(),
    perIpPerMinute: 1000,
    perLinkPerMinute: 1000,
    publicCacheSecs: 300,
    clientIpHeader: "cf-connecting-ip",
    origin: ORIGIN,
    name: () => NAME,
  });
  const files: FilesSide = { config, origin: ORIGIN, site: SITE, tickets, links, pages, cleaner };
  return { pages, links, app, tickets, files };
}

async function get(app: Hono<ApiEnv>, path: string, init?: RequestInit): Promise<Response> {
  const res = await app.request(`${ORIGIN}${path}`, init);
  const body = res.body === null ? null : await res.arrayBuffer();
  return new Response(body, { status: res.status, headers: res.headers });
}

const PAGE = `<!doctype html>
<html><head><title>t</title><link rel="stylesheet" href="style.css"></head>
<!-- <body class="decoy"> -->
<body class="real"><h1>她做的網頁</h1><img src="img/cat.png"><script src="app.js"></script></body></html>`;

async function text(
  body: string,
  filename: string,
  place = f.room,
  made_for: PersonId | null = f.person,
) {
  return f.store.ingest(new TextEncoder().encode(body), {
    source: "sandbox",
    plugin: "sandbox",
    filename,
    place,
    made_for,
  });
}

/** Publishes `PAGE` with a style, a script and a picture, for the person, after a check. */
async function site(pages: PageService, extra: object = {}) {
  const html = await text(PAGE, "index.html");
  const css = await text("h1 { color: teal; }\n", "style.css");
  const js = await text("document.title = 'x';\n", "app.js");
  const png = await f.store.ingest(await pngWithTrailer(), {
    source: "sandbox",
    plugin: "sandbox",
    filename: "cat.png",
    place: f.room,
    made_for: f.person,
  });
  const result = await pages.publish({
    artifact_id: html.id,
    assets: [
      { path: "style.css", artifact_id: css.id },
      { path: "app.js", artifact_id: js.id },
      { path: "img/cat.png", artifact_id: png.id },
    ],
    audience: "person",
    person_id: f.person,
    requested_by: f.person,
    ...extra,
  });
  if (!result.ok) throw new Error(result.message);
  return { result, html, css, js, png, slug: result.url.slice(`${ORIGIN}/p/`.length, -1) };
}

/** The path of a page for `person`, with the ticket the member site would hand them. */
function ticketPath(tickets: Tickets, pageId: string, slug: string, person: PersonId): string {
  return `/p/${slug}/~${tickets.issue("p", pageId, person)}/`;
}

describe("a published page", () => {
  it("renders as HTML with every header, and the banner first in its body", async () => {
    const { pages, app, tickets } = rig();
    const { result, slug } = await site(pages);
    expect(result.url).toMatch(/^https:\/\/files\.miyoria\.test\/p\/[A-Za-z0-9_-]{22}\/$/);
    const bare = await get(app, `/p/${slug}`);
    expect(bare.status).toBe(301);
    expect(bare.headers.get("location")).toBe(`/p/${slug}/`);
    const path = ticketPath(tickets, result.page_id, slug, f.person);
    const res = await get(app, path, { headers: { cookie: "miyoria_session=abc" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const base = `${ORIGIN}/p/${slug}/`;
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toBe(pageCsp(base));
    expect(csp).toContain("sandbox allow-scripts allow-popups allow-modals allow-pointer-lock");
    expect(PAGE_SANDBOX).toBe("sandbox allow-scripts allow-popups allow-modals allow-pointer-lock");
    for (const never of ["allow-same-origin", "allow-forms", "allow-top-navigation"]) {
      expect(csp).not.toContain(never);
    }
    for (const part of [
      "default-src 'none'",
      `script-src 'unsafe-inline' ${base}`,
      `img-src ${base} data: blob:`,
      `media-src ${base} data: blob:`,
      `font-src ${base} data:`,
      "connect-src 'none'",
      "form-action 'none'",
      "frame-src 'none'",
      "base-uri 'none'",
    ]) {
      expect(csp.split("; ")).toContain(part);
    }
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-site");
    expect(res.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.text();
    const banner = /<body class="real">(<div id="(m[0-9a-f]{16})" role="note"[^>]*>)/.exec(body);
    expect(banner).not.toBeNull();
    expect(body).toContain(bannerText(NAME).replace(/'/g, "&#39;"));
    expect(body).toContain("不要在這裡輸入任何密碼");
    expect(body).toContain("Never enter passwords here");
    expect(body).toContain('<!-- <body class="decoy"> -->');
    const again = await (await get(app, path)).text();
    const id = /id="(m[0-9a-f]{16})"/.exec(again)?.[1];
    expect(id).toBeDefined();
    expect(id).not.toBe(banner?.[2]);
    // `index.html` is the page too.
    expect((await get(app, `${path}index.html`)).headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
  });

  it("serves its files by relative path, typed, with the same headers, images cleaned", async () => {
    const { pages, app, tickets } = rig();
    const { result, slug } = await site(pages);
    const path = ticketPath(tickets, result.page_id, slug, f.person);
    const css = await get(app, `${path}style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("content-security-policy")).toBe(pageCsp(`${ORIGIN}/p/${slug}/`));
    expect(css.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const js = await get(app, `${path}app.js`);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const png = await get(app, `${path}img/cat.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(contains(new Uint8Array(await png.arrayBuffer()), HIDDEN)).toBe(false);
    expect((await get(app, `${path}missing.css`)).status).toBe(404);
    expect((await get(app, `${path}..%2Fstyle.css`)).status).toBe(404);
    expect((await get(app, `${path}img/../style.css`)).status).not.toBe(500);
  });

  it("is the only answer of the file origin that is ever text/html", async () => {
    const { pages, app, links, tickets } = rig();
    const { html, css } = await site(pages);
    // A link of the same HTML is refused, and a share made around that refusal is never rendered.
    expect(
      await links.issue({ artifact_id: html.id, audience: "person", person_id: f.person }),
    ).toMatchObject({ ok: false, refused: "type_not_allowed" });
    const { share, token } = f.store.shares.create(html.id, {
      audience: "person",
      person_id: f.person,
    });
    const k = encodeURIComponent(tickets.issue("s", share.id, f.person));
    const link = await get(app, `/f/${token}?k=${k}`);
    expect(link.headers.get("content-type")).not.toContain("text/html");
    const d = encodeURIComponent(tickets.issue("d", html.id, f.person));
    const own = await get(app, `/d/${html.id}?k=${d}`);
    expect(own.headers.get("content-type")).not.toContain("text/html");
    const cssLink = await links.issue({
      artifact_id: css.id,
      audience: "person",
      person_id: f.person,
    });
    if (!cssLink.ok) throw new Error(cssLink.message);
    const ck = encodeURIComponent(tickets.issue("s", cssLink.share_id, f.person));
    const cssRes = await get(app, `/f/${cssLink.url.slice(`${ORIGIN}/f/`.length)}?k=${ck}`);
    expect(cssRes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });
});

describe("what a page may be", () => {
  it("refuses a page that is not HTML, and files a page cannot load", async () => {
    const { pages } = rig();
    const note = await text("just words\n", "note.txt");
    const ask = (artifact_id: string, assets: { path: string; artifact_id: string }[] = []) =>
      pages.publish({
        artifact_id,
        assets,
        audience: "person",
        person_id: f.person,
        requested_by: f.person,
      });
    expect(await ask(note.id)).toMatchObject({ ok: false, refused: "not_html" });
    const png = await f.store.ingest(await pngWithTrailer(), {
      source: "sandbox",
      plugin: "sandbox",
      place: f.room,
      made_for: f.person,
    });
    expect(await ask(png.id)).toMatchObject({ ok: false, refused: "not_html" });
    // Named .txt but HTML inside: a page.
    const inside = await text("<!doctype html><p>hi</p>", "page.txt");
    expect((await ask(inside.id)).ok).toBe(true);
    const html = await text("<p>x</p>", "a.html");
    const pdf = await f.store.ingest(new TextEncoder().encode("%PDF-1.7\n%%EOF\n"), {
      source: "sandbox",
      plugin: "sandbox",
      place: f.room,
      made_for: f.person,
    });
    expect(await ask(html.id, [{ path: "doc.pdf", artifact_id: pdf.id }])).toMatchObject({
      ok: false,
      refused: "type_not_allowed",
      path: "doc.pdf",
    });
    const svg = await text('<svg xmlns="http://www.w3.org/2000/svg"></svg>', "logo.svg");
    expect(await ask(html.id, [{ path: "logo.svg", artifact_id: svg.id }])).toMatchObject({
      ok: false,
      refused: "type_not_allowed",
    });
    expect(await ask(html.id, [{ path: "../x.css", artifact_id: note.id }])).toMatchObject({
      ok: false,
      refused: "asset_path",
    });
  });

  it("refuses a secret in the page or in a text file of it", async () => {
    const { pages } = rig();
    const leaky = await text(
      `<html><body><script>const k = "${KEY}";</script></body></html>`,
      "a.html",
    );
    const ask = (artifact_id: string, assets: { path: string; artifact_id: string }[] = []) =>
      pages.publish({
        artifact_id,
        assets,
        audience: "person",
        person_id: f.person,
        requested_by: f.person,
      });
    expect(await ask(leaky.id)).toMatchObject({ ok: false, refused: "secret" });
    const clean = await text("<p>ok</p>", "b.html");
    const js = await text(`fetch("x", { headers: { k: "${KEY}" } });\n`, "app.js");
    expect(await ask(clean.id, [{ path: "app.js", artifact_id: js.id }])).toMatchObject({
      ok: false,
      refused: "secret",
      path: "app.js",
    });
    expect(f.store.pages.list()).toEqual([]);
  });

  it("caps the HTML and the page with its files", async () => {
    const { pages } = rig({ config: { page_max_kb: 1, page_total_max_kb: 2 } });
    const big = await text(`<p>${"x".repeat(1100)}</p>`, "big.html");
    const ask = (artifact_id: string, assets: { path: string; artifact_id: string }[] = []) =>
      pages.publish({
        artifact_id,
        assets,
        audience: "person",
        person_id: f.person,
        requested_by: f.person,
      });
    expect(await ask(big.id)).toMatchObject({ ok: false, refused: "too_large" });
    const small = await text("<p>x</p>", "small.html");
    const css = await text(`/* ${"y".repeat(2100)} */`, "s.css");
    expect(await ask(small.id, [{ path: "s.css", artifact_id: css.id }])).toMatchObject({
      ok: false,
      refused: "too_large",
    });
    expect((await ask(small.id)).ok).toBe(true);
  });

  it("counts toward the person's links of the day", async () => {
    const { pages, links } = rig({ config: { links_per_person_per_day: 2 } });
    const html = await text("<p>x</p>", "a.html");
    const ask = () =>
      pages.publish({
        artifact_id: html.id,
        assets: [],
        audience: "person",
        person_id: f.person,
        requested_by: f.person,
      });
    expect((await ask()).ok).toBe(true);
    const note = await text("words\n", "n.txt");
    const link = await links.issue({
      artifact_id: note.id,
      audience: "person",
      person_id: f.person,
    });
    expect(link.ok).toBe(true);
    expect(await ask()).toMatchObject({ ok: false, refused: "quota" });
    expect(links.quota(f.person).used).toBe(2);
    f.clock.advance(DAY + 1);
    expect((await ask()).ok).toBe(true);
  });
});

describe("who can open a page", () => {
  it("sends a page for one person through the login, and opens it only for them", async () => {
    const { pages, app, tickets } = rig();
    const { result, slug } = await site(pages);
    const away = await get(app, `/p/${slug}/`);
    expect(away.status).toBe(302);
    expect(away.headers.get("location")).toBe(`${SITE}/api/member/files/page/${slug}`);
    // Its files too: nothing of a scoped page opens without the ticket.
    expect((await get(app, `/p/${slug}/style.css`)).status).toBe(302);
    expect((await get(app, `/p/${slug}/~nope/style.css`)).status).toBe(302);
    const theirs = ticketPath(tickets, result.page_id, slug, f.other);
    expect((await get(app, theirs)).status).toBe(403);
    // Another page's ticket opens nothing here.
    const elsewhere = `/p/${slug}/~${tickets.issue("p", "another", f.person)}/`;
    expect((await get(app, elsewhere)).status).toBe(302);
    const mine = ticketPath(tickets, result.page_id, slug, f.person);
    expect((await get(app, mine)).status).toBe(200);
    f.clock.advance(PAGE_TICKET_TTL_MS);
    expect((await get(app, mine)).status).toBe(302);
  });

  it("opens a server's page for its members only", async () => {
    const { pages, app, tickets } = rig();
    const { result, slug } = await site(pages, {
      audience: "space",
      person_id: null,
      space_id: f.room.space_id,
    });
    expect((await get(app, ticketPath(tickets, result.page_id, slug, f.other))).status).toBe(200);
    expect((await get(app, ticketPath(tickets, result.page_id, slug, f.stranger))).status).toBe(
      403,
    );
  });

  it("opens for anyone only while pages_public is on, and needs the login for the rest", async () => {
    const off = rig();
    const html = await text("<p>x</p>", "a.html");
    const anyone = {
      artifact_id: html.id,
      assets: [],
      audience: "link" as const,
      requested_by: f.person,
      widen: true,
    };
    expect(await off.pages.publish(anyone)).toMatchObject({ ok: false, refused: "not_public" });
    expect(off.pages.available("link")).toBe(false);
    const on = rig({ config: { pages_public: true } });
    const made = await on.pages.publish(anyone);
    if (!made.ok) throw new Error(made.message);
    const res = await get(on.app, made.url.slice(ORIGIN.length));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    // Anyone, without widen, is the share rule's: only a public artifact.
    expect(await on.pages.publish({ ...anyone, widen: false })).toMatchObject({
      ok: false,
      refused: "audience",
    });
    const noLogin = rig({ scoped: false });
    expect(
      await noLogin.pages.publish({
        artifact_id: html.id,
        assets: [],
        audience: "person",
        person_id: f.person,
        requested_by: f.person,
      }),
    ).toMatchObject({ ok: false, refused: "no_login" });
  });

  it("goes through the member site's pass, as a scoped link does", async () => {
    const { pages, files } = rig();
    const { result, slug } = await site(pages);
    const people = {
      personByAccount: async (a: AccountRef) => {
        const p = f.t.identity?.personOf(a);
        return p ? { id: p.id } : null;
      },
    };
    const state = {
      files,
      optional: (key: unknown) =>
        key === ArtifactStoreKey ? f.store : key === PeopleStoreKey ? people : undefined,
    };
    const route = filesPagePassRoute(state as never, {
      session: async (c) => {
        const who = c.req.header("x-test-member");
        return who === undefined ? null : { account: ACCOUNTS[who as keyof typeof ACCOUNTS] };
      },
    });
    const hono = new Hono<ApiEnv>();
    hono.on(route.method, route.path, (c) => route.handler(c));
    const out = await hono.request(`/api/member/files/page/${slug}`);
    expect(out.status).toBe(302);
    expect(out.headers.get("location")).toBe(
      `/api/auth/oauth/login?next=${encodeURIComponent(`/api/member/files/page/${slug}`)}`,
    );
    const mia = await hono.request(`/api/member/files/page/${slug}`, {
      headers: { "x-test-member": "mia" },
    });
    expect(mia.status).toBe(403);
    const owen = await hono.request(`/api/member/files/page/${slug}`, {
      headers: { "x-test-member": "owen" },
    });
    expect(owen.status).toBe(302);
    const back = owen.headers.get("location") ?? "";
    expect(back.startsWith(`${ORIGIN}/p/${slug}/~`)).toBe(true);
    expect(back.endsWith("/")).toBe(true);
    const ticket = back.slice(`${ORIGIN}/p/${slug}/~`.length, -1);
    expect(files.tickets.verify(ticket, "p", result.page_id)).toBe(f.person);
    expect((await hono.request("/api/member/files/page/nope")).status).toBe(404);
  });
});

describe("how long a page stays up", () => {
  it("expires after its days (default 30, never past the cap), and keeps its files that long", async () => {
    const { pages, app, tickets } = rig({ config: { page_max_days: 40 } });
    const { result, slug, css } = await site(pages);
    expect(Date.parse(result.expires_at)).toBe(T0 + 30 * DAY);
    expect(Date.parse(f.store.get(css.id)?.expires_at ?? "")).toBe(T0 + 30 * DAY);
    const long = await site(pages, { days: 365 });
    expect(Date.parse(long.result.expires_at)).toBe(T0 + 40 * DAY);
    f.clock.advance(30 * DAY);
    const path = ticketPath(tickets, result.page_id, slug, f.person);
    expect((await get(app, path)).status).toBe(404);
    expect((await get(app, `${path}style.css`)).status).toBe(404);
  });

  it("is gone at once when taken back", async () => {
    const { pages, app, tickets } = rig();
    const { result, slug } = await site(pages);
    const path = ticketPath(tickets, result.page_id, slug, f.person);
    expect((await get(app, path)).status).toBe(200);
    expect(f.store.pages.revoke(result.page_id)).toBe(true);
    expect((await get(app, path)).status).toBe(404);
    expect((await get(app, `${path}app.js`)).status).toBe(404);
  });
});

describe("the banner", () => {
  it("goes first into the body, or where the body starts, and escapes her name", () => {
    const at = (html: string) => withBanner(html, "<b>", "mabc");
    expect(at("<html><body><p>x</p></body></html>")).toMatch(
      /^<html><body><div id="mabc" role="note"/,
    );
    expect(at("<!doctype html><title>t</title><p>x</p>")).toMatch(/^<!doctype html><div id="mabc"/);
    expect(at("<p>bare</p>")).toMatch(/^<div id="mabc"/);
    expect(at("<html><head></head><p>x</p></html>")).toMatch(/^<html><head><\/head><div id="mabc"/);
    // A body tag inside a script or a comment is not where the body starts.
    const tricky = at(
      '<html><head><script>let s = "<body>";</script></head><body id="b"><p>x</p></body></html>',
    );
    expect(tricky).toContain('<body id="b"><div id="mabc"');
    expect(at("<body>")).toContain("&lt;b&gt;");
    expect(at("<body>")).toContain("position:fixed!important");
  });
});
