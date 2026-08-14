/**
 * prefetch — starts a screen's queries at NAVIGATION time instead of after
 * the screen mounts (measured mount lag: 150-200ms after auth resolves).
 *
 * Three moments:
 *  - bootPrefetch: module scope of root.tsx, before React renders. Runs the
 *    shell badge queries and the landing route's queries in parallel with
 *    AuthProvider's getMe, collapsing the cold-load waterfall to one tier.
 *    OSS-only at this point in the lifecycle: it gates on isAuthenticated(),
 *    which reads the gatewerk_token key the OSS login path writes. Cloud
 *    sessions never write that key (see sessionPrefetch below).
 *  - sessionPrefetch: called once from the authed shell on mount (AppShell).
 *    In OSS this re-runs the same prefetch bootPrefetch already did — every
 *    call is staleTime-deduped, so the repeat costs nothing. In cloud this is
 *    the FIRST prefetch moment: the Supabase session token only becomes
 *    reachable (via cloudTokenGetter) after the cloud auth provider resolves,
 *    so module-scope boot cannot carry auth there — that's the gap this
 *    closes.
 *  - prefetchRoute: pointerenter/focus on nav links; by click time the
 *    target screen's data is already in flight or fresh. Also called by
 *    bootPrefetch and sessionPrefetch for the current pathname.
 *
 * Every call is a cache no-op when data is fresh (prefetchQuery respects
 * staleTime), and errors are swallowed by React Query; a 401 here behaves
 * exactly like getMe's own 401 (http.ts clears the token and bounces).
 */
import type { QueryClient } from "@tanstack/react-query";
import { isAuthenticated } from "@gatewerk/web-core/api/client/http";
import {
  noteTagsQuery,
  notesListQuery,
  projectSettingsQuery,
  routeQueries,
  shellQueries,
} from "~/route-queries";

// Set by sessionPrefetch once the authed shell has mounted — the one signal
// that works in both OSS (token in storage) and cloud (Supabase session
// resolved) modes. Until then, prefetchRoute falls back to isAuthenticated(),
// which is the only signal OSS has before the shell exists (hover/focus on
// the landing route, before AppShell's mount effect fires).
let sessionReady = false;

// Same four prefixes http.ts's 401 handler treats as public (never bounce to
// /login from these). bootPrefetch must not fire authenticated shell queries
// on a page that has no shell — see prefetch.test.ts.
const PUBLIC_PREFIXES = ["/login", "/auth/", "/invite/", "/r/"];

export function prefetchRoute(queryClient: QueryClient, pathname: string): void {
  if (!isAuthenticated() && !sessionReady) return;
  for (const q of routeQueries(pathname)) void queryClient.prefetchQuery(q);
  if (pathname.startsWith("/notes")) {
    // The one true data dependency: notes need the project id. fetchQuery
    // dedupes with the prefetch above (same key), so this costs nothing extra;
    // it just lets us chain the second tier as soon as the id exists.
    queryClient
      .fetchQuery(projectSettingsQuery)
      .then((project) => {
        void queryClient.prefetchQuery(notesListQuery(project.id));
        void queryClient.prefetchQuery(noteTagsQuery(project.id));
      })
      .catch(() => {
        // swallowed: the mounted screen owns error presentation
      });
  }
}

export function bootPrefetch(queryClient: QueryClient): void {
  try {
    // root.tsx module scope also runs during the build-time pre-render.
    if (typeof document === "undefined") return;
    if (!isAuthenticated()) return;
    const path = window.location.pathname;
    if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return;
    for (const q of shellQueries()) void queryClient.prefetchQuery(q);
    prefetchRoute(queryClient, path);
  } catch {
    // Module-scope side effect: storage access (sessionStorage/localStorage
    // via isAuthenticated -> getToken) can throw SecurityError under blocked-
    // storage policies (Safari "block all cookies", some embedded contexts).
    // This runs before React or its error boundary exist, so a throw here
    // would blank the app before hydration starts. Best-effort only.
  }
}

/**
 * Called once from the authed shell on mount (AppShell). Marks prefetching
 * "ready" independent of isAuthenticated() and re-runs the boot-equivalent
 * prefetch for the current route. See the module doc comment above.
 */
export function sessionPrefetch(queryClient: QueryClient): void {
  sessionReady = true;
  for (const q of shellQueries()) void queryClient.prefetchQuery(q);
  prefetchRoute(queryClient, window.location.pathname);
}
