// The browser driver (docs/design/v6-agent-split.md P6): a proc of a `browser` job, started by
// Core as `node /opt/miyoria/browser/driver.mjs`, spoken to in JSON-RPC 2.0 with `Content-Length`
// frames on stdin and stdout. stdout carries only frames; everything else goes to stderr.
//
// Chromium goes out through the job's egress proxy (HTTP_PROXY / HTTPS_PROXY, which the service
// sets for every job with a network); the container's network has no other way out, so the proxy
// is what decides what a page can reach. Downloads are saved in /workspace/downloads/, which Core
// takes back into the person's folder.
//
// Methods:
//   browse.ping {}                                   -> { playwright, browser }
//   browse.open { url, wait? }                       -> { url, title, status }
//   browse.act  { action, ref?, selector?, text?, value? }
//                                                    -> { url, title, navigated, new_tab, downloads, note }
//   browse.read { mode, offset?, max_chars? }        -> { url, title, text, total_chars, offset, truncated }
//   browse.shot { full_page? }                       -> { mime, data, width, height, clipped, url, title }
//
// Every element she can use gets a short ref (`e12`, the attribute `data-miyoria-ref`), listed by
// `read` in `outline` and `links` mode; `act` finds it again by that attribute. A page can see and
// move the attribute; it is a page anyone wrote either way, and Core frames all of it as data.

import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 1024;
export const VIEWPORT = { width: 1280, height: 800 };
export const SHOT_MAX_BYTES = 2 * 1024 * 1024;
/** Tallest full-page picture; a longer page is cut there. */
const SHOT_MAX_HEIGHT = 8000;
const DOWNLOADS = "/workspace/downloads";
const MAX_DOWNLOADS = 100;
const STEP_TIMEOUT_MS = Number(process.env.MIYORIA_BROWSE_STEP_MS) || 40_000;
const READ_MAX_CHARS = 50_000;
const REF_ATTR = "data-miyoria-ref";

// ---- Framing ------------------------------------------------------------------------------

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/** Splits stdin into frame bodies; throws on a frame it will not read. */
export class FrameDecoder {
  #buffer = Buffer.alloc(0);
  #need = null;

  push(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const out = [];
    for (;;) {
      if (this.#need === null) {
        const end = this.#buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (this.#buffer.length > MAX_HEADER_BYTES) throw new Error("header too long");
          return out;
        }
        const header = this.#buffer.subarray(0, end).toString("ascii");
        const m = /content-length:\s*(\d{1,10})/i.exec(header);
        if (!m) throw new Error("frame without a Content-Length");
        const length = Number(m[1]);
        if (length > MAX_FRAME_BYTES) throw new Error("frame too large");
        this.#need = length;
        this.#buffer = this.#buffer.subarray(end + 4);
      }
      if (this.#buffer.length < this.#need) return out;
      out.push(Buffer.from(this.#buffer.subarray(0, this.#need)));
      this.#buffer = this.#buffer.subarray(this.#need);
      this.#need = null;
    }
  }
}

// ---- Checks -------------------------------------------------------------------------------

/** A refusal of the request itself (JSON-RPC invalid params). */
export class ParamsError extends Error {}
/** The page would not (navigation failed, no such element, a timeout). */
class PageError extends Error {}
/** The page's own scripts kept it from answering (evaluate and title have no timeout of their own). */
class HungError extends Error {}

/** `promise`, or `HungError` after `ms`. */
export function bounded(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HungError(`${what} did not answer in ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** http(s), data: and about:blank only: nothing of this machine's files or the browser's own pages. */
export function checkUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) {
    throw new ParamsError("url must be a string of 1 to 4096 characters");
  }
  if (raw === "about:blank") return raw;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ParamsError("not a URL");
  }
  if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:") return raw;
  throw new ParamsError(`${url.protocol} addresses are not opened`);
}

/**
 * A file name of a download: no path, no control characters, not hidden, at most 120 chars.
 * Chromium has already turned the separators of a name like `../../report.txt` into `_`
 * (`_.._report.txt`), so what is left of the climb is dropped as well.
 */
export function safeFileName(raw) {
  const base = String(raw ?? "")
    .split(/[\\/]/)
    .pop()
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^(?:[_\s.]*\.\.[_\s]*)+/, "")
    .replace(/^[.\s]+/, "")
    .trim();
  const chars = [...base];
  const name = chars.length > 120 ? chars.slice(chars.length - 120).join("") : base;
  return name === "" ? "download" : name;
}

function string(value, name, max) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) {
    throw new ParamsError(`${name} must be a string of at most ${max} characters`);
  }
  return value;
}

function ref(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^e\d{1,6}$/.test(value)) throw new ParamsError("bad ref");
  return value;
}

function clipText(text, max) {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join("") : text;
}

// ---- What runs in the page ------------------------------------------------------------------

// Serialized into the page by `page.evaluate`: everything it needs is inside.
function snapshotInPage(args) {
  const { mode, attr, next } = args;
  let counter = next;
  const interactive =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
    '[role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], ' +
    '[role="menuitem"], [role="option"], [role="switch"], [role="combobox"], [role="textbox"], ' +
    '[contenteditable=""], [contenteditable="true"], [onclick]';
  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const short = (s, n) => {
    const t = squash(s);
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  const labelOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (squash(text)) return text;
    }
    if (el.labels && el.labels.length > 0) return el.labels[0].textContent;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return el.placeholder || el.name || el.title || "";
    }
    const text = el.innerText || el.textContent || "";
    if (squash(text)) return text;
    const img = el.querySelector("img[alt]");
    return img?.getAttribute("alt") || el.title || "";
  };
  const refOf = (el) => {
    let r = el.getAttribute(attr);
    if (!r || !/^e\d{1,6}$/.test(r)) {
      r = `e${counter++}`;
      el.setAttribute(attr, r);
    }
    return r;
  };
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role");
    const r = refOf(el);
    const label = short(labelOf(el), 80);
    if (tag === "a") return `[${r}] 連結 ${label} → ${short(el.href, 200)}`;
    if (tag === "select") {
      const options = [...el.options].slice(0, 15).map((o) => short(o.label || o.value, 30));
      const now = el.selectedOptions[0]?.label ?? "";
      return `[${r}] 下拉選單 ${label}:${options.join(" / ")}${el.options.length > 15 ? " / …" : ""}(現在:${short(now, 30)})`;
    }
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        return `[${r}] ${type === "checkbox" ? "勾選框" : "單選"} ${label} ${el.checked ? "[x]" : "[ ]"}`;
      }
      if (type === "submit" || type === "button" || type === "reset") {
        return `[${r}] 按鈕 ${short(el.value || label, 80)}`;
      }
      const value = type === "password" ? (el.value ? "••••" : "") : short(el.value, 60);
      return `[${r}] 輸入框(${type}) ${label}${value ? ` = ${value}` : ""}`;
    }
    if (tag === "textarea") return `[${r}] 多行輸入框 ${label}${el.value ? ` = ${short(el.value, 60)}` : ""}`;
    if (tag === "button" || role === "button") return `[${r}] 按鈕 ${label}`;
    if (el.isContentEditable) return `[${r}] 可編輯區 ${label}`;
    return `[${r}] ${role || tag} ${label}`;
  };

  if (mode === "text") {
    return { text: document.body ? document.body.innerText : "", next: counter };
  }
  if (mode === "links") {
    const lines = [];
    for (const a of document.querySelectorAll("a[href]")) {
      if (!visible(a)) continue;
      lines.push(`[${refOf(a)}] ${short(labelOf(a), 80) || "(沒有文字)"} → ${short(a.href, 300)}`);
    }
    return { text: lines.join("\n"), next: counter };
  }
  // outline: headings and what can be used, in the order of the page
  const lines = [];
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT);
  const seen = new Set();
  for (let node = walker.currentNode; node; node = walker.nextNode()) {
    const el = node;
    if (!(el instanceof HTMLElement)) continue;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      if (visible(el)) lines.push(`${"#".repeat(Number(tag[1]))} ${short(el.innerText, 120)}`);
      continue;
    }
    if (el.matches(interactive) && !seen.has(el) && visible(el)) {
      seen.add(el);
      lines.push(describe(el));
    }
  }
  return { text: lines.join("\n"), next: counter };
}

// ---- The browser ----------------------------------------------------------------------------

export class Driver {
  #playwright;
  #browser = null;
  #context = null;
  #page = null;
  #pages = [];
  #refs = new WeakMap();
  #downloads = [];
  #pending = new Set();
  /** Paths given to a download that may not be on the disk yet (two at once get two names). */
  #taken = new Set();
  #saved = 0;

  constructor(playwright) {
    this.#playwright = playwright;
  }

  async start() {
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
    this.#browser = await this.#playwright.chromium.launch({
      headless: true,
      ...(proxy ? { proxy: { server: proxy } } : {}),
      args: [
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-first-run",
        "--disable-crash-reporter",
      ],
      downloadsPath: "/tmp/miyoria-downloads",
    });
    this.#context = await this.#browser.newContext({
      viewport: VIEWPORT,
      acceptDownloads: true,
      locale: process.env.MIYORIA_BROWSE_LOCALE || "zh-TW",
      serviceWorkers: "block",
    });
    this.#context.setDefaultTimeout(STEP_TIMEOUT_MS);
    this.#context.setDefaultNavigationTimeout(STEP_TIMEOUT_MS);
    this.#context.on("page", (page) => this.#adopt(page));
    this.#adopt(await this.#context.newPage());
  }

  #adopt(page) {
    // The context's "page" event comes for `newPage()` too: a page adopted twice would save each
    // of its downloads twice.
    if (this.#pages.includes(page)) {
      this.#page = page;
      return;
    }
    this.#pages.push(page);
    this.#page = page;
    page.on("download", (download) => this.#download(download));
    page.on("close", () => {
      this.#pages = this.#pages.filter((p) => p !== page);
      if (this.#page === page) this.#page = this.#pages.at(-1) ?? null;
    });
    page.on("dialog", (dialog) => {
      // alert / confirm / prompt would block the page until someone answers.
      dialog.dismiss().catch(() => {});
    });
  }

  async #download(download) {
    if (this.#saved >= MAX_DOWNLOADS) {
      await download.cancel().catch(() => {});
      return;
    }
    this.#saved++;
    const task = (async () => {
      await mkdir(DOWNLOADS, { recursive: true });
      const name = safeFileName(download.suggestedFilename());
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let target = join(DOWNLOADS, name);
      // Chosen without awaiting in between, so two downloads of one name cannot pick the same.
      for (let n = 2; this.#taken.has(target) || existsSync(target); n++) {
        target = join(DOWNLOADS, `${stem}-${n}${ext}`);
      }
      this.#taken.add(target);
      await download.saveAs(target);
      const info = await stat(target);
      this.#downloads.push({ path: target.slice("/workspace/".length), bytes: info.size });
    })().catch((error) => {
      process.stderr.write(`download failed: ${error?.message ?? error}\n`);
    });
    this.#pending.add(task);
    task.finally(() => this.#pending.delete(task));
  }

  async #current() {
    if (this.#page === null || this.#page.isClosed()) this.#adopt(await this.#context.newPage());
    return this.#page;
  }

  async #title(page) {
    return clipText(await bounded(page.title(), 5000, "title").catch(() => ""), 500);
  }

  /**
   * Runs `fn` in the page within one step's time. A page that does not answer is closed (the
   * renderer is stuck in its own scripts and would hold every later step too), so the session
   * goes on with a blank page instead of hanging until it is closed.
   */
  async #evaluate(page, fn, arg) {
    try {
      return await bounded(page.evaluate(fn, arg), STEP_TIMEOUT_MS, "the page");
    } catch (error) {
      if (!(error instanceof HungError)) throw error;
      await bounded(page.close({ runBeforeUnload: false }), 5000, "closing").catch(() => {});
      throw new PageError("the page's scripts kept it from answering, so it was closed; open it again");
    }
  }

  async ping() {
    let version = "";
    try {
      const file = new URL("./node_modules/playwright-core/package.json", import.meta.url);
      version = String(JSON.parse(await readFile(file, "utf8")).version ?? "");
    } catch {
      // Only for the log.
    }
    return { playwright: clipText(version, 40), browser: clipText(this.#browser.version(), 40) };
  }

  async open(params) {
    const url = checkUrl(params.url);
    const wait = params.wait ?? "load";
    if (!["load", "domcontentloaded", "networkidle"].includes(wait)) throw new ParamsError("bad wait");
    const page = await this.#current();
    let response;
    try {
      response = await page.goto(url, { waitUntil: wait });
    } catch (error) {
      throw new PageError(firstLine(error));
    }
    return { url: page.url(), title: await this.#title(page), status: response ? response.status() : null };
  }

  #locator(page, params) {
    const r = ref(params.ref);
    const selector = string(params.selector, "selector", 500);
    if (r !== undefined) return page.locator(`[${REF_ATTR}="${r}"]`).first();
    if (selector !== undefined) return page.locator(selector).first();
    throw new ParamsError("ref or selector is needed");
  }

  async act(params) {
    const action = params.action;
    const text = string(params.text, "text", 10_000);
    const value = string(params.value, "value", 1000);
    let page = await this.#current();
    const before = page.url();
    const pagesBefore = this.#pages.length;
    const downloadsBefore = this.#downloads.length;
    let note = null;
    try {
      switch (action) {
        case "click":
          await this.#locator(page, params).click();
          break;
        case "type":
          if (text === undefined) throw new ParamsError("type needs text");
          await this.#locator(page, params).fill(text);
          break;
        case "press": {
          const key = value ?? text;
          if (key === undefined || key.length > 40) throw new ParamsError("press needs a key");
          if (params.ref !== undefined || params.selector !== undefined) {
            await this.#locator(page, params).press(key);
          } else await page.keyboard.press(key);
          break;
        }
        case "select": {
          if (value === undefined) throw new ParamsError("select needs value");
          const target = this.#locator(page, params);
          try {
            await target.selectOption(value, { timeout: 5000 });
          } catch {
            await target.selectOption({ label: value });
          }
          break;
        }
        case "scroll":
          if (params.ref !== undefined || params.selector !== undefined) {
            await this.#locator(page, params).scrollIntoViewIfNeeded();
          } else if (value === "top" || value === "bottom") {
            await this.#evaluate(
              page,
              (to) => window.scrollTo(0, to === "top" ? 0 : document.body.scrollHeight),
              value,
            );
          } else {
            await page.mouse.wheel(0, value === "up" ? -VIEWPORT.height * 0.8 : VIEWPORT.height * 0.8);
          }
          break;
        case "back": {
          const went = await page.goBack();
          if (went === null) note = "沒有上一頁";
          break;
        }
        case "wait":
          if (text !== undefined) await page.getByText(text).first().waitFor({ timeout: 10_000 });
          else await page.waitForTimeout(Math.min(10_000, Math.max(0, Number(value) || 0)));
          break;
        default:
          throw new ParamsError(`unknown action ${String(action).slice(0, 20)}`);
      }
    } catch (error) {
      if (error instanceof ParamsError) throw error;
      throw new PageError(firstLine(error));
    }
    // A click may navigate, open a tab or start a download a moment later.
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    if (this.#pending.size > 0) {
      await Promise.race([Promise.allSettled([...this.#pending]), new Promise((r) => setTimeout(r, STEP_TIMEOUT_MS / 2))]);
    }
    const newTab = this.#pages.length > pagesBefore;
    page = await this.#current();
    return {
      url: page.url(),
      title: await this.#title(page),
      navigated: newTab || page.url() !== before,
      new_tab: newTab,
      downloads: this.#downloads.slice(downloadsBefore),
      note,
    };
  }

  async read(params) {
    const mode = params.mode ?? "text";
    if (!["text", "links", "outline"].includes(mode)) throw new ParamsError("bad mode");
    const offset = Number.isInteger(params.offset) && params.offset >= 0 ? params.offset : 0;
    const max = Math.min(READ_MAX_CHARS, Number.isInteger(params.max_chars) ? params.max_chars : 8000);
    const page = await this.#current();
    let got;
    try {
      got = await this.#evaluate(page, snapshotInPage, {
        mode,
        attr: REF_ATTR,
        next: this.#refs.get(page) ?? 1,
      });
    } catch (error) {
      throw new PageError(firstLine(error));
    }
    if (typeof got?.next === "number") this.#refs.set(page, got.next);
    const all = [...String(got?.text ?? "").replace(/\n{3,}/g, "\n\n")];
    const text = all.slice(offset, offset + max).join("");
    return {
      url: page.url(),
      title: await this.#title(page),
      text,
      total_chars: all.length,
      offset,
      truncated: offset + max < all.length,
    };
  }

  async shot(params) {
    const page = await this.#current();
    const full = params.full_page === true;
    let height = VIEWPORT.height;
    let clipped = false;
    if (full) {
      height = await this.#evaluate(page, () => document.documentElement.scrollHeight).catch(
        (error) => {
          if (page.isClosed()) throw error;
          return VIEWPORT.height;
        },
      );
      if (height > SHOT_MAX_HEIGHT) {
        height = SHOT_MAX_HEIGHT;
        clipped = true;
      }
    }
    const take = async (type, quality, wholePage) =>
      page.screenshot({
        type,
        ...(quality === undefined ? {} : { quality }),
        animations: "disabled",
        caret: "hide",
        ...(wholePage
          ? { fullPage: true, clip: { x: 0, y: 0, width: VIEWPORT.width, height } }
          : {}),
      });
    let picture;
    let mime = "image/png";
    try {
      picture = await take("png", undefined, full);
      if (picture.length > SHOT_MAX_BYTES) {
        mime = "image/jpeg";
        picture = await take("jpeg", 70, full);
      }
      if (picture.length > SHOT_MAX_BYTES) {
        picture = await take("jpeg", 50, false);
        height = VIEWPORT.height;
        clipped = full;
      }
    } catch (error) {
      throw new PageError(firstLine(error));
    }
    if (picture.length > SHOT_MAX_BYTES) throw new PageError("the screenshot is too large");
    return {
      mime,
      data: picture.toString("base64"),
      width: VIEWPORT.width,
      height: full ? height : VIEWPORT.height,
      clipped,
      url: page.url(),
      title: await this.#title(page),
    };
  }

  async close() {
    await this.#browser?.close().catch(() => {});
  }
}

function firstLine(error) {
  const text = String(error?.message ?? error);
  return clipText(text.split("\n").filter((l) => l.trim() !== "")[0] ?? "failed", 500);
}

// ---- The loop -------------------------------------------------------------------------------

/** Answers one request. */
export async function handle(driver, message) {
  const { id, method, params } = message ?? {};
  const p = params !== null && typeof params === "object" ? params : {};
  const methods = {
    "browse.ping": () => driver.ping(),
    "browse.open": () => driver.open(p),
    "browse.act": () => driver.act(p),
    "browse.read": () => driver.read(p),
    "browse.shot": () => driver.shot(p),
  };
  const run = Object.hasOwn(methods, method) ? methods[method] : null;
  if (run === null) return { jsonrpc: "2.0", id, error: { code: -32601, message: "no such method" } };
  try {
    return { jsonrpc: "2.0", id, result: await run() };
  } catch (error) {
    const code = error instanceof ParamsError ? -32602 : error instanceof PageError ? 1 : -32603;
    return { jsonrpc: "2.0", id, error: { code, message: firstLine(error) } };
  }
}

export async function main() {
  // Anything that logs must not write into the frames.
  console.log = console.error;
  console.info = console.error;
  const playwright = await import("playwright-core");
  const driver = new Driver(playwright.default ?? playwright);
  const ready = driver.start();
  ready.catch((error) => process.stderr.write(`the browser did not start: ${firstLine(error)}\n`));
  const decoder = new FrameDecoder();
  let queue = Promise.resolve();
  const answer = (message) => {
    queue = queue.then(async () => {
      let reply;
      try {
        await ready;
        reply = await handle(driver, message);
      } catch (error) {
        reply = { jsonrpc: "2.0", id: message?.id, error: { code: -32603, message: firstLine(error) } };
      }
      if (reply.id !== undefined) process.stdout.write(encodeFrame(reply));
    });
  };
  process.stdin.on("data", (chunk) => {
    let bodies;
    try {
      bodies = decoder.push(chunk);
    } catch (error) {
      process.stderr.write(`bad frame: ${error.message}\n`);
      process.exit(2);
    }
    for (const body of bodies) {
      let message;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        process.stdout.write(encodeFrame({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
        continue;
      }
      answer(message);
    }
  });
  const stop = async () => {
    await queue.catch(() => {});
    await driver.close();
    process.exit(0);
  };
  process.stdin.on("end", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
