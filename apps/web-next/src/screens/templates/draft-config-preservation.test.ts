/**
 * The surface-tiering gate, carried into web-next's suite.
 *
 * The obligation it enforces: an operator who opens a template and changes
 * nothing but its name must not lose a single value they set over the API. It
 * caught two real data-corruption bugs, and web-next's Templates
 * screen hides MORE than apps/web's does — auto_approve, changes_timeout_hours,
 * allow_monitoring, default_auth_level and default_expiry_seconds are all off
 * screen here — so the guarantee matters more, not less.
 *
 * This re-runs the suite rather than copying it. Both apps save through the
 * same three seams (`draft-config-state`, `chain-editor-state`,
 * `action-editor-modal-state`), so a copy would be 400 lines with two places to
 * change and one of them silently going stale. Importing the file executes its
 * describe/it blocks inside this run: 13 cases, under web-next's own config and
 * module resolution.
 *
 * What it proves changed. It used to prove the uncomfortable
 * thing — that web-next's Templates logic lived in apps/web, so the cutover
 * would delete the screen's logic along with the app. The web-core extraction
 * removed that coupling: the seams now live in packages/web-core, which both
 * apps depend on and neither owns. So this import no longer marks a liability.
 * It asserts that web-next resolves the shared seams and gets the same 13
 * answers the package's own suite gets.
 */
import "@gatewerk/web-core/state/templates/detail/draft-config-preservation.test";
