import { describe, it, expect } from "vitest";
import { selectedIdFromParams } from "./History";

describe("selectedIdFromParams", () => {
  it("reads the entry id out of the query string", () => {
    expect(selectedIdFromParams(new URLSearchParams("entry=gw_rev_abc"))).toBe("gw_rev_abc");
  });

  it("returns null when nothing is selected, which is the list view", () => {
    expect(selectedIdFromParams(new URLSearchParams(""))).toBeNull();
  });

  it("treats an empty value as no selection, so ?entry= does not open a blank detail", () => {
    expect(selectedIdFromParams(new URLSearchParams("entry="))).toBeNull();
  });
});
