// Quiet-public mode: hides the cloud signup
// screen and its entry links pre-announcement. Flip to false at the
// announcement. Invite acceptance (/invite/:token) is NOT gated — invited
// teammates are not signups. Marketing-site twin: site/src/quiet-mode.ts
//
// Announcement-day restore procedure: flip this constant to false, run a
// full site build, and eyeball the landing page and /docs/quickstart. The
// quickstart sentence is authored in JSX inside an MDX gate; its raw .md
// export shows the JSX expression rather than plain markdown while the
// import line exists — known, accepted.
export const QUIET_MODE = true;
