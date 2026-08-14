/**
 * Pure-logic tests for the project settings pane helpers. No DOM render — see
 * api-keys/_forms.test.ts header for why web-next tests avoid a render harness.
 */
import { describe, it, expect } from "vitest";
import type { ProjectSettings } from "@gatewerk/web-core/api/projects";
import { buildUpdatePayload, isProjectDirty, maskedHmacSecret, projectToForm } from "./project-logic";

const project: ProjectSettings = {
  id: "proj_1",
  name: "Acme",
  description: "Test project",
  webhook_url: null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
};

describe("projectToForm", () => {
  it("carries the description through unchanged", () => {
    expect(projectToForm(project)).toEqual({ name: "Acme", description: "Test project" });
  });

  it("maps a null description to an empty string", () => {
    expect(projectToForm({ ...project, description: null })).toEqual({ name: "Acme", description: "" });
  });
});

describe("isProjectDirty", () => {
  it("is false when the form matches the loaded project", () => {
    expect(isProjectDirty(projectToForm(project), project)).toBe(false);
  });

  it("is true when the name changed", () => {
    expect(isProjectDirty({ name: "Acme Inc", description: "Test project" }, project)).toBe(true);
  });

  it("is true when the description changed", () => {
    expect(isProjectDirty({ name: "Acme", description: "New" }, project)).toBe(true);
  });

  it("treats a null description as equal to an empty-string form value", () => {
    expect(isProjectDirty({ name: "Acme", description: "" }, { ...project, description: null })).toBe(false);
  });
});

describe("buildUpdatePayload", () => {
  it("sends the description as written", () => {
    expect(buildUpdatePayload({ name: "Acme", description: "Hi" })).toEqual({ name: "Acme", description: "Hi" });
  });

  it("omits an empty description rather than clearing it", () => {
    expect(buildUpdatePayload({ name: "Acme", description: "" })).toEqual({ name: "Acme", description: undefined });
  });
});

describe("maskedHmacSecret", () => {
  it("keeps the real prefix and masks the rest with a fixed run of bullets", () => {
    expect(maskedHmacSecret("whsec_")).toBe("whsec_••••••••••••••••••••••••");
  });
});
