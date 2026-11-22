// A dev-only stand-in for the Core, to look at the member area without Discord or a Core: open the
// dev server at `/me?member-demo` (any tab: `/me/cards?member-demo`). `main.tsx` loads this only
// when `import.meta.env.DEV` (a production build has none of it) and the query asks for it, or this
// tab already did (kept in `sessionStorage`, so the tabs' own addresses and a reload stay in it);
// `?member-demo=off` leaves it. Every name and number is made up (`fixtures.ts`).
//
// It answers every member route from the fixtures and the exchange's from the exchange demo, any
// other `/api/` route with a 404, and plays her live feed's first event, so nothing reaches a Core.

import { bodyOf as exchangeBody, answer as exchangeAnswer } from "../exchange/demo";
import { DEMO_LIVE_HELLO, memberDemoAnswer } from "./fixtures";

export const MEMBER_DEMO_KEY = "miyoria.member-demo";

/** Whether this load is the member demo; `?member-demo=off` ends it for the tab. */
export function wantsMemberDemo(search: string): boolean {
  const q = new URLSearchParams(search).get("member-demo");
  try {
    if (q === "off") {
      window.sessionStorage.removeItem(MEMBER_DEMO_KEY);
      return false;
    }
    if (q !== null) window.sessionStorage.setItem(MEMBER_DEMO_KEY, "1");
    return q !== null || window.sessionStorage.getItem(MEMBER_DEMO_KEY) === "1";
  } catch {
    return q !== null && q !== "off";
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body ?? null), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Her live feed: one `hello` (a named event, as the Core sends it), then quiet. */
class DemoSource extends EventTarget {
  readyState = 1;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  constructor() {
    super();
    setTimeout(() => {
      this.onopen?.(new Event("open"));
      this.dispatchEvent(new MessageEvent("hello", { data: JSON.stringify(DEMO_LIVE_HELLO) }));
    }, 60);
  }
  close() {
    this.readyState = 2;
  }
}

/** Puts the stand-in in place of `fetch` and `EventSource`. */
export function installMemberDemo(): void {
  const member = memberDemoAnswer();
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return real(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const body: unknown = raw ? JSON.parse(raw) : undefined;
    await new Promise((r) => setTimeout(r, 120));
    const path = url.pathname;
    if (path.startsWith("/api/member/exchange") || path === "/api/exchange") {
      return exchangeAnswer(method, path, url.searchParams, body ?? (await exchangeBody(input, init))) ?? json({ error: "no such endpoint" }, 404);
    }
    const res = member(method, url, body);
    if (res) return json(res.body, res.status ?? 200);
    // Everything else a Core would serve is not there: nothing leaves this page.
    return json({ error: "no such endpoint" }, 404);
  };
  window.EventSource = DemoSource as unknown as typeof EventSource;
}
