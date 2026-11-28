// Page transitions (the View Transitions API): a short cross-fade when the page changes, nothing
// when only a tab, a filter, a sheet or another search parameter does. The look is in
// `index.css` ("Page transitions"); every transition here carries the type `page`.
//
// What runs one:
// - The admin router (`defaultViewTransition`), when the path changes to another admin page.
// - `App`, for every page it picks itself from the path (`appViewOf`): the member area's tabs, and
//   a switch between her room, her live page, a card's page and the member page, pushed or by
//   back and forward (`isAppPageChange`). Links between those pages stay in the page
//   (`opensInApp`) instead of loading it again, so the fade goes from one page to the other.
// - `startPageTransition` directly, around the switch from the admin panel to an admin's own
//   member page.
//
// Browsers without `document.startViewTransition` or without transition types, a reader who asks
// for reduced motion and a hidden tab get none; without the API the links load pages as before.

import type { AnyRouter, ParsedLocation } from "@tanstack/react-router";
import { flushSync } from "react-dom";
import { cardSerialIn } from "@/pages/public/CardVerify";
import { isKaraokePath } from "@/pages/public/karaoke/path";
import { isLivePath } from "@/pages/public/live/path";
import { isOwnPath } from "@/pages/public/member-tabs";
import { isRoomPath } from "@/pages/public/room/path";
import type { AuthState } from "./visitor";

/** The router's `{ types }` form of `defaultViewTransition` (router-core's `ViewTransitionOptions`). */
type ViewTransitionOptions = Exclude<NonNullable<AnyRouter["options"]["defaultViewTransition"]>, boolean>;

/** The transition type every page transition carries, for the CSS to select on. */
export const PAGE_TRANSITION = "page";

/** The path alone: no query or hash, and `/live/` is `/live`. */
const bare = (path: string): string => {
  const pathname = path.split(/[?#]/)[0] ?? "";
  return (pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname) || "/";
};

/**
 * Whether going from `from` to `to` (paths, with or without the query) is a change of page. A
 * change of query or hash alone (a filter, `?call=`, `?space=`, `?room-demo`) is not.
 */
export function isPageChange(from: string | undefined, to: string): boolean {
  if (from === undefined) return false;
  return bare(from) !== bare(to);
}

/**
 * A path `App` draws outside the admin panel (a card's check page, her live page, singing, her
 * room, an admin's own member page). Going there unmounts the router, so the router must not
 * wait on a render inside a transition of its own: `startPageTransition` covers that switch.
 */
export function isOutsideAdmin(pathname: string): boolean {
  return (
    cardSerialIn(pathname) !== null ||
    isLivePath(pathname) ||
    isKaraokePath(pathname) ||
    isRoomPath(pathname) ||
    isOwnPath(pathname)
  );
}

/** What `App` shows for an address, in the order it checks (`Authenticated`). */
export type AppView = "card" | "watch" | "checking" | "karaoke" | "her" | "own" | "member" | "front" | "token" | "admin";

export function appViewOf(path: string, auth: AuthState, tokenLogin: boolean): AppView {
  if (cardSerialIn(path) !== null) return "card";
  if (isLivePath(path)) return "watch";
  if (auth.status === "checking") return "checking";
  // Singing and her room are for someone logged in with Discord: a member, or an admin as one.
  const discordAdmin = auth.status === "signed_in" && auth.session.method === "discord";
  const member = auth.status === "public" ? auth.member : null;
  if (isKaraokePath(path) && (member !== null || discordAdmin)) return "karaoke";
  if (isRoomPath(path) && (member !== null || discordAdmin)) return "her";
  if (discordAdmin && isOwnPath(path)) return "own";
  if (auth.status === "public" && !tokenLogin) return member !== null ? "member" : "front";
  if (auth.status === "signed_in") return "admin";
  return "token";
}

/** The member area: each tab is its own address, and moving between them is a change of page. */
const TABBED: readonly AppView[] = ["member", "own"];

export type HistoryAction = "PUSH" | "REPLACE" | "BACK" | "FORWARD" | "GO";

/**
 * Whether `App` should fade this change of address itself. A replace (a redirect, a cleaned-up
 * address) and a change of query alone do not. The admin panel's own pages are the router's; the
 * one way out of it, to an admin's own page, is faded where it starts (`Shell`), since the router
 * would draw its not-found page before `App` switches. Moving inside singing (its rooms) is the
 * page's own business.
 */
export function isAppPageChange(
  action: HistoryAction,
  from: { path: string; view: AppView },
  to: { path: string; view: AppView },
): boolean {
  if (action === "REPLACE" || !isPageChange(from.path, to.path)) return false;
  if (from.view === "admin" || from.view === "checking" || to.view === "checking") return false;
  return from.view !== to.view || TABBED.includes(from.view);
}

/** The pages a link may open without loading the page again; singing and the panel load anew. */
const LINKED: readonly AppView[] = ["member", "own", "her", "watch", "card"];

/** Her pages, as opposed to anything else on the origin (`/api/…`, a picture, a file). */
function isSitePage(path: string): boolean {
  const p = bare(path);
  return p === "/" || isOwnPath(p) || isRoomPath(p) || isLivePath(p) || cardSerialIn(p) !== null;
}

/**
 * Whether a click on a link to `to` (path and query) should stay in the page: both pages are ones
 * `App` draws from what it already knows (who is logged in does not change), and a fade can show
 * it. Singing stays a full load both ways: its song editor guards unsaved work with
 * `beforeunload`, which a switch inside the page would pass by.
 */
export function opensInApp(from: { path: string; view: AppView }, to: { path: string; view: AppView }): boolean {
  if (!LINKED.includes(from.view) || !LINKED.includes(to.view) || !isSitePage(to.path)) return false;
  // The same address is the browser's (a reload, or a jump to a fragment).
  if (from.path.split("#")[0] === to.path.split("#")[0]) return false;
  return supportsPageTransitions();
}

/** The router's choice for one navigation: the type to run, or `false` for no transition. */
export function adminPageTransition(from: Pick<ParsedLocation, "pathname"> | undefined, to: Pick<ParsedLocation, "pathname">): string[] | false {
  // The first load (and a remounted panel's first load) has nothing to cross-fade from.
  if (from === undefined || !isPageChange(from.pathname, to.pathname)) return false;
  if (isOutsideAdmin(to.pathname) || isOutsideAdmin(from.pathname)) return false;
  if (!motionAllowed()) return false;
  return [PAGE_TRANSITION];
}

interface ViewTransitionLike {
  readonly ready: Promise<void>;
  readonly finished: Promise<void>;
  readonly updateCallbackDone: Promise<void>;
}

type StartViewTransition = (options: { update: () => void | Promise<void>; types: string[] }) => ViewTransitionLike;

function startFn(): StartViewTransition | null {
  if (typeof document === "undefined") return null;
  const start = (document as { startViewTransition?: unknown }).startViewTransition;
  return typeof start === "function" ? (start.bind(document) as StartViewTransition) : null;
}

/**
 * Same-document transitions with types. Without types the router would run a transition for
 * every navigation, search changes included, so a browser without them runs none.
 */
export function supportsPageTransitions(): boolean {
  if (startFn() === null) return false;
  try {
    return typeof CSS !== "undefined" && CSS.supports("selector(:active-view-transition-type(page))");
  } catch {
    return false;
  }
}

function motionAllowed(): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  try {
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

/**
 * A transition the browser skipped: a newer one started (a quick second click), the tab was
 * hidden, or the state was invalid. The router does not hold on to the transition's `ready`
 * promise, so where a browser reports its rejection as unhandled it is dropped here; nothing was
 * lost, the page simply changed without the fade.
 */
export function isSkippedTransition(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) return false;
  const { name, message } = reason as { name?: unknown; message?: unknown };
  return (
    (name === "AbortError" || name === "InvalidStateError") && typeof message === "string" && /transition/i.test(message)
  );
}

let guarded = false;
/** Inside a page transition's update. */
let updating = false;

function ignoreSkippedTransitions() {
  if (guarded || typeof window === "undefined") return;
  guarded = true;
  window.addEventListener("unhandledrejection", (event) => {
    if (isSkippedTransition(event.reason)) event.preventDefault();
  });
}

/** The admin router's `defaultViewTransition`. */
export function routerPageTransition(): ViewTransitionOptions | false {
  if (!supportsPageTransitions()) return false;
  ignoreSkippedTransitions();
  return { types: ({ fromLocation, toLocation }) => adminPageTransition(fromLocation, toLocation) };
}

/**
 * Runs `update` (a navigation outside the router, such as `history.push`) inside a page
 * transition, rendering React synchronously so the new page is what the browser captures. Without
 * support, or with reduced motion, `update` just runs.
 */
export function startPageTransition(update: () => void) {
  // Asked again from inside an update (the history push it makes is seen by `App`): one
  // transition already covers it.
  const start = !updating && supportsPageTransitions() && motionAllowed() ? startFn() : null;
  if (start === null) {
    update();
    return;
  }
  ignoreSkippedTransitions();
  const transition = start({
    update: () => {
      updating = true;
      try {
        flushSync(update);
      } finally {
        updating = false;
      }
    },
    types: [PAGE_TRANSITION],
  });
  // A skipped transition rejects `ready`; `finished` repeats the update's own error, which
  // `updateCallbackDone` reports once.
  transition.ready.catch(() => undefined);
  transition.finished.catch(() => undefined);
  transition.updateCallbackDone.catch((error: unknown) => console.error(error));
}
