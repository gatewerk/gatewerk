import { lazy, Suspense } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import { Loader2 } from "lucide-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ErrorBoundary as AppErrorBoundary } from "~/components/ErrorBoundary";
import { ThemeProvider } from "~/theme/ThemeProvider";
import { AuthProvider } from "@gatewerk/web-core/hooks/use-auth";
import { isCloud } from "@gatewerk/web-core/lib/cloud-mode";
import { bootPrefetch } from "~/prefetch";

// isCloud() reads import.meta.env.VITE_GATEWERK_MODE directly, so Vite folds it
// to a literal and Rollup deletes both branches below from a standalone build.
// Gating on a runtime env object instead would leave Supabase, Sentry and
// PostHog in the OSS bundle. See apps/web-next/ee/README.md.
if (isCloud()) {
  import("@ee/monitoring/sentry").then(m => m.initSentry()).catch(() => {});
  import("@ee/monitoring/posthog").then(m => m.initPostHog()).catch(() => {});
}

// Annotated rather than inferred. On a public clone the Cloud tree is absent
// and "@ee/*" falls back to the ambient declaration in ee-modules.d.ts, which
// types the module as `any` — and `any` does not survive React.lazy's generic,
// which collapses the props to IntrinsicAttributes and rejects the children
// below. Naming the one thing src/ actually requires of the Cloud provider
// fixes that, and when the submodule IS present this line is what checks the
// real component still satisfies it.
const CloudAuthWrapper: React.ComponentType<{ children: React.ReactNode }> | null = isCloud()
  ? lazy(() => import("@ee/auth/CloudAuthProvider").then(m => ({ default: m.CloudAuthProvider })))
  : null;

import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/hanken-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "~/theme/tokens.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: true, retry: 1 },
  },
});
bootPrefetch(queryClient);

export function Layout({ children }: { children: React.ReactNode }) {
  // theme-init.js sets the gw-light class on <html> before hydration, so the
  // class intentionally differs from the build-time pre-render; suppressHydrationWarning
  // silences that expected attribute mismatch (the standard theme-on-html pattern).
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="UTF-8" />
        <link rel="icon" type="image/svg+xml" href="/gatewerk.svg" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Gatewerk</title>
        <script src="/theme-init.js" />
        <Meta />
        <Links />
      </head>
      <body className="bg-page font-sans text-t2 antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function HydrateFallback() {
  return (
    <div className="grid h-screen place-items-center bg-page">
      <Loader2 size={24} className="animate-spin text-t6" />
    </div>
  );
}

export default function Root() {
  return (
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          {CloudAuthWrapper ? (
            <Suspense fallback={<HydrateFallback />}>
              <CloudAuthWrapper>
                <Outlet />
              </CloudAuthWrapper>
            </Suspense>
          ) : (
            <AuthProvider>
              <Outlet />
            </AuthProvider>
          )}
        </ThemeProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  );
}
