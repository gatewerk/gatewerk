import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  // getDerivedStateFromError can't see the error object — only this can.
  // Without it, "Something went wrong" was the last anyone ever learned
  // about a crash; the real error and component stack never left the
  // browser, not even to its own console.
  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    console.error("[ErrorBoundary] Unhandled render error:", error, info.componentStack);

    // In cloud, the console is the user's, not ours: a render crash on the
    // hosted app is invisible without this. root.tsx initializes Sentry but
    // nothing reported to it until here.
    //
    // MUST stay a direct import.meta.env read, NOT clientEnv or isCloud()
    // imported for this alone — Vite replaces this literal at build time, which
    // is what dead-code-eliminates the dynamic import below out of the OSS
    // bundle. See apps/web-next/ee/README.md.
    if (import.meta.env.VITE_GATEWERK_MODE === "cloud" && error instanceof Error) {
      import("@ee/monitoring/sentry")
        .then((m) => m.captureException(error))
        .catch(() => {});
    }
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="grid h-screen place-items-center bg-page font-sans text-t3">
          Something went wrong. Reload to continue.
        </div>
      );
    }
    return this.props.children;
  }
}
