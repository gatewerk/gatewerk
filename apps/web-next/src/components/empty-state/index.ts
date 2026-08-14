/**
 * The four-tier empty-state system, rendered per the onboarding design's
 * Empty States board.
 *
 * Tier is chosen by what the USER did, not by which page they are on:
 *   T1  first run / genuinely zero data — tile, title, subtitle, one footer
 *   T2  a filter or search excluded everything — text only, one way back
 *   T3  detail pane, nothing selected — a resting state
 *   T4  an inline region inside a populated page — one dim sentence, in place,
 *       no component (it is a fact about one field, not a state of the page)
 *
 * Settings panes deliberately keep screens/templates/_ui.tsx's minimal
 * EmptyState: the board scopes itself to Inbox, History and Templates and puts
 * the Settings variants out of scope until those pages are designed.
 */

export { EmptyStateCore } from "./EmptyStateCore";
export { StatusPill } from "./StatusPill";
export { EmptyStateTier1, type Tier1Footer } from "./EmptyStateTier1";
export { EmptyStateTier2, SearchTerm } from "./EmptyStateTier2";
export { EmptyStateTier3 } from "./EmptyStateTier3";
