import { lazy, Suspense, useEffect, useState } from "react";
import { Outlet } from "react-router";
import { Toaster } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { isCloud } from "@gatewerk/web-core/lib/cloud-mode";
import { useFaviconBadge } from "@gatewerk/web-core/hooks/use-favicon-badge";
import { pendingBadgeQuery } from "~/route-queries";
import { sessionPrefetch } from "~/prefetch";
import { IconRail } from "./IconRail";
import { NavDrawer } from "./NavDrawer";
import { useZen } from "./use-zen";
import { useNarrowViewport } from "./use-narrow-viewport";
import { MobileTabBar } from "./MobileTabBar";
import { initScrollReveal } from "~/theme/scroll-reveal";

const TrialBanner = isCloud()
  ? lazy(() => import("@ee/billing/TrialBanner").then((m) => ({ default: m.TrialBanner })))
  : null;

const ReadOnlyOverlay = isCloud()
  ? lazy(() => import("@ee/billing/ReadOnlyOverlay").then((m) => ({ default: m.ReadOnlyOverlay })))
  : null;

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { zen } = useZen();
  const narrow = useNarrowViewport();
  const queryClient = useQueryClient();

  // Scrollbars appear only while scrolling (see theme/scroll-reveal.ts).
  // In an effect because the listener needs a real document — SSR has none.
  useEffect(() => {
    initScrollReveal();
  }, []);

  // The authed shell existing at all is the one signal that works in both
  // OSS and cloud mode (see prefetch.ts doc comment) — in cloud this is the
  // first prefetch moment, since the Supabase token isn't reachable at
  // module scope. Mount-once: sessionPrefetch itself is staleTime-deduped.
  useEffect(() => {
    sessionPrefetch(queryClient);
  }, [queryClient]);

  // A dot on the favicon while anything is waiting on a person. Reviewers leave
  // this app in a background tab for hours, which is the whole reason the badge
  // exists: the tab strip is the only surface still visible to them.
  const { data: pending } = useQuery(pendingBadgeQuery);
  useFaviconBadge((pending?.total ?? 0) > 0);

  function openDrawer() {
    setDrawerOpen(true);
  }
  function closeDrawer() {
    setDrawerOpen(false);
  }

  // Outer column carries the cloud billing strips above the app row. The inner
  // wrapper keeps `relative` so NavDrawer's `absolute inset-0` still covers the
  // app, and `min-h-0` so it can shrink when a strip is present.
  return (
    <div
      className={`flex h-screen w-screen flex-col overflow-hidden bg-page font-sans text-t2 antialiased ${
        narrow ? "" : "min-w-[1120px]"
      }`}
    >
      {/* Billing state, not navigation chrome, so it survives zen mode: a
          reviewer who hid the rail still needs to know the trial ended.
          fallback={null} because a spinner in the slot of a banner that may not
          render at all would be worse than nothing. */}
      {(TrialBanner || ReadOnlyOverlay) && (
        <Suspense fallback={null}>
          {TrialBanner && <TrialBanner />}
          {ReadOnlyOverlay && <ReadOnlyOverlay />}
        </Suspense>
      )}

      <div className="relative flex min-h-0 flex-1">
      {/* Icon rail — hidden in zen mode, and absent on a phone where the
          bottom tab bar carries navigation instead. */}
      {!zen && !narrow && <IconRail onToggleDrawer={openDrawer} />}

      {/* Main content area — zen goes down through Outlet context so the list
          screens can collapse their list column with it, the same "z" that
          hides the rail above.

          The narrow cap is for tablets, not phones. Because the breakpoint is
          the desktop layout's own 1120px floor, "narrow" now covers everything
          up to a small laptop, and an 834px iPad given the full width spread
          the filter pills corner to corner across a column too wide to read.
          720 is a no-op on any phone, which is narrower than the cap. */}
      <main
        className={`min-w-0 flex-1 overflow-hidden ${
          narrow ? "mx-auto w-full max-w-[720px]" : ""
        }`}
      >
        <Outlet context={{ zen }} />
      </main>

      {/* Nav drawer — rendered over everything via absolute positioning. The
          drawer is a rail affordance and has no rail to open from on a
          phone. */}
      {!zen && !narrow && <NavDrawer open={drawerOpen} onClose={closeDrawer} />}
      </div>

      {narrow && <MobileTabBar />}

      {/* Toasts — bottom-center glass pill (prototype toast surface) */}
      <Toaster
        position="bottom-center"
        toastOptions={{
          style: {
            background: "rgba(var(--gw-glass-rgb),.72)",
            backdropFilter: "blur(22px) saturate(150%)",
            WebkitBackdropFilter: "blur(22px) saturate(150%)",
            border: "1px solid rgba(var(--gw-line-rgb),.15)",
            borderRadius: 11,
            boxShadow:
              "0 16px 44px rgba(0,0,0,.5), inset 0 1px 0 rgba(var(--gw-line-rgb),.1)",
            color: "var(--gw-t2)",
            fontSize: 13,
          },
        }}
      />
    </div>
  );
}
