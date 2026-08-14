import { describe, it, expect } from "vitest";
import { selectedNoteIdFromParams } from "./Notes";

describe("selectedNoteIdFromParams", () => {
  it("reads the note id out of the query string", () => {
    expect(selectedNoteIdFromParams(new URLSearchParams("note=gw_note_abc"))).toBe("gw_note_abc");
  });

  it("returns null when nothing is selected, which is the list view", () => {
    expect(selectedNoteIdFromParams(new URLSearchParams(""))).toBeNull();
  });

  it("treats an empty value as no selection, so ?note= does not open a blank detail", () => {
    expect(selectedNoteIdFromParams(new URLSearchParams("note="))).toBeNull();
  });
});
