// MUST stay as a direct import.meta.env read — NOT clientEnv. Vite replaces
// import.meta.env.VITE_GATEWERK_MODE with a string literal at build time,
// which lets the bundler dead-code-eliminate the `if (isCloud()) { lazy(() =>
// import("@ee/...")) }` branches across root.tsx, catchall.tsx, Layout.tsx,
// and ErrorBoundary.tsx. Routing through clientEnv (a runtime object created
// by createEnv()) defeats that DCE — it traces into ee/ and bloats the OSS
// bundle by ~340 KB (Supabase + posthog + Sentry/rrweb).
export function isCloud(): boolean {
  return import.meta.env.VITE_GATEWERK_MODE === "cloud";
}
