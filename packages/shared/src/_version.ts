// Hand-maintained mirror of packages/shared/package.json "version".
// Kept here (not read from JSON) so runtimes without import-assertions or
// package.json visibility (esbuild bundles, Bun with strict resolution) can
// still access it without extra build config. Update in lockstep with the
// package.json on each release.
export const VERSION = "0.1.0";
