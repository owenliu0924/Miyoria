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
import {
  adminPageTransition,
  isOutsideAdmin,
  isPageChange,
  isSkippedTransition,
  routerPageTransition,
  startPageTransition,
} from "./page-transition";

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
