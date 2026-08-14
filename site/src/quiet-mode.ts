// Quiet-public mode: hides pricing and all
// cloud signin/signup CTAs pre-announcement. Flip to false at the
// announcement to restore everything. Product-UI twin:
// packages/web-core/src/lib/quiet-mode.ts
//
// Announcement-day restore procedure: flip this constant to false, run a
// full site build, and eyeball the landing page and /docs/quickstart. The
// quickstart sentence is authored in JSX inside an MDX gate; its raw .md
// export shows the JSX expression rather than plain markdown while the
// import line exists — known, accepted.
export const QUIET_MODE = true;
