import { describe, it, expect, vi } from "vitest";
import type { Note } from "@gatewerk/web-core/api/notes";
import {
  allTags,
  applyNoteEdit,
  authorLabel,
  bucketNotes,
  combineNoteBody,
  excludeThreadNotes,
  filterByTag,
  filterByVisibility,
  filtersForCreatedNote,
  initials,
  matchesNotesDate,
  noteBreadcrumbParts,
  noteDetailRailActions,
  noteExcerpt,
  noteTitle,
  noteWasEdited,
  resolveNoteWriteOutcome,
  searchNotes,
  splitNoteHeading,
  toggleTag,
  visibleNotes,
  type NoteWriteApi,
} from "./notes-model";

const NOW = new Date(2026, 7, 5, 10, 0, 0); // Wednesday 2026-08-05, 10:00

const note = (over: Partial<Note>): Note =>
  ({
    id: "note_1",
    project_id: "proj_1",
    author_id: "user_1",
    author_display_fallback: "Marta",
    body: "Refunds above 500 EUR go to Marta.",
    tags: [],
    is_shared: false,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
    attachments: [],
    ...over,
  }) as Note;

describe("excludeThreadNotes", () => {
  it("drops notes tagged thread", () => {
    const kept = note({ id: "keep", tags: ["policy"] });
    const reply = note({ id: "drop", tags: ["thread"] });
    expect(excludeThreadNotes([kept, reply]).map((n) => n.id)).toEqual(["keep"]);
  });

  it("keeps a note that merely mentions thread in its body", () => {
    const n = note({ id: "keep", body: "see the thread on review 8f21" });
    expect(excludeThreadNotes([n])).toHaveLength(1);
  });
});

describe("searchNotes", () => {
  it("matches the body case insensitively", () => {
    const n = note({ body: "Refunds above 500 EUR" });
    expect(searchNotes([n], "refund")).toHaveLength(1);
  });

  it("matches a tag", () => {
    const n = note({ tags: ["pricing"] });
    expect(searchNotes([n], "pric")).toHaveLength(1);
  });

  it("returns everything for an empty query", () => {
    const n = note({});
    expect(searchNotes([n], "   ")).toHaveLength(1);
  });
});

describe("visibleNotes", () => {
  it("ANDs visibility, tag and search", () => {
    const hit = note({ id: "hit", is_shared: true, tags: ["refunds"], body: "escalate" });
    const wrongTag = note({ id: "a", is_shared: true, tags: ["pricing"], body: "escalate" });
    const wrongVis = note({ id: "b", is_shared: false, tags: ["refunds"], body: "escalate" });
    const wrongText = note({ id: "c", is_shared: true, tags: ["refunds"], body: "unrelated" });
    const out = visibleNotes([hit, wrongTag, wrongVis, wrongText], "shared", "refunds", "escal");
    expect(out.map((n) => n.id)).toEqual(["hit"]);
  });

  it("ANDs the date filter in too, on top of visibility, tag and search", () => {
    const now = new Date(2026, 7, 5, 10, 0, 0); // Aug 5 2026, local
    const hit = note({
      id: "hit",
      is_shared: true,
      tags: ["refunds"],
      body: "escalate",
      created_at: now.toISOString(),
    });
    const oldEnough = note({
      id: "old",
      is_shared: true,
      tags: ["refunds"],
      body: "escalate",
      created_at: new Date(2026, 6, 1).toISOString(),
    });
    const out = visibleNotes([hit, oldEnough], "shared", "refunds", "escal", {
      preset: "today",
      from: "",
      to: "",
      now,
    });
    expect(out.map((n) => n.id)).toEqual(["hit"]);
  });

  it("omitting the date filter entirely still returns everything else matches", () => {
    const n = note({ id: "a", created_at: new Date(2019, 0, 1).toISOString() });
    expect(visibleNotes([n], "all", null, "")).toHaveLength(1);
  });
});

describe("matchesNotesDate", () => {
  // Mirrors history-model.test.ts's matchesHistoryDate suite: same preset
  // semantics, same calendar-day-anchored from/to, because the two date
  // filters are one language and must not quietly disagree.
  const now = new Date(2026, 7, 1, 12, 0); // Aug 1 2026 local noon
  const at = (d: Date) => note({ created_at: d.toISOString() });
  const yesterday2350 = new Date(2026, 6, 31, 23, 50);
  const today0005 = new Date(2026, 7, 1, 0, 5);

  it("no filter passes everything", () => {
    expect(matchesNotesDate(at(yesterday2350), null, "", "", now)).toBe(true);
  });

  it("'today' is the calendar day, not a rolling 24h", () => {
    expect(matchesNotesDate(at(today0005), "today", "", "", now)).toBe(true);
    expect(matchesNotesDate(at(yesterday2350), "today", "", "", now)).toBe(false);
  });

  it("'7d' spans today plus 6 prior days, boundary inclusive", () => {
    expect(matchesNotesDate(at(new Date(2026, 6, 26, 0, 0)), "7d", "", "", now)).toBe(true);
    expect(matchesNotesDate(at(new Date(2026, 6, 25, 23, 59)), "7d", "", "", now)).toBe(false);
  });

  it("measures created_at, the same timestamp the row and its bucket read", () => {
    // A note has no equivalent of a review's decided_at; unlike
    // matchesHistoryDate (which prefers decided_at), this must read
    // created_at directly or it would disagree with bucketNotes about which
    // bucket the note falls under.
    const n = note({ created_at: today0005.toISOString() });
    expect(matchesNotesDate(n, "today", "", "", now)).toBe(true);
  });

  it("custom range is inclusive on both local-date endpoints", () => {
    expect(matchesNotesDate(at(today0005), null, "2026-08-01", "2026-08-01", now)).toBe(true);
    expect(matchesNotesDate(at(yesterday2350), null, "2026-08-01", "2026-08-05", now)).toBe(false);
  });

  it("preset wins when both preset and range are set", () => {
    expect(matchesNotesDate(at(today0005), "today", "2020-01-01", "2020-01-02", now)).toBe(true);
  });

  it("an unknown preset key passes everything rather than emptying the list", () => {
    expect(matchesNotesDate(at(yesterday2350), "90d", "", "", now)).toBe(true);
    expect(matchesNotesDate(at(new Date(2019, 0, 1)), "90d", "", "", now)).toBe(true);
  });
});

describe("filterByVisibility", () => {
  const notes = [note({ id: "a", is_shared: true }), note({ id: "b", is_shared: false })];

  it("returns everything under all", () => {
    expect(filterByVisibility(notes, "all")).toHaveLength(2);
  });

  it("splits shared from private on is_shared", () => {
    expect(filterByVisibility(notes, "shared").map((n) => n.id)).toEqual(["a"]);
    expect(filterByVisibility(notes, "private").map((n) => n.id)).toEqual(["b"]);
  });
});

describe("filterByTag", () => {
  it("matches a tag anywhere in the list, not just the first", () => {
    const n = [note({ id: "a", tags: ["finance", "policy"] })];
    expect(filterByTag(n, "policy").map((x) => x.id)).toEqual(["a"]);
  });

  it("does not substring match", () => {
    // "fin" must not match "finance", or the rail would filter to surprises.
    expect(filterByTag([note({ tags: ["finance"] })], "fin")).toEqual([]);
  });
});

describe("bucketNotes", () => {
  it("splits today, this week and earlier, dropping empty buckets, in order", () => {
    const today = note({ id: "t", created_at: new Date(2026, 7, 5, 9).toISOString() });
    const thisWeek = note({ id: "w", created_at: new Date(2026, 7, 3, 14).toISOString() });
    const earlier = note({ id: "e", created_at: new Date(2026, 6, 1).toISOString() });
    const buckets = bucketNotes([today, thisWeek, earlier], NOW);
    expect(buckets.map((b) => b.label)).toEqual(["TODAY", "THIS WEEK", "EARLIER"]);
    expect(buckets[0].items.map((n) => n.id)).toEqual(["t"]);
    expect(buckets[1].items.map((n) => n.id)).toEqual(["w"]);
    expect(buckets[2].items.map((n) => n.id)).toEqual(["e"]);
  });
});

describe("allTags", () => {
  it("is sorted, deduped, and excludes the thread tag", () => {
    const a = note({ tags: ["policy", "refunds"] });
    const b = note({ tags: ["refunds", "thread"] });
    expect(allTags([a, b])).toEqual(["policy", "refunds"]);
  });
});

describe("toggleTag", () => {
  it("clears when the active tag is clicked again", () => {
    expect(toggleTag("refunds", "refunds")).toBeNull();
    expect(toggleTag("refunds", "policy")).toBe("policy");
  });
});

describe("authorLabel", () => {
  it("reads the current reviewer as You", () => {
    expect(authorLabel(note({ author_id: "rev_1" }), "rev_1")).toBe("You");
  });

  it("falls back to the display name for anyone else", () => {
    expect(
      authorLabel(note({ author_id: "rev_2", author_display_fallback: "Marcus Chen" }), "rev_1"),
    ).toBe("Marcus Chen");
  });

  it("does not claim You when the current user is unknown", () => {
    // An undefined current user must not make every note look self-authored.
    expect(
      authorLabel(note({ author_id: "rev_1", author_display_fallback: "Marcus Chen" }), undefined),
    ).toBe("Marcus Chen");
  });

  it("survives a deleted author with no fallback", () => {
    expect(authorLabel(note({ author_id: null, author_display_fallback: null }), "rev_1")).toBe(
      "Unknown",
    );
  });
});

describe("initials", () => {
  it("collapses You to a single letter, per the design", () => {
    expect(initials("You")).toBe("Y");
  });

  it("takes one letter from each of the first two words", () => {
    expect(initials("Marcus Chen")).toBe("MC");
    expect(initials("Dana Reyes")).toBe("DR");
  });

  it("handles an email address", () => {
    expect(initials("sam@example.com")).toBe("SE");
  });

  it("handles a single name and an empty string", () => {
    expect(initials("Prince")).toBe("PR");
    expect(initials("")).toBe("?");
  });
});

describe("noteExcerpt", () => {
  it("collapses newlines into one line", () => {
    expect(noteExcerpt("first line\n\nsecond line")).toBe("first line second line");
  });
});

describe("splitNoteHeading", () => {
  it("has no heading for a single paragraph, however short", () => {
    expect(splitNoteHeading("Refunds above 500 EUR go to Marta.")).toEqual({
      heading: null,
      body: "Refunds above 500 EUR go to Marta.",
    });
  });

  it("has no heading for an empty body", () => {
    expect(splitNoteHeading("")).toEqual({ heading: null, body: "" });
  });

  it("splits a short first line from the content that follows it", () => {
    expect(splitNoteHeading("Refund policy\nRefunds above 500 EUR go to Marta.")).toEqual({
      heading: "Refund policy",
      body: "Refunds above 500 EUR go to Marta.",
    });
  });

  it("trims blank lines between the heading and the body", () => {
    expect(splitNoteHeading("Refund policy\n\n\nRefunds above 500 EUR go to Marta.")).toEqual({
      heading: "Refund policy",
      body: "Refunds above 500 EUR go to Marta.",
    });
  });

  it("skips leading blank lines before looking for a heading", () => {
    expect(splitNoteHeading("\n\nRefund policy\nRefunds above 500 EUR go to Marta.")).toEqual({
      heading: "Refund policy",
      body: "Refunds above 500 EUR go to Marta.",
    });
  });

  it("does not treat a first line over 80 characters as a heading", () => {
    const longFirstLine = "R".repeat(81);
    const bodyText = `${longFirstLine}\nMore content below it.`;
    expect(splitNoteHeading(bodyText)).toEqual({ heading: null, body: bodyText });
  });

  it("still allows a first line at exactly 80 characters", () => {
    const eightyChars = "R".repeat(80);
    expect(splitNoteHeading(`${eightyChars}\nMore content below it.`)).toEqual({
      heading: eightyChars,
      body: "More content below it.",
    });
  });

  it("has no heading when the first line is short but nothing follows it", () => {
    // Trailing blank lines with no real content after them are the same as
    // no content at all — a single paragraph plus whitespace is still one
    // paragraph.
    expect(splitNoteHeading("Refund policy\n\n")).toEqual({
      heading: null,
      body: "Refund policy\n\n",
    });
  });
});

describe("combineNoteBody", () => {
  it("round trips through splitNoteHeading byte for byte", () => {
    const saved = combineNoteBody("Refund policy", "Refunds above 500 EUR go to Marta.");
    expect(splitNoteHeading(saved)).toEqual({
      heading: "Refund policy",
      body: "Refunds above 500 EUR go to Marta.",
    });
  });

  it("round trips a multi line body", () => {
    const saved = combineNoteBody("Refund policy", "Line one\nLine two");
    expect(splitNoteHeading(saved)).toEqual({ heading: "Refund policy", body: "Line one\nLine two" });
  });

  it("drops a blank heading rather than saving an empty first line", () => {
    expect(combineNoteBody("", "Refunds above 500 EUR go to Marta.")).toBe(
      "Refunds above 500 EUR go to Marta.",
    );
    expect(combineNoteBody("   ", "Refunds above 500 EUR go to Marta.")).toBe(
      "Refunds above 500 EUR go to Marta.",
    );
  });

  it("a blank heading round trips to no heading at all", () => {
    const saved = combineNoteBody("  ", "Refunds above 500 EUR go to Marta.");
    expect(splitNoteHeading(saved)).toEqual({
      heading: null,
      body: "Refunds above 500 EUR go to Marta.",
    });
  });
});

describe("noteTitle", () => {
  it("is the heading when the note has one", () => {
    expect(noteTitle("Refund policy\nRefunds above 500 EUR go to Marta.")).toBe("Refund policy");
  });

  it("is the first line when the note has no heading", () => {
    expect(noteTitle("Refunds above 500 EUR go to Marta.")).toBe("Refunds above 500 EUR go to Marta.");
  });

  it("skips leading blank lines to find the first line", () => {
    expect(noteTitle("\n\nRefunds above 500 EUR go to Marta.")).toBe(
      "Refunds above 500 EUR go to Marta.",
    );
  });
});

// noteBreadcrumbParts' "created" segment goes through timeAgo, which reads
// the real Date.now() with no injectable clock (packages/web-core/src/lib/
// utils.ts:8-9, unlike this file's own matchesNotesDate/bucketNotes, which
// both take `now` as a parameter for exactly this reason). Assertions below
// pin down everything except that segment's exact text, matching it with a
// loose regex instead of a real-clock-dependent literal.
describe("noteBreadcrumbParts", () => {
  it("drops the pinned segment when the note is pinned to nothing", () => {
    const n = note({ attachments: [] });
    const parts = noteBreadcrumbParts(n);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatch(/^created /);
  });

  it("names a single pin by kind", () => {
    const n = note({
      attachments: [
        { id: "a1", target_kind: "template", target_id: "t1", attached_by: null, attached_at: NOW.toISOString() },
      ],
    });
    expect(noteBreadcrumbParts(n)[0]).toBe("pinned to a template");
  });

  it("adds a +N for every attachment after the first", () => {
    const n = note({
      attachments: [
        { id: "a1", target_kind: "template", target_id: "t1", attached_by: null, attached_at: NOW.toISOString() },
        { id: "a2", target_kind: "review", target_id: "r1", attached_by: null, attached_at: NOW.toISOString() },
      ],
    });
    expect(noteBreadcrumbParts(n)[0]).toBe("pinned to a template +1");
  });

  // The pinned segment names the real record
  // (NoteDetail.tsx resolves it and hands it down), falling back to the
  // generic kind label only while unresolved.
  it("uses the resolved name when the caller has one", () => {
    const n = note({
      attachments: [
        { id: "a1", target_kind: "template", target_id: "t1", attached_by: null, attached_at: NOW.toISOString() },
      ],
    });
    expect(noteBreadcrumbParts(n, "Proposal Review")[0]).toBe("pinned to Proposal Review");
  });

  it("keeps the +N suffix on a resolved name", () => {
    const n = note({
      attachments: [
        { id: "a1", target_kind: "template", target_id: "t1", attached_by: null, attached_at: NOW.toISOString() },
        { id: "a2", target_kind: "review", target_id: "r1", attached_by: null, attached_at: NOW.toISOString() },
      ],
    });
    expect(noteBreadcrumbParts(n, "Proposal Review")[0]).toBe("pinned to Proposal Review +1");
  });

  it("falls back to the generic kind label while the name is unresolved", () => {
    const n = note({
      attachments: [
        { id: "a1", target_kind: "template", target_id: "t1", attached_by: null, attached_at: NOW.toISOString() },
      ],
    });
    expect(noteBreadcrumbParts(n, undefined)[0]).toBe("pinned to a template");
  });

  it("adds the word edited only once updated_at has moved past created_at", () => {
    const created = new Date(2026, 6, 1).toISOString();
    const untouched = note({ created_at: created, updated_at: created });
    expect(noteBreadcrumbParts(untouched)).not.toContain("edited");

    const edited = note({ created_at: created, updated_at: new Date(2026, 7, 5).toISOString() });
    expect(noteBreadcrumbParts(edited)).toContain("edited");
  });
});

describe("noteDetailRailActions", () => {
  it("idle, not deleting: Edit and Delete enabled, Cancel/Confirm delete hidden", () => {
    expect(noteDetailRailActions(false, false)).toEqual({
      edit: "idle",
      delete: "idle",
      cancel: "hidden",
      confirmDelete: "hidden",
    });
  });

  it("armed, not deleting: Cancel and Confirm delete enabled, Edit/Delete hidden", () => {
    expect(noteDetailRailActions(true, false)).toEqual({
      edit: "hidden",
      delete: "hidden",
      cancel: "idle",
      confirmDelete: "idle",
    });
  });

  it("armed and deleting: Confirm delete shows loading, Cancel still enabled", () => {
    expect(noteDetailRailActions(true, true)).toEqual({
      edit: "hidden",
      delete: "hidden",
      cancel: "idle",
      confirmDelete: "loading",
    });
  });

  // Fix round 2 regression test. `handleDeleteClick` disarms in the SAME
  // click that starts the delete (NoteDetailRail.tsx), so the render right
  // after confirming is already this idle branch — for the entire in-flight
  // window, however long that turns out to be. Before the fix, `deleting`
  // was ignored here entirely and both buttons stayed "idle" (fully
  // clickable) the whole time, which is exactly what let a fast enough
  // second click re-arm and fire a second delete for the same note. This
  // must fail for a rendered-and-clickable reason, not a missing-prop one —
  // it asserts the STATE the idle Delete button would render with is
  // "disabled", the same value that makes ActionButton refuse the click
  // (ActionButton.tsx: isDisabled = state === "disabled" || "loading").
  it("idle but still deleting: Edit and Delete both disabled, not just hidden Confirm delete", () => {
    expect(noteDetailRailActions(false, true)).toEqual({
      edit: "disabled",
      delete: "disabled",
      cancel: "hidden",
      confirmDelete: "hidden",
    });
  });
});

describe("noteWasEdited", () => {
  it("is false for a note nobody has patched", () => {
    // Both columns are defaultNow() and Postgres evaluates now() once per
    // transaction, so an untouched row carries them exactly equal.
    const t = new Date(2026, 7, 1).toISOString();
    expect(noteWasEdited(note({ created_at: t, updated_at: t }))).toBe(false);
  });

  it("is true once updated_at has moved past created_at", () => {
    const n = note({
      created_at: new Date(2026, 6, 1).toISOString(),
      updated_at: new Date(2026, 7, 5).toISOString(),
    });
    expect(noteWasEdited(n)).toBe(true);
  });
});

describe("filtersForCreatedNote", () => {
  // fix round 2, Finding 2: Notes.tsx resolves its selection against the
  // FILTERED list, so a filter that excludes the new note left the selection
  // unresolvable — the resting pane kept the whole draft on screen under a
  // toast saying the note had been created.
  const now = new Date(2026, 7, 5, 10, 0, 0); // Aug 5 2026, local
  const active = {
    visibility: "shared",
    tag: "refunds",
    query: "escalate",
    datePreset: "today",
    dateFrom: "",
    dateTo: "",
  } as const;

  it("clears every filter that would hide the note just written, date range included", () => {
    // Wrong visibility, tag, text AND written outside "today" — every one of
    // the four filters would have hidden it.
    const created = note({
      id: "new",
      is_shared: false,
      tags: ["pricing"],
      body: "unrelated",
      created_at: new Date(2026, 6, 1).toISOString(),
    });
    expect(filtersForCreatedNote(created, active, now)).toEqual({
      visibility: "all",
      tag: null,
      query: "",
      datePreset: null,
      dateFrom: "",
      dateTo: "",
    });
  });

  it("keeps the filters the new note already satisfies, including the date range", () => {
    const created = note({
      id: "new",
      is_shared: true,
      tags: ["refunds"],
      body: "escalate to Marta",
      created_at: now.toISOString(),
    });
    expect(filtersForCreatedNote(created, active, now)).toEqual(active);
  });

  it("clears only the date range when that is the one filter that excludes it", () => {
    // Right visibility, tag and text; written a month before the active
    // "today" preset. THE FIX this covers: without clearing datePreset here,
    // a note created while an old date range was active would be saved and
    // then never appear — the exact bug already
    // found and fixed once for the other filters.
    const created = note({
      id: "new",
      is_shared: true,
      tags: ["refunds"],
      body: "escalate to Marta",
      created_at: new Date(2026, 6, 1).toISOString(),
    });
    expect(filtersForCreatedNote(created, active, now)).toEqual({
      visibility: "shared",
      tag: "refunds",
      query: "escalate",
      datePreset: null,
      dateFrom: "",
      dateTo: "",
    });
  });

  it("clears only what actually excludes, never the rest", () => {
    // Private note, right tag, right text, right date: only the visibility
    // tab is wrong.
    const created = note({
      id: "new",
      is_shared: false,
      tags: ["refunds"],
      body: "escalate to Marta",
      created_at: now.toISOString(),
    });
    expect(filtersForCreatedNote(created, active, now)).toEqual({
      visibility: "all",
      tag: "refunds",
      query: "escalate",
      datePreset: "today",
      dateFrom: "",
      dateTo: "",
    });
  });

  it("always leaves the new note visible, whatever the filters were", () => {
    const created = note({
      id: "new",
      is_shared: false,
      tags: [],
      body: "a fresh thought",
      created_at: new Date(2019, 0, 1).toISOString(),
    });
    for (const v of ["all", "shared", "private"] as const) {
      const next = filtersForCreatedNote(
        created,
        { visibility: v, tag: "policy", query: "zzz", datePreset: "today", dateFrom: "", dateTo: "" },
        now,
      );
      expect(
        visibleNotes([created], next.visibility, next.tag, next.query, {
          preset: next.datePreset,
          from: next.dateFrom,
          to: next.dateTo,
          now,
        }),
      ).toHaveLength(1);
    }
  });
});

describe("resolveNoteWriteOutcome", () => {
  const n = note({ id: "n1" });

  it("reports success and keeps the note when every pin lands", () => {
    const out = resolveNoteWriteOutcome(
      n,
      [
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ],
      "create",
    );
    expect(out.note).toBe(n);
    expect(out.toast).toEqual({ kind: "success", message: "Note created" });
  });

  it("reports success when there were no pins to attach at all", () => {
    expect(resolveNoteWriteOutcome(n, [], "create").toast.kind).toBe("success");
  });

  it("says saved rather than created on the edit path", () => {
    expect(resolveNoteWriteOutcome(n, [], "edit").toast).toEqual({
      kind: "success",
      message: "Note saved",
    });
  });

  it("keeps the note and reports a single failed pin, never discarding it", () => {
    // fix round 1, Finding 1: the note already exists on the server the
    // moment notes.create resolves. A rejected pin must never make the note
    // disappear (the old Promise.all-based mutation rejected the whole
    // create on any pin failure, so the UI never invalidated or selected a
    // note that had, in fact, been written, and a retry duplicated it).
    const out = resolveNoteWriteOutcome(
      n,
      [
        { status: "fulfilled", value: undefined },
        { status: "rejected", reason: new Error("nope") },
      ],
      "create",
    );
    expect(out.note).toBe(n);
    expect(out.toast).toEqual({
      kind: "error",
      message: "Note saved, but a pin could not be attached.",
    });
  });

  it("pluralizes the message when more than one pin fails", () => {
    const out = resolveNoteWriteOutcome(
      n,
      [
        { status: "rejected", reason: new Error("a") },
        { status: "rejected", reason: new Error("b") },
      ],
      "create",
    );
    expect(out.note).toBe(n);
    expect(out.toast).toEqual({
      kind: "error",
      message: "Note saved, but 2 pins could not be attached.",
    });
  });

  it("does not claim a failed removal was an attachment", () => {
    // An edit settles unpins in the same batch, so "could not be attached"
    // would be a lie about half the calls it covers.
    const out = resolveNoteWriteOutcome(n, [{ status: "rejected", reason: new Error("x") }], "edit");
    expect(out.toast).toEqual({
      kind: "error",
      message: "Note saved, but a pin could not be updated.",
    });
  });
});

describe("applyNoteEdit", () => {
  const existing = note({
    id: "n1",
    updated_at: new Date(2026, 7, 5, 9).toISOString(),
    attachments: [
      { id: "pin_old", target_kind: "template", target_id: "tpl_1" },
    ] as Note["attachments"],
  });

  const draft = {
    body: "revised body",
    tags: ["refunds"],
    is_shared: false,
    pins: [
      { kind: "review" as const, id: "rev_1", label: "a review" },
      { kind: "review" as const, id: "rev_2", label: "a review" },
    ],
  };

  function stubApi(over: Partial<NoteWriteApi> = {}): NoteWriteApi {
    return {
      patch: vi.fn().mockResolvedValue(undefined),
      pin: vi.fn().mockResolvedValue({ id: "pin_new" }),
      unpin: vi.fn().mockResolvedValue(undefined),
      ...over,
    };
  }

  it("sends the concurrency token off the note it read, exactly once", async () => {
    const api = stubApi();
    await applyNoteEdit(api, existing, draft);
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledWith("n1", {
      body: "revised body",
      tags: ["refunds"],
      is_shared: false,
      updated_at: existing.updated_at,
    });
  });

  it("adds only the pins that are new and removes only the ones dropped", async () => {
    const api = stubApi();
    await applyNoteEdit(api, existing, draft);
    expect(api.pin).toHaveBeenCalledTimes(2);
    expect(api.pin).toHaveBeenCalledWith("n1", { target_kind: "review", target_id: "rev_1" });
    expect(api.unpin).toHaveBeenCalledTimes(1);
    expect(api.unpin).toHaveBeenCalledWith("n1", "pin_old");
    expect(api.pin).not.toHaveBeenCalledWith("n1", { target_kind: "template", target_id: "tpl_1" });
  });

  it("resolves, so the pane leaves edit mode, when a pin 404s after the patch landed", async () => {
    // THE FIX (fix round 2, Finding 1). Under the old Promise.all this call
    // REJECTED even though the patch had already succeeded: onError fired,
    // the queries were never invalidated and the pane never left edit mode,
    // so it kept the now-stale note.updated_at. The next Save sent that stale
    // token, the server answered stale_updated_at, and the app said "Someone
    // else edited this note. Refresh and try again." with nobody else
    // involved and no refresh control in the pane to escape it.
    const api = stubApi({
      pin: vi
        .fn()
        .mockRejectedValueOnce(new Error("target_not_found"))
        .mockResolvedValue({ id: "pin_new" }),
    });

    const outcome = await applyNoteEdit(api, existing, draft);

    expect(outcome.note).toBe(existing);
    expect(outcome.toast).toEqual({
      kind: "error",
      message: "Note saved, but a pin could not be updated.",
    });
    // The patch is not retried, and the surviving pin is not re-sent.
    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.pin).toHaveBeenCalledTimes(2);
  });

  it("still settles every remaining pin call when one of them rejects", async () => {
    const api = stubApi({
      pin: vi.fn().mockRejectedValue(new Error("target_not_found")),
    });
    const outcome = await applyNoteEdit(api, existing, draft);
    expect(outcome.toast).toEqual({
      kind: "error",
      message: "Note saved, but 2 pins could not be updated.",
    });
    // The removal is not abandoned because the additions failed.
    expect(api.unpin).toHaveBeenCalledTimes(1);
  });

  it("rejects when the patch itself fails, so only that reaches onError", async () => {
    const api = stubApi({ patch: vi.fn().mockRejectedValue(new Error("stale_updated_at")) });
    await expect(applyNoteEdit(api, existing, draft)).rejects.toThrow("stale_updated_at");
    // No pin touched: there is no note state to reconcile against.
    expect(api.pin).not.toHaveBeenCalled();
    expect(api.unpin).not.toHaveBeenCalled();
  });
});
