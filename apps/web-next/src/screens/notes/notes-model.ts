/**
 * Notes model — visibility filter, tag filter, search, date buckets, the
 * derived tag rail, and the write path shared by the two panes that write a
 * note.
 *
 * Design: Redesign.dc.html, Notes screen (rail item 4). Manifested against the
 * live prototype rather than read off the source.
 *
 * Two behaviours the prototype settles, and neither is guessable from a
 * screenshot: the tag filter is SINGLE select and toggles off when the active
 * tag is clicked again, and visibility ANDs with the tag rather than replacing
 * it. Private + a tag no note carries yields an empty screen, which is a state
 * the design has copy for.
 *
 * The write-path section at the bottom of this file is here rather than in the
 * two components because the rule it encodes — a note is written by ONE call
 * and its pins are attached by separate calls afterwards, so partial failure
 * is a normal outcome and never discards the note — has to hold identically
 * for NoteRestingPane's create and NoteDetail's edit. One helper, tested once.
 */

import type { Note, PatchNoteBody, PinNoteBody } from "@gatewerk/web-core/api/notes";
import { DATE_PRESETS } from "@gatewerk/web-core/lib/filter-dates";
import { timeAgo } from "@gatewerk/web-core/lib/utils";
import { bucketOf, type BucketKey } from "~/screens/history/history-model";
import type { SegmentedTab } from "~/components/SegmentedTabs";
import { THREAD_TAG } from "~/screens/inbox/detail/ActivityThread";
import { pinKindLabel, type PinTarget } from "./pin-picker-model";

export type Visibility = "all" | "shared" | "private";

export const VISIBILITY_TABS: readonly SegmentedTab<Visibility>[] = [
  { value: "all", label: "All" },
  { value: "shared", label: "Shared" },
  { value: "private", label: "Just me" },
];

export function filterByVisibility(notes: Note[], visibility: Visibility): Note[] {
  if (visibility === "all") return notes;
  const wantShared = visibility === "shared";
  return notes.filter((n) => n.is_shared === wantShared);
}

export function filterByTag(notes: Note[], tag: string | null): Note[] {
  if (!tag) return notes;
  return notes.filter((n) => n.tags.includes(tag));
}

/**
 * Every tag present on the notes, sorted, for the filter rail. Derived rather
 * than fetched: the rail must never offer a tag that filters to nothing, which
 * is what happens if it comes from the project-wide tag endpoint while the list
 * is paginated or scoped.
 *
 * Excludes THREAD_TAG: review replies never surface as a filterable tag, since
 * excludeThreadNotes already drops them from the shelf entirely.
 */
export function allTags(notes: Note[]): string[] {
  const seen = new Set<string>();
  for (const n of notes) for (const t of n.tags) if (t !== THREAD_TAG) seen.add(t);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** Single select: clicking the active tag clears it. */
export function toggleTag(current: string | null, clicked: string): string | null {
  return current === clicked ? null : clicked;
}

/**
 * Review replies are stored as notes carrying THREAD_TAG. They belong to the
 * review's activity thread, not to the shelf: without this the page fills with
 * chat. RailNotes applies the same exclusion.
 */
export function excludeThreadNotes(notes: Note[]): Note[] {
  return notes.filter((n) => !n.tags.includes(THREAD_TAG));
}

export function searchNotes(notes: Note[], query: string): Note[] {
  const q = query.trim().toLowerCase();
  if (!q) return notes;
  return notes.filter(
    (n) =>
      n.body.toLowerCase().includes(q) ||
      n.tags.some((t) => t.toLowerCase().includes(q)),
  );
}

export interface NotesDateFilter {
  preset: string | null;
  from: string;
  to: string;
  now: Date;
}

const NOTES_DATE_DAY_MS = 24 * 60 * 60 * 1000;

function localIsoOfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Date filter for the popover, mirroring history-model.ts's
 * matchesHistoryDate exactly — same preset day-counts off DATE_PRESETS, same
 * calendar-day-anchored from/to semantics — because the funnel popover's date
 * section is one filter language app-wide and a note's filter must not
 * quietly disagree with History's about what "Last 7 days" means.
 *
 * The one deliberate difference: History measures resolvedAt (when a
 * decision closed); a note has no such moment, so this measures created_at,
 * the same timestamp the rows and the TODAY/THIS WEEK/EARLIER buckets
 * (bucketNotes, above) already read. Using anything else would let a note
 * agree with one section header and disagree with the filter chip for it.
 */
export function matchesNotesDate(
  note: Note,
  preset: string | null,
  from: string,
  to: string,
  now: Date,
): boolean {
  if (!preset && !from && !to) return true;
  const t = new Date(note.created_at);
  if (Number.isNaN(t.getTime())) return false;
  if (preset) {
    // An unknown preset key degrades to "no filter" rather than emptying the
    // list, same rule as matchesHistoryDate: a chip this function was never
    // taught about must not silently hide every note.
    const days = DATE_PRESETS.find((p) => p.key === preset)?.days;
    if (days == null) return true;
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return t.getTime() >= startOfToday - (days - 1) * NOTES_DATE_DAY_MS;
  }
  const iso = localIsoOfDate(t);
  if (from && to) return iso >= from && iso <= to;
  if (from) return iso >= from;
  return iso <= to;
}

export function visibleNotes(
  notes: Note[],
  visibility: Visibility,
  tag: string | null,
  query: string,
  date?: NotesDateFilter,
): Note[] {
  const scoped = filterByTag(filterByVisibility(notes, visibility), tag);
  const dated = date
    ? scoped.filter((n) => matchesNotesDate(n, date.preset, date.from, date.to, date.now))
    : scoped;
  return searchNotes(dated, query);
}

/** One line for the row. A note is prose; the row is not. */
export function noteExcerpt(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/**
 * A first line longer than this reads as the start of a sentence, not a
 * heading — the exact number a note's optional heading turns on.
 */
export const NOTE_HEADING_MAX_LENGTH = 80;

export interface NoteHeadingSplit {
  /** null when the note has no heading — see splitNoteHeading's rule. */
  heading: string | null;
  /** The rest of the body. Equal to the original `body` verbatim when
   *  `heading` is null, so a caller that always renders `body` never has to
   *  branch to preserve today's rendering for a note with no heading. */
  body: string;
}

/**
 * Notes gain an OPTIONAL heading, derived from the body the same way
 * getReviewTitle (packages/web-core/src/lib/utils.ts:79-98) derives a
 * review's title from its payload rather than from a dedicated column —
 * there is no title column on `notes` (packages/db/src/schema/notes.ts) and
 * the ruling is not to add one.
 *
 * A note has a heading ONLY when BOTH hold:
 *  - its first non-empty line is short enough to read as a heading rather
 *    than the start of a paragraph (<= NOTE_HEADING_MAX_LENGTH characters —
 *    strictly longer is not a heading, it's just where the body starts);
 *  - there is more content after that line. A single paragraph, however
 *    short, is not "heading + body" — it's just a note, and gets no heading.
 *
 * Leading blank lines before the first real line are skipped rather than
 * counted against it (a note that opens with a blank line is not penalized
 * for it), and blank lines between the heading and the body that follows it
 * are trimmed from the returned `body` rather than kept as leading
 * whitespace.
 */
export function splitNoteHeading(body: string): NoteHeadingSplit {
  const lines = body.split("\n");

  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length) return { heading: null, body };

  const firstLine = lines[i];
  if (firstLine.length > NOTE_HEADING_MAX_LENGTH) return { heading: null, body };

  const restLines = lines.slice(i + 1);
  let j = 0;
  while (j < restLines.length && restLines[j].trim() === "") j++;
  const remainder = restLines.slice(j).join("\n");

  if (remainder.trim().length === 0) return { heading: null, body };

  return { heading: firstLine, body: remainder };
}

/**
 * The inverse of splitNoteHeading, for the composer's write path: reassembles
 * the separate Heading and Body fields into the single string `notes.body`
 * actually stores, since a heading is derived, never a column of its own
 * (this file's splitNoteHeading comment, and the ruling not to
 * add one).
 *
 * A blank heading (untyped, or whitespace only) is dropped entirely rather
 * than saved as an empty first line, so a note written with the field left
 * empty round trips through splitNoteHeading exactly as it did before this
 * field existed — `{heading: null, body}` for whatever the body field alone
 * held. A non blank heading becomes the first line, one blank line, then the
 * body — verified against splitNoteHeading directly in this file's test:
 * that blank line is what makes `restLines`' leading-blank skip land exactly
 * on the body content, so splitNoteHeading(combineNoteBody(h, b)) reconstructs
 * `{heading: h.trim(), body: b}` byte for byte.
 */
export function combineNoteBody(heading: string, body: string): string {
  const trimmedHeading = heading.trim();
  if (!trimmedHeading) return body;
  return `${trimmedHeading}\n\n${body}`;
}

/**
 * The header band's title (NoteDetailHeader.tsx) for a note that already
 * exists, mirroring getReviewTitle's own derivation
 * (packages/web-core/src/lib/utils.ts:79-98) instead of adding a title
 * column that doesn't exist. The title
 * always shows something — when the note has a heading by splitNoteHeading's
 * rule, that heading IS the title; otherwise the title is the note's own
 * first non-blank line. The header truncates it with CSS (`truncate`), the
 * same way HistoryDetail.tsx's own h1 truncates getReviewTitle's return
 * value, so this never slices the string itself.
 *
 * When there is no heading, the same first line the title shows also opens
 * the body below it — the exact duplication HistoryDetail.tsx's file comment
 * already accepts for getReviewTitle, not a new wart this round introduces.
 */
export function noteTitle(body: string): string {
  const split = splitNoteHeading(body);
  if (split.heading) return split.heading;
  const firstLine = body.split("\n").find((line) => line.trim() !== "");
  return firstLine ?? "";
}

/**
 * The header band's breadcrumb (NoteDetailHeader.tsx) for a note that
 * already exists, mirroring HistoryDetail.tsx's `template_slug / decided
 * Xago / vN` grammar: what the note is pinned to, then when it was created,
 * then the word "edited" when noteWasEdited is true. A note pinned to
 * nothing drops that segment instead of printing an empty one or the word
 * "none".
 *
 * The pinned segment names the first attachment's REAL title when the
 * caller has one to give it — `resolvedPinName`, resolved by NoteDetail.tsx
 * off the exact same `getReview`/`getTemplate` query NotePinCard.tsx already
 * runs for the rail's own pin card (same query key, so React Query shares
 * the one cache entry rather than firing a second request), so the header
 * does not disagree with the card three inches below it. Only ever the
 * FIRST attachment is named, so a note with several pins does not stack
 * several names into it — with a "+N" for every attachment after the
 * first, same grammar as NoteRow.tsx's own (unexported) pinSummary.
 *
 * `resolvedPinName` is undefined, and this falls back to the generic kind
 * label via pinKindLabel, in every case the caller does not (yet, or ever)
 * have a real name: still loading, the target no longer resolves, or a
 * chain run pin, which no client can resolve at all (NotePinCard.tsx's own
 * comment) — that fallback is what keeps the breadcrumb from ever flashing
 * a blank or wrong value while a name is in flight.
 */
export function noteBreadcrumbParts(note: Note, resolvedPinName?: string): string[] {
  const parts: string[] = [];
  if (note.attachments.length > 0) {
    const name = resolvedPinName ?? pinKindLabel(note.attachments[0].target_kind);
    const extra = note.attachments.length > 1 ? ` +${note.attachments.length - 1}` : "";
    parts.push(`pinned to ${name}${extra}`);
  }
  parts.push(`created ${timeAgo(note.created_at)}`);
  if (noteWasEdited(note)) parts.push("edited");
  return parts;
}

export type RailButtonState = "idle" | "disabled" | "hidden";
export type RailConfirmButtonState = "idle" | "loading" | "hidden";

export interface NoteDetailRailActions {
  edit: RailButtonState;
  delete: RailButtonState;
  cancel: "idle" | "hidden";
  confirmDelete: RailConfirmButtonState;
}

/**
 * Which of NoteDetailRail's four possible buttons (Edit, Delete, Cancel,
 * Confirm delete) render, and in what state, given whether Delete is armed
 * and whether the delete request is actually in flight.
 *
 * Armed shows Cancel + Confirm delete in place of Edit + Delete entirely
 * (fix round 1). Idle shows Edit + Delete — and BOTH stay disabled for the
 * whole in-flight window, not just Confirm delete.
 *
 * That "both" is fix round 2: `handleDeleteClick` disarms in the same
 * click that starts the delete, so the render right after clicking Confirm
 * delete is already the idle branch — for the entire time the request is
 * in flight. The idle Delete button had no pending guard of its own (only
 * the armed branch's Confirm delete did), so it stayed clickable through
 * that whole window: a fast enough re-click could re-arm and fire a second
 * delete for the same note. Edit gets the same guard for a different
 * reason — clicking Edit while a delete is in flight would swap this pane
 * into edit mode on a note that's about to be pulled out from under it the
 * instant the mutation resolves (NoteDetail.tsx's onDeleted callback
 * deselects the note unconditionally on success).
 *
 * Cancel needs no such guard: it only ever renders in the armed branch,
 * and armed always flips to false in the exact same click that starts a
 * delete, so Cancel and an in-flight delete never coexist in the same
 * render to begin with.
 */
export function noteDetailRailActions(armed: boolean, deleting: boolean): NoteDetailRailActions {
  if (armed) {
    return {
      edit: "hidden",
      delete: "hidden",
      cancel: "idle",
      confirmDelete: deleting ? "loading" : "idle",
    };
  }
  return {
    edit: deleting ? "disabled" : "idle",
    delete: deleting ? "disabled" : "idle",
    cancel: "hidden",
    confirmDelete: "hidden",
  };
}

// Labels mirror history-model.ts's BUCKET_LABEL, which is not exported from
// that module. bucketOf (the boundary logic itself) is exported and reused
// directly below rather than reinvented, per the product standard that
// History's date boundaries set.
const BUCKET_LABEL: Record<BucketKey, string> = {
  today: "TODAY",
  week: "THIS WEEK",
  earlier: "EARLIER",
};

/**
 * Partition notes into TODAY / THIS WEEK / EARLIER, newest first within each,
 * dropping any bucket that ends up empty so the list never renders a header
 * over nothing. Mirrors history-model.ts's bucketByDate, but keyed on
 * created_at rather than resolvedAt: the notes API orders by created_at desc,
 * and a note has no equivalent of a review's decided_at.
 */
export function bucketNotes(
  notes: Note[],
  now: Date,
): { key: string; label: string; items: Note[] }[] {
  const sorted = [...notes].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const groups: Record<BucketKey, Note[]> = { today: [], week: [], earlier: [] };
  for (const n of sorted) groups[bucketOf(n.created_at, now)].push(n);

  return (["today", "week", "earlier"] as const)
    .filter((k) => groups[k].length > 0)
    .map((k) => ({ key: k, label: BUCKET_LABEL[k], items: groups[k] }));
}

/** Author line: the current reviewer reads as "You", per the design. */
export function authorLabel(note: Note, currentUserId: string | undefined): string {
  if (currentUserId && note.author_id === currentUserId) return "You";
  return note.author_display_fallback ?? "Unknown";
}

/** Two-letter avatar monogram. "You" collapses to a single Y in the design. */
export function initials(label: string): string {
  if (label === "You") return "Y";
  const parts = label.split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * Whether a note has been edited since it was written.
 *
 * `created_at` and `updated_at` are both `defaultNow()`
 * (packages/db/src/schema/notes.ts:20-21) and Postgres evaluates now() once
 * per transaction, so an untouched row carries the two timestamps exactly
 * equal. PATCH is the only writer that moves `updated_at`
 * (apps/api/src/routes/notes/write.ts:190). Every note the detail pane
 * renders comes from the list query, i.e. straight from those columns.
 */
export function noteWasEdited(note: Note): boolean {
  return new Date(note.updated_at).getTime() !== new Date(note.created_at).getTime();
}

export interface NotesFilterState {
  visibility: Visibility;
  tag: string | null;
  query: string;
  datePreset: string | null;
  dateFrom: string;
  dateTo: string;
}

/**
 * The filter state to move to when a note has just been created, so the thing
 * the author wrote is always the thing they end up looking at.
 *
 * Notes.tsx resolves its selection against the FILTERED list. Selecting a
 * brand new note while a filter that excludes it was active resolved to
 * nothing at all: the resting pane stayed mounted with the entire draft still
 * in it, under a toast saying the note had been created, and pressing Create
 * note again wrote a second copy (fix round 2, Finding 2).
 *
 * Only the filters that would exclude the note are cleared. A tag filter the
 * new note happens to carry survives, because dropping a narrowing the author
 * chose and did not contradict would be its own small theft. The time filter
 * (added alongside the popover's date section) follows the same rule and the
 * same reason it was needed at all: a note written while an old date range
 * was still active would otherwise be saved and never shown, the exact class
 * of bug this function exists to close off.
 */
export function filtersForCreatedNote(
  note: Note,
  current: NotesFilterState,
  now: Date,
): NotesFilterState {
  const dateOk = matchesNotesDate(note, current.datePreset, current.dateFrom, current.dateTo, now);
  return {
    visibility:
      filterByVisibility([note], current.visibility).length > 0 ? current.visibility : "all",
    tag: filterByTag([note], current.tag).length > 0 ? current.tag : null,
    query: searchNotes([note], current.query).length > 0 ? current.query : "",
    datePreset: dateOk ? current.datePreset : null,
    dateFrom: dateOk ? current.dateFrom : "",
    dateTo: dateOk ? current.dateTo : "",
  };
}

// ── the write path ──────────────────────────────────────────────────────────

export type NoteWriteMode = "create" | "edit";

export interface NoteWriteOutcome {
  note: Note;
  toast: { kind: "success" | "error"; message: string };
}

/**
 * What a note write does once the note itself is on the server and its pin
 * calls have SETTLED. Shared by both writing paths: NoteRestingPane's create
 * and NoteDetail's edit (via applyNoteEdit below).
 *
 * The note is a fait accompli the instant its own call returns: it exists
 * whether or not any of its pins land. This function is the fix for fix round
 * 1's Finding 1 (an all-or-nothing `Promise.all` over the pin calls made a
 * single rejected pin discard a successfully written note). Callers must
 * invalidate, and leave the writing state, unconditionally once this function
 * is reached at all; it only decides what the user is TOLD, from the settled
 * pin results, never whether the note itself is kept.
 *
 * The verb differs by mode because the truth does: a create only ever
 * attaches pins, while an edit settles removals in the same batch.
 */
export function resolveNoteWriteOutcome(
  note: Note,
  pinSettlements: PromiseSettledResult<unknown>[],
  mode: NoteWriteMode,
): NoteWriteOutcome {
  const failedCount = pinSettlements.filter((r) => r.status === "rejected").length;
  if (failedCount === 0) {
    return {
      note,
      toast: { kind: "success", message: mode === "create" ? "Note created" : "Note saved" },
    };
  }
  const pinWord = failedCount === 1 ? "a pin" : `${failedCount} pins`;
  const verb = mode === "create" ? "attached" : "updated";
  return {
    note,
    toast: {
      kind: "error",
      message: `Note saved, but ${pinWord} could not be ${verb}.`,
    },
  };
}

/**
 * The subset of the notes client applyNoteEdit calls. Declared structurally so
 * the real `notes` object from @gatewerk/web-core satisfies it and a test can
 * pass three stubs without a module mock.
 */
export interface NoteWriteApi {
  patch: (id: string, input: PatchNoteBody) => Promise<unknown>;
  pin: (id: string, target: PinNoteBody) => Promise<unknown>;
  unpin: (id: string, attId: string) => Promise<unknown>;
}

/** The composer's result, structurally. Kept here so this module stays free of component imports. */
export interface NoteDraft {
  body: string;
  tags: string[];
  is_shared: boolean;
  pins: PinTarget[];
}

/**
 * The edit-path write, extracted out of NoteDetail.tsx so the partial-failure
 * rule can be tested without rendering the pane.
 *
 * `patch` carries `note.updated_at`, the optimistic concurrency token, so it
 * may be sent exactly once per read of the note. The pin adds and removals are
 * separate calls that run AFTER the patch has already landed, which is what
 * made an all-or-nothing `Promise.all` here actively harmful (fix round 2,
 * Finding 1): one rejected pin rejected the whole mutation, so the pane never
 * invalidated and never left edit mode, and the next Save sent the now-stale
 * token and got `stale_updated_at` back. That surfaces as "Someone else edited
 * this note. Refresh and try again." with nobody else involved, no refresh
 * control in the pane, and no way to save from it again.
 *
 * So: only a rejected `patch` may reject this function. Once the patch
 * resolves the pin calls are settled, never awaited together, and the caller
 * invalidates and leaves edit mode unconditionally.
 */
export async function applyNoteEdit(
  api: NoteWriteApi,
  note: Note,
  draft: NoteDraft,
): Promise<NoteWriteOutcome> {
  await api.patch(note.id, {
    body: draft.body,
    tags: draft.tags,
    is_shared: draft.is_shared,
    updated_at: note.updated_at,
  });

  const currentKeys = new Set(note.attachments.map((a) => `${a.target_kind}:${a.target_id}`));
  const nextKeys = new Set(draft.pins.map((p) => `${p.kind}:${p.id}`));
  const toAdd = draft.pins.filter((p) => !currentKeys.has(`${p.kind}:${p.id}`));
  const toRemove = note.attachments.filter((a) => !nextKeys.has(`${a.target_kind}:${a.target_id}`));

  const pinSettlements = await Promise.allSettled([
    ...toAdd.map((p) => api.pin(note.id, { target_kind: p.kind, target_id: p.id })),
    ...toRemove.map((a) => api.unpin(note.id, a.id)),
  ]);

  return resolveNoteWriteOutcome(note, pinSettlements, "edit");
}
