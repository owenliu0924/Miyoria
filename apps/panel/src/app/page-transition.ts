// Page transitions (the View Transitions API): a short cross-fade when the page changes, nothing
// when only a tab, a filter, a sheet or another search parameter does. The look is in
// `index.css` ("Page transitions"); every transition here carries the type `page`.
//
// What runs one:
// - The admin router (`defaultViewTransition`), when the path changes to another admin page.
// - `startPageTransition`, around the switch between the admin panel and an admin's own member
//   page, which happens in `App` outside the router.
// - Full page loads between the site's own pages (`/her`, `/watch`, …) opt in from CSS
//   (`@view-transition`), since those links are plain anchors.
//
// Browsers without `document.startViewTransition` or without transition types, a reader who asks
// for reduced motion and a hidden tab get none and behave as before.

import type { AnyRouter, ParsedLocation } from "@tanstack/react-router";
import { flushSync } from "react-dom";
import { cardSerialIn } from "@/pages/public/CardVerify";
import { isKaraokePath } from "@/pages/public/karaoke/path";
import { isLivePath } from "@/pages/public/live/path";
import { isOwnPath } from "@/pages/public/member-tabs";
import { isRoomPath } from "@/pages/public/room/path";

/** The router's `{ types }` form of `defaultViewTransition` (router-core's `ViewTransitionOptions`). */
type ViewTransitionOptions = Exclude<NonNullable<AnyRouter["options"]["defaultViewTransition"]>, boolean>;

/** The transition type every page transition carries, for the CSS to select on. */
export const PAGE_TRANSITION = "page";

/** `/live/` and `/live` are the same page. */
const bare = (pathname: string): string => (pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname) || "/";

/**
 * Whether going from `from` to `to` (paths, without the query) is a change of page. A change of
 * query or hash alone (a tab, a filter, `?call=`, `?space=`, `?room-demo`) is not.
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
  const start = supportsPageTransitions() && motionAllowed() ? startFn() : null;
  if (start === null) {
    update();
    return;
  }
  ignoreSkippedTransitions();
  const transition = start({ update: () => flushSync(update), types: [PAGE_TRANSITION] });
  // A skipped transition rejects `ready`; `finished` repeats the update's own error, which
  // `updateCallbackDone` reports once.
  transition.ready.catch(() => undefined);
  transition.finished.catch(() => undefined);
  transition.updateCallbackDone.catch((error: unknown) => console.error(error));
}
