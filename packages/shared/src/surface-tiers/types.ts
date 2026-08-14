/**
 * surface-tiers/types — the classification vocabulary.
 *
 * Split out of one long file so each subsystem's table reads on its own. The
 * mechanism lives in ./index.ts; the tables live beside this file.
 */

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * The five classifications an axis can carry.
 *
 * The original tiering named three (`core` / `advanced` / `roadmap`). Two more
 * were forced by axes that genuinely fit none of them, and squeezing them into
 * three would have produced a dishonest public roadmap:
 *
 * - `request` exists because per-request inputs (`payload`, `idempotency_key`,
 *   `callback_url`, a reviewer's `feedback`) are the API contract, not controls
 *   anyone configures. Calling them `roadmap` would publish "payload" as an
 *   unbuilt feature; calling them `core` would claim a UI control that should
 *   not exist. Most, though not all, are set by the calling agent.
 * - `inert` exists because a handful of axes are settable, persisted, and
 *   change nothing — and the configuration-space spec explicitly rules that
 *   several of them must be neither deleted (§5.6, §5.8) nor wired (§5.7).
 *   They must not be promised on a roadmap, and they must not be surfaced.
 *
 * **RATIFIED**: five classifications stand. Moving any
 * axis between them is a one-line change here.
 */
export const SURFACE_TIERS = [
  "core",
  "advanced",
  "roadmap",
  "request",
  "inert",
] as const;
export type SurfaceTier = (typeof SURFACE_TIERS)[number];

/** The screens a human-facing control can live on. */
export const LAUNCH_SURFACES = [
  "template-editor",
  "chain-builder",
  "review-inbox",
  "share-link-dialog",
  "settings",
  "notes-page",
] as const;
export type LaunchSurface = (typeof LAUNCH_SURFACES)[number];

/**
 * A control a human sees at launch.
 *
 * `group` is the control group it belongs to. Groups are what the template
 * budget counts: "the editor exposes six things" is a statement about groups,
 * not about keys, because `name`+`slug` is one thing and so is
 * `timeout_seconds`+`timeout_action`.
 */
type SurfacedAxis = {
  tier: "core" | "advanced";
  surface: LaunchSurface;
  group: string;
  note?: string;
};

/**
 * A capability that works (or is planned) but is deliberately absent from the
 * launch UI.
 *
 * `feature` is REQUIRED and is the line that appears on the public roadmap.
 * Held features are named openly — a rule encoded so the
 * type checker enforces it: you cannot hold something back without saying
 * publicly what you are holding.
 *
 * `built` splits "built and held" from "not started". Those are different
 * promises and the public list keeps them apart.
 */
type RoadmapAxis = {
  tier: "roadmap";
  roadmap: { feature: string; built: boolean };
  note?: string;
};

/** A per-request input, set by the caller. Never a configuration control. */
type RequestAxis = {
  tier: "request";
  note?: string;
};

/**
 * Settable, persisted, and behaviourally does nothing. `note` is REQUIRED:
 * classifying something inert means asserting it has no reader, and that claim
 * has to carry its evidence.
 */
type InertAxis = {
  tier: "inert";
  note: string;
};

export type AxisDeclaration =
  | SurfacedAxis
  | RoadmapAxis
  | RequestAxis
  | InertAxis;
