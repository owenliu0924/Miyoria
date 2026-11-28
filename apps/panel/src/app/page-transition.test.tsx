import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberSession, SessionInfo } from "@miyoria/contracts/api";
import {
  type AppView,
  adminPageTransition,
  appViewOf,
  isAppPageChange,
  isOutsideAdmin,
  isPageChange,
  isSkippedTransition,
  opensInApp,
  routerPageTransition,
  startPageTransition,
} from "./page-transition";
import type { AuthState } from "./visitor";

const MEMBER: AuthState = { status: "public", member: {} as MemberSession };
const VISITOR: AuthState = { status: "public", member: null };
const DISCORD_ADMIN: AuthState = { status: "signed_in", session: { method: "discord" } as SessionInfo };
const TOKEN_ADMIN: AuthState = { status: "signed_in", session: { method: "token" } as SessionInfo };

const at = (path: string, view: AppView) => ({ path, view });

/** A browser with view transitions and their types; `update` runs on the next microtask. */
function supportTransitions({ reduced = false } = {}) {
  const start = vi.fn((options: { update: () => void | Promise<void>; types: string[] }) => {
    const done = Promise.resolve().then(() => options.update());
    return { ready: done, finished: done, updateCallbackDone: done, skipTransition: () => {} };
  });
  Object.defineProperty(document, "startViewTransition", { value: start, configurable: true, writable: true });
  vi.stubGlobal("CSS", { supports: () => true });
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) => ({ matches: reduced && query.includes("reduce"), media: query }) as MediaQueryList,
  );
  return start;
}

afterEach(() => {
  delete (document as { startViewTransition?: unknown }).startViewTransition;
  vi.unstubAllGlobals();
});

describe("isPageChange", () => {
  it("is a change of path only", () => {
    expect(isPageChange("/llm", "/system")).toBe(true);
    expect(isPageChange("/system", "/system/market")).toBe(true);
    expect(isPageChange("/live", "/live/")).toBe(false);
    expect(isPageChange("/llm", "/llm")).toBe(false);
    expect(isPageChange(undefined, "/llm")).toBe(false);
  });
});

describe("adminPageTransition", () => {
  it("runs for another admin page, not for a tab, a sheet or the first load", () => {
    expect(adminPageTransition({ pathname: "/llm" }, { pathname: "/system" })).toEqual(["page"]);
    expect(adminPageTransition({ pathname: "/activity" }, { pathname: "/activity" })).toBe(false);
    expect(adminPageTransition(undefined, { pathname: "/" })).toBe(false);
  });

  it("leaves the switch to a page App draws outside the panel alone", () => {
    expect(isOutsideAdmin("/me")).toBe(true);
    expect(isOutsideAdmin("/me/wallet")).toBe(true);
    expect(isOutsideAdmin("/her")).toBe(true);
    expect(isOutsideAdmin("/watch")).toBe(true);
    expect(isOutsideAdmin("/live")).toBe(false);
    expect(adminPageTransition({ pathname: "/live" }, { pathname: "/me" })).toBe(false);
  });

  it("runs none under reduced motion", () => {
    supportTransitions({ reduced: true });
    expect(adminPageTransition({ pathname: "/llm" }, { pathname: "/system" })).toBe(false);
  });
});

describe("appViewOf", () => {
  it("picks the page from the address the way App does", () => {
    expect(appViewOf("/card/MYR-ABC", VISITOR, false)).toBe("card");
    expect(appViewOf("/watch", { status: "checking" }, false)).toBe("watch");
    expect(appViewOf("/me", { status: "checking" }, false)).toBe("checking");
    expect(appViewOf("/her", MEMBER, false)).toBe("her");
    expect(appViewOf("/her?room-demo", DISCORD_ADMIN, false)).toBe("her");
    expect(appViewOf("/her", TOKEN_ADMIN, false)).toBe("admin");
    expect(appViewOf("/her", VISITOR, false)).toBe("front");
    expect(appViewOf("/karaoke/room/ABCDEF", MEMBER, false)).toBe("karaoke");
    expect(appViewOf("/me/wallet", DISCORD_ADMIN, false)).toBe("own");
    expect(appViewOf("/me/wallet", MEMBER, false)).toBe("member");
    expect(appViewOf("/", MEMBER, false)).toBe("member");
    expect(appViewOf("/login", MEMBER, true)).toBe("token");
    expect(appViewOf("/", { status: "signed_out" }, false)).toBe("token");
    expect(appViewOf("/live", DISCORD_ADMIN, false)).toBe("admin");
  });
});

describe("isAppPageChange", () => {
  it("fades the member area's tabs, pushed or by back and forward", () => {
    expect(isAppPageChange("PUSH", at("/me", "member"), at("/me/gifts", "member"))).toBe(true);
    expect(isAppPageChange("BACK", at("/me/gifts", "member"), at("/me", "member"))).toBe(true);
    expect(isAppPageChange("FORWARD", at("/me/cards", "own"), at("/me/play", "own"))).toBe(true);
  });

  it("fades between her pages and between the panel and an admin's own page", () => {
    expect(isAppPageChange("PUSH", at("/me", "member"), at("/her", "her"))).toBe(true);
    expect(isAppPageChange("BACK", at("/her", "her"), at("/me", "member"))).toBe(true);
    expect(isAppPageChange("PUSH", at("/me", "own"), at("/", "admin"))).toBe(true);
  });

  it("leaves a query change, a replace, the panel's own pages and singing's rooms instant", () => {
    expect(isAppPageChange("PUSH", at("/me", "member"), at("/me?github=linked", "member"))).toBe(false);
    expect(isAppPageChange("REPLACE", at("/me/nope", "member"), at("/me", "member"))).toBe(false);
    expect(isAppPageChange("PUSH", at("/llm", "admin"), at("/system", "admin"))).toBe(false);
    expect(isAppPageChange("BACK", at("/live", "admin"), at("/me", "own"))).toBe(false);
    expect(isAppPageChange("PUSH", at("/karaoke", "karaoke"), at("/karaoke/room/ABCDEF", "karaoke"))).toBe(false);
    expect(isAppPageChange("PUSH", at("/me", "checking"), at("/her", "checking"))).toBe(false);
  });
});

describe("opensInApp", () => {
  it("keeps links between her pages in the page where a fade can show it", () => {
    supportTransitions();
    expect(opensInApp(at("/me", "member"), at("/her", "her"))).toBe(true);
    expect(opensInApp(at("/her", "her"), at("/", "member"))).toBe(true);
    expect(opensInApp(at("/her", "her"), at("/watch", "watch"))).toBe(true);
    expect(opensInApp(at("/me/cards", "own"), at("/card/MYR-ABC", "card"))).toBe(true);
  });

  it("leaves singing, the panel, other files and the same address to the browser", () => {
    supportTransitions();
    expect(opensInApp(at("/me", "member"), at("/karaoke", "karaoke"))).toBe(false);
    expect(opensInApp(at("/karaoke", "karaoke"), at("/", "member"))).toBe(false);
    expect(opensInApp(at("/card/MYR-ABC", "card"), at("/", "admin"))).toBe(false);
    expect(opensInApp(at("/watch", "watch"), at("/", "front"))).toBe(false);
    expect(opensInApp(at("/me", "member"), at("/api/member/session", "member"))).toBe(false);
    expect(opensInApp(at("/me", "member"), at("/me#wallet", "member"))).toBe(false);
  });

  it("loads pages as before without view transitions", () => {
    expect(opensInApp(at("/me", "member"), at("/her", "her"))).toBe(false);
  });
});

describe("isSkippedTransition", () => {
  it("knows a skipped transition from other errors", () => {
    expect(isSkippedTransition(new DOMException("Transition was skipped", "AbortError"))).toBe(true);
    expect(isSkippedTransition(new DOMException("The operation was aborted.", "AbortError"))).toBe(false);
    expect(isSkippedTransition(new Error("Transition was skipped"))).toBe(false);
    expect(isSkippedTransition(undefined)).toBe(false);
  });
});

describe("startPageTransition", () => {
  it("just runs the update without view transitions", () => {
    const update = vi.fn();
    startPageTransition(update);
    expect(update).toHaveBeenCalledOnce();
  });

  it("runs the update inside a typed transition where there are", async () => {
    const start = supportTransitions();
    const update = vi.fn();
    startPageTransition(update);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ types: ["page"] }));
    await act(async () => {});
    expect(update).toHaveBeenCalledOnce();
  });

  it("starts no second transition from inside an update", async () => {
    const start = supportTransitions();
    const inner = vi.fn();
    startPageTransition(() => startPageTransition(inner));
    await act(async () => {});
    expect(inner).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
  });
});

describe("the router", () => {
  it("has no transitions where the browser has none", () => {
    expect(routerPageTransition()).toBe(false);
  });

  it("fades a change of page and nothing else", async () => {
    const start = supportTransitions();
    const rootRoute = createRootRoute({ component: Outlet });
    const page = (path: string) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path,
        validateSearch: (s: Record<string, unknown>) => ({ tab: typeof s.tab === "string" ? s.tab : undefined }),
        component: () => <p>{path}</p>,
      });
    const router = createRouter({
      routeTree: rootRoute.addChildren([page("/llm"), page("/system")]),
      history: createMemoryHistory({ initialEntries: ["/llm"] }),
      defaultViewTransition: routerPageTransition(),
    });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText("/llm")).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();

    await act(() => router.navigate({ to: "/llm", search: { tab: "calls" } }));
    expect(router.state.location.search).toEqual({ tab: "calls" });
    expect(start).not.toHaveBeenCalled();

    await act(() => router.navigate({ to: "/system", search: {} }));
    expect(await screen.findByText("/system")).toBeInTheDocument();
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ types: ["page"] }));
  });
});
