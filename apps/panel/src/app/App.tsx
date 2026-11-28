import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { createBrowserHistory, type RouterHistory } from "@tanstack/react-router";
import {
  type ComponentProps,
  type ComponentType,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { describeError, isApiError } from "@/api/http";
import type { AuthMethods } from "@miyoria/contracts/api";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TokenGate } from "@/pages/login/TokenGate";
import { CardVerify, cardSerialIn } from "@/pages/public/CardVerify";
import { FrontPage } from "@/pages/public/landing/front";
import { OWN_PATH } from "@/pages/public/member-tabs";
import { PublicSite } from "@/pages/public/PublicSite";
import { LivePage } from "@/pages/public/live/LivePage";
import { Backdrop } from "./Backdrop";
import { ConnectionProvider, useConnection } from "./connection";
import { PushProvider } from "./push";
import {
  type AppView,
  appViewOf,
  type HistoryAction,
  isAppPageChange,
  opensInApp,
  startPageTransition,
} from "./page-transition";
import { createQueryClient } from "./query-client";
import type { AppRouter } from "./router";
import { type AuthState, checkVisitor, rememberVisitor, type Visitor } from "./visitor";
import {
  loginErrorMessage,
  SessionProvider,
  type SessionValue,
  loginErrorIn,
  isSameOrigin,
  wantsTokenLogin,
} from "./session";


/** Singing on the member's own (`/karaoke`): its screens and its audio, loaded when opened. */
const KaraokePage = lazy(() => import("@/pages/public/karaoke/KaraokePage"));

/** Her room (`/her`): a member alone with her, loaded when opened. */
const loadRoom = () => import("@/pages/public/room/RoomPage");
const LazyRoom = lazy(loadRoom);
type RoomProps = ComponentProps<typeof LazyRoom>;

let roomReady: ComponentType<RoomProps> | undefined;
let roomPending: Promise<void> | undefined;

/**
 * Fetches her room before a link opens it, so the page transition fades to the room itself rather
 * than to the empty frame of `Suspense`.
 */
function preloadRoom(): Promise<void> {
  roomPending ??= loadRoom().then(
    (m) => {
      roomReady = m.default;
    },
    (error: unknown) => {
      roomPending = undefined;
      throw error;
    },
  );
  return roomPending;
}

/** The room, drawn at once when it was fetched. Read once per mount, so it never remounts. */
function RoomPage(props: RoomProps) {
  const [Ready] = useState(() => roomReady);
  return Ready ? <Ready {...props} /> : <LazyRoom {...props} />;
}

/** The title `index.html` came with; a page that sets none of its own shows it. */
const FIRST_TITLE = typeof document === "undefined" ? "" : document.title;

/** The admin panel (shell, router, pages, event stream): only an admin downloads it. */
const AdminApp = lazy(() => import("./AdminApp"));

/** Where an admin signed in with Discord finds their own member page (its tabs are under it). */
export const OWN_PAGE = OWN_PATH;

/** The page's path and query from the history (`/card/MYR-…`, `/me`, `/login?error=…`). */
function pathOf(history: RouterHistory): string {
  const { pathname, search } = history.location;
  return `${pathname || "/"}${search}`;
}

/**
 * The address the page shows. It follows the history; a change of page `App` draws itself
 * (`isAppPageChange`) is shown inside a page transition, so the old page stays on screen until
 * the browser has its picture. `onPage(action)` runs for each such change, before it is shown.
 */
function useShownPath(history: RouterHistory, viewOf: (path: string) => AppView, onPage: (action: HistoryAction) => void) {
  const [path, setPath] = useState(() => pathOf(history));
  const shown = useRef(path);
  const latest = useRef({ viewOf, onPage });
  latest.current = { viewOf, onPage };

  useEffect(() => {
    const show = (next: string) => {
      shown.current = next;
      setPath(next);
    };
    // Whatever moved between the first render and this subscription.
    if (pathOf(history) !== shown.current) show(pathOf(history));
    return history.subscribe(({ action }) => {
      const from = shown.current;
      const to = pathOf(history);
      if (to === from) return;
      const { viewOf: view, onPage: page } = latest.current;
      if (!isAppPageChange(action.type, { path: from, view: view(from) }, { path: to, view: view(to) })) {
        show(to);
        return;
      }
      page(action.type);
      // The newest address when the update runs: a quicker second click skips this one.
      startPageTransition(() => show(pathOf(history)));
    });
  }, [history]);

  return path;
}

function OwnPage({
  onLogout,
  onBack,
  path,
  navigate,
}: {
  onLogout: () => void;
  onBack: () => void;
  path: string;
  navigate: (to: string, replace?: boolean) => void;
}) {
  const { api } = useConnection();
  const member = useQuery({ queryKey: ["member", "session"], queryFn: ({ signal }) => api.rpc.member.session(undefined, { signal }) });
  if (member.data) return <PublicSite member={member.data} onLogout={onLogout} onBack={onBack} path={path} navigate={navigate} />;
  return (
    <div className="flex min-h-svh items-center justify-center px-4">
      {member.isError ? (
        <div className="glass-float grid max-w-sm gap-3 rounded-lg p-5 text-sm">
          <p>沒辦法讀到你的頁面:{describeError(member.error)}</p>
          <Button variant="outline" onClick={onBack}>
            回到管理面板
          </Button>
        </div>
      ) : (
        <div className="min-h-svh" aria-busy="true" aria-label="讀取你的頁面中" />
      )}
    </div>
  );
}

function Authenticated({ router, history, initial }: { router?: AppRouter; history: RouterHistory; initial?: Visitor }) {
  const { config, api, signOut } = useConnection();
  const [auth, setAuth] = useState<AuthState>(() => initial?.auth ?? { status: "checking" });
  const [methods, setMethods] = useState<AuthMethods | null>(() => initial?.methods ?? null);
  // Already asked (by the landing page that handed over): the first check is not needed.
  const asked = useRef(initial !== undefined);
  const [tokenLogin, setTokenLogin] = useState(() => wantsTokenLogin(pathOf(history)));
  const [loginError, setLoginError] = useState<string | null>(() => loginErrorIn(pathOf(history)));
  const [recheck, setRecheck] = useState(0);
  const authRef = useRef(auth);
  authRef.current = auth;
  const tokenLoginRef = useRef(tokenLogin);
  tokenLoginRef.current = tokenLogin;
  const viewOf = useCallback((p: string) => appViewOf(p, authRef.current, tokenLoginRef.current), []);

  // A new page pushed starts at its top, as a loaded one does (the member area's tabs too).
  const toTop = useRef(false);
  const path = useShownPath(history, viewOf, (action) => {
    if (action === "PUSH") toTop.current = true;
  });
  const view = appViewOf(path, auth, tokenLogin);

  useLayoutEffect(() => {
    if (!toTop.current) return;
    toTop.current = false;
    if (window.scrollY > 0) window.scrollTo({ top: 0 });
  }, [path]);

  // Only the member area and the panel name the tab after their page; the others keep the site's.
  const firstView = useRef(true);
  useLayoutEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    if (FIRST_TITLE !== "") document.title = FIRST_TITLE;
  }, [view]);

  // A link between her pages that `App` can draw from what it knows opens in the page, so the
  // page transition goes from one page to the other (`opensInApp`). Anything else loads as before.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download")) return;
      if (link.target !== "" && link.target !== "_self") return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const from = pathOf(history);
      const to = `${url.pathname}${url.search}${url.hash}`;
      const toView = viewOf(to);
      if (!opensInApp({ path: from, view: viewOf(from) }, { path: to, view: toView })) return;
      e.preventDefault();
      if (toView !== "her") {
        history.push(to);
        return;
      }
      // Her room is a chunk of its own: fetched first, or the page loads as before if it cannot be.
      preloadRoom().then(
        () => history.push(to),
        () => window.location.assign(to),
      );
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [history, viewOf]);

  // Any 401 means the token changed or the session ended: back to the login screen.
  const [queryClient] = useState(() =>
    createQueryClient((error) => {
      if (!isApiError(error) || error.kind !== "unauthorized") return;
      const current = authRef.current;
      if (current.status === "public" && current.member !== null) {
        setAuth({ status: "public", member: null });
        return;
      }
      if (current.status !== "signed_in") return;
      setAuth({ status: "signed_out", reason: current.session.method === "discord" ? "expired" : "rejected" });
    }),
  );

  // Who are we? Asked on load and whenever the URL or token changes.
  useEffect(() => {
    if (asked.current) {
      asked.current = false;
      return;
    }
    const ctl = new AbortController();
    setAuth({ status: "checking" });
    void checkVisitor(api, config.token, ctl.signal).then((visitor) => {
      if (visitor === null) return;
      setMethods(visitor.methods);
      setAuth(visitor.auth);
    });
    return () => ctl.abort();
  }, [api, config.token, recheck]);

  // The next load shows the landing first only to someone not logged in.
  useEffect(() => rememberVisitor(auth), [auth]);

  // A new URL or token invalidates everything cached for the old one.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    queryClient.clear();
  }, [config.baseUrl, config.token, queryClient]);

  // A failed Discord login's `/login?error=…` is read once, then the address goes back to `/`, so
  // the router never sees the login path and a reload does not show the error again.
  useEffect(() => {
    if (loginErrorIn(path) !== null) history.replace("/");
  }, [path, history]);

  // `/login` is how the owner reaches the token form from a member's page.
  useEffect(() => {
    if (wantsTokenLogin(path)) setTokenLogin(true);
  }, [path]);

  const logout = useCallback(() => {
    const current = authRef.current;
    const method = current.status === "signed_in" ? current.session.method : current.status === "public" ? "discord" : "token";
    queryClient.clear();
    if (method === "discord") {
      void api
        .logout()
        .catch(() => undefined)
        .finally(() => setRecheck((n) => n + 1));
    } else {
      signOut();
    }
  }, [api, queryClient, signOut]);

  // The member area's tabs are addresses in the page (`/me/wallet`): the same history the router uses.
  const navigate = useCallback(
    (to: string, replace = false) => (replace ? history.replace(to) : history.push(to)),
    [history],
  );

  const sessionValue = useMemo<SessionValue | null>(
    () => (auth.status === "signed_in" ? { session: auth.session, logout } : null),
    [auth, logout],
  );

  // Which page: `appViewOf`, the one place that reads it from the address (page transitions too).
  const discordAdmin = auth.status === "signed_in" && auth.session.method === "discord";
  const member = auth.status === "public" ? auth.member : null;

  // A card's code leads here; anyone may check one, logged in or not.
  const serial = cardSerialIn(path);
  if (view === "card" && serial !== null) {
    return (
      <QueryClientProvider client={queryClient}>
        <CardVerify serial={serial} />
      </QueryClientProvider>
    );
  }

  // Her live page; anyone may watch, logged in or not.
  if (view === "watch") {
    return (
      <QueryClientProvider client={queryClient}>
        {/* Only a member's danmaku is pushed there (her state has its own live feed). */}
        <PushProvider audience="member">
          <LivePage />
        </PushProvider>
      </QueryClientProvider>
    );
  }

  if (view === "checking") {
    return <div className="min-h-svh" aria-busy="true" aria-label="確認登入狀態中" />;
  }

  // Singing, for someone logged in with Discord: a member, or an admin as a member. Anyone else
  // gets what `/` would show.
  if (view === "karaoke") {
    return (
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={<div className="min-h-svh" aria-busy="true" aria-label="讀取中" />}>
          <PushProvider audience="member">
            <KaraokePage member={member ?? undefined} home={discordAdmin ? OWN_PAGE : "/"} />
          </PushProvider>
        </Suspense>
      </QueryClientProvider>
    );
  }

  // Her room, for the same people as singing; anyone else gets what `/` would show.
  if (view === "her") {
    return (
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={<div className="min-h-svh" aria-busy="true" aria-label="讀取中" />}>
          <RoomPage member={member ?? undefined} home={discordAdmin ? OWN_PAGE : "/"} />
        </Suspense>
      </QueryClientProvider>
    );
  }

  // An admin who logged in with Discord is a member too, with a page of their own.
  if (view === "own") {
    return (
      <QueryClientProvider client={queryClient}>
        <PushProvider audience="member">
          <OwnPage onLogout={logout} onBack={() => history.push("/")} path={path} navigate={navigate} />
        </PushProvider>
      </QueryClientProvider>
    );
  }

  if (view === "member" && member !== null) {
    return (
      <QueryClientProvider client={queryClient}>
        <PushProvider audience="member">
          <PublicSite
            member={member}
            notice={loginError === null ? null : loginErrorMessage(loginError)}
            onLogout={logout}
            path={path}
            navigate={navigate}
          />
        </PushProvider>
      </QueryClientProvider>
    );
  }

  // Anyone else at the door sees her tank; the token form stays at `/login` for the owner.
  if (view === "front") {
    return (
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={<div className="min-h-svh" aria-busy="true" aria-label="讀取中" />}>
          <PushProvider audience="public">
            <FrontPage
              discord={(methods?.discord ?? false) && isSameOrigin(config.baseUrl)}
              notice={loginError === null ? null : loginErrorMessage(loginError)}
            />
          </PushProvider>
        </Suspense>
      </QueryClientProvider>
    );
  }

  if (view === "token" || !sessionValue) {
    return (
      <TokenGate
        rejected={auth.status === "signed_out" && auth.reason === "rejected"}
        expired={auth.status === "signed_out" && auth.reason === "expired"}
        discord={methods?.discord ?? false}
        error={loginError}
        // Someone at the door is most likely a member: the token form is for the owner.
        tokenOpen={tokenLogin || auth.status !== "public"}
        onSaved={() => {
          setLoginError(null);
          setTokenLogin(false);
          setRecheck((n) => n + 1);
        }}
      />
    );
  }

  return (
    <SessionProvider value={sessionValue}>
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={<div className="min-h-svh" aria-busy="true" aria-label="讀取中" />}>
          <AdminApp router={router} history={history} />
        </Suspense>
      </QueryClientProvider>
    </SessionProvider>
  );
}

/** `initial`: who the landing page found at the door before handing over. */
export function App({ router, initial }: { router?: AppRouter; initial?: Visitor }) {
  const [history] = useState(() => router?.history ?? createBrowserHistory());
  return (
    <ConnectionProvider>
      <TooltipProvider>
        <Backdrop />
        <Authenticated router={router} history={history} initial={initial} />
        <Toaster />
      </TooltipProvider>
    </ConnectionProvider>
  );
}
