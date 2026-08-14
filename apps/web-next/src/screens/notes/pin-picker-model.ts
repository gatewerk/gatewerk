/**
 * Pin picker model — pure functions behind PinPicker.tsx.
 *
 * PINS_MAX imports NOTE_ATTACHMENTS_MAX directly from @gatewerk/shared
 * rather than retyping the number, so a server cap change carries here
 * automatically (packages/shared/src/api/schemas/notes.ts).
 *
 * A note pins to a TEMPLATE only from this
 * picker. Review pinning is dropped from the UI — a note pinned to one
 * review is already better served by writing the note inside that review,
 * while a note pinned to a template rides along on every review the
 * template makes, which compounds. targetsFromLists therefore only ever
 * produces "template" targets now, and there is no more free-text search:
 * a workspace has few templates and many reviews, so the control became a
 * closed dropdown (PinPicker.tsx).
 *
 * "review" and "chain_run" stay in the PinTarget kind union, and kindLabel /
 * pinKindLabel keep naming them, on purpose: notes created through the API,
 * by agents, or before this ruling can already carry those pins, and
 * NoteDetail (via NotePinCard.tsx) and NoteRow must keep rendering them
 * correctly. Removing the kinds would break display of real data that
 * already exists. Chain runs were never offered by this picker even before
 * the ruling — no client in packages/web-core/src/api/ lists them.
 */
import { NOTE_ATTACHMENTS_MAX } from "@gatewerk/shared";
import { assertNever } from "@gatewerk/shared";
import type { Template } from "@gatewerk/web-core/api/templates";

export const PINS_MAX = NOTE_ATTACHMENTS_MAX;

export type PinTarget = {
  kind: "review" | "template" | "chain_run";
  id: string;
  label: string;
};

export function targetsFromLists(templates: Template[]): PinTarget[] {
  return templates.map((t) => ({ kind: "template", id: t.id, label: t.name }));
}

/**
 * Targets not already pinned. A template already carried in `pinned` must
 * not be offered again in the dropdown.
 */
export function availableTargets(targets: PinTarget[], pinned: PinTarget[]): PinTarget[] {
  return targets.filter((t) => !pinned.some((p) => p.kind === t.kind && p.id === t.id));
}

/**
 * Whether the picker's dropdown is actually visible on screen right now.
 * Single source of truth for two decisions in PinPicker.tsx that must never
 * disagree: whether to render the dropdown, and whether an Escape keypress
 * gets caught here (closing it) instead of bubbling out to the composer's
 * own Escape handling.
 */
export function pinDropdownVisible(open: boolean, isLoading: boolean): boolean {
  return open && !isLoading;
}

/**
 * The uppercase eyebrow over a pin card (NotePinCard.tsx). Deliberately NOT
 * the same function as pinKindLabel below: this one is a label on a card, that
 * one is a noun inside a sentence, and collapsing them would force one of the
 * two call sites to case-transform prose.
 */
export function kindLabel(kind: PinTarget["kind"]): string {
  switch (kind) {
    case "review":
      return "REVIEW";
    case "template":
      return "TEMPLATE";
    case "chain_run":
      return "CHAIN RUN";
    default:
      return assertNever(kind);
  }
}

/**
 * The same kind as lowercase prose, with its article, for use inside a
 * sentence: "on a review", "a template".
 *
 * One exported helper because there were two hand-maintained copies of this
 * list, in NoteRow.tsx and NoteComposer.tsx, that had to agree by inspection
 * (fix round 2, Finding 6). Neither can resolve a target's real name — the
 * row has no data to fetch with, and an existing note's attachments carry only
 * a kind and an id — so both fall back to naming the kind, and they must fall
 * back to the same words.
 */
export function pinKindLabel(kind: PinTarget["kind"]): string {
  switch (kind) {
    case "review":
      return "a review";
    case "template":
      return "a template";
    case "chain_run":
      return "a chain run";
    default:
      return assertNever(kind);
  }
}
