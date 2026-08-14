import { describe, it, expect } from "vitest";
import { mergeTimeline, type NoteEntry } from "./ActivityThread";
import type { VersionRow } from "@gatewerk/web-core/api/reviews";

// Ported from apps/web's timeline-merge.test.ts: only the note/version merge
// behavior survives here. Audit-event normalization moved to the Settings
// Activity pane (see activity-logic.test.ts) and is no longer part of this
// thread.

function makeNote(overrides: Partial<NoteEntry> = {}): NoteEntry {
  return {
    kind: "note",
    id: "note-1",
    timestamp: "2026-05-10T11:00:00.000Z",
    author: "Alice",
    authorId: "user-1",
    content: "Check this out.",
    ...overrides,
  };
}

function makeVersion(overrides: Partial<VersionRow> = {}): VersionRow {
  return {
    id: "ver-1",
    review_id: "rev-1",
    version: 1,
    payload: { title: "My task" },
    feedback: null,
    created_at: "2026-05-10T10:00:00.000Z",
    ...overrides,
  };
}

describe("mergeTimeline", () => {
  it("returns an empty array when there is nothing to merge", () => {
    expect(mergeTimeline([], [], [])).toEqual([]);
  });

  it("skips version entries when only one version exists", () => {
    const result = mergeTimeline([], [makeVersion({ version: 1 })], []);
    expect(result.filter((e) => e.kind === "version")).toHaveLength(0);
  });

  it("includes version entries when multiple versions exist", () => {
    const versions = [
      makeVersion({ id: "v1", version: 1, created_at: "2026-05-10T09:00:00.000Z" }),
      makeVersion({ id: "v2", version: 2, created_at: "2026-05-10T10:00:00.000Z" }),
    ];
    const result = mergeTimeline([], versions, []);
    expect(result.filter((e) => e.kind === "version")).toHaveLength(2);
  });

  it("sorts entries chronologically, oldest first", () => {
    const versions = [
      makeVersion({ id: "v1", version: 1, created_at: "2026-05-10T08:00:00.000Z" }),
      makeVersion({ id: "v2", version: 2, created_at: "2026-05-10T10:00:00.000Z" }),
    ];
    const notes = [makeNote({ timestamp: "2026-05-10T09:00:00.000Z" })];
    const result = mergeTimeline(notes, versions, []);
    const timestamps = result.map((e) => e.timestamp);
    const sorted = [...timestamps].sort(
      (a, b) => new Date(a).getTime() - new Date(b).getTime(),
    );
    expect(timestamps).toEqual(sorted);
  });

  it("drops an optimistic entry once the server copy has arrived", () => {
    const serverNote = makeNote({ id: "server-1", content: "Same content" });
    const optimisticNote = makeNote({ id: "optimistic-1", content: "Same content" });
    const result = mergeTimeline([serverNote], [], [optimisticNote]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("server-1");
  });

  it("keeps an optimistic entry whose server copy has not arrived yet", () => {
    const optimisticNote = makeNote({ id: "optimistic-1", content: "Not yet synced" });
    const result = mergeTimeline([], [], [optimisticNote]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("optimistic-1");
  });
});
