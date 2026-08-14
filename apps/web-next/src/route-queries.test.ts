import { describe, expect, it } from "vitest";
import {
  routeQueries,
  shellQueries,
  inboxReviewsQuery,
  templatesQuery,
  projectSettingsQuery,
  notesListQuery,
  TEMPLATES_QUERY_KEY,
} from "./route-queries";

describe("route-queries catalog", () => {
  it("keys match the cache entries screens use today", () => {
    expect(inboxReviewsQuery.queryKey).toEqual(["reviews", "list", { limit: 100 }]);
    expect(templatesQuery.queryKey).toEqual(["templates"]);
    expect(TEMPLATES_QUERY_KEY).toEqual(["templates"]);
    expect(projectSettingsQuery.queryKey).toEqual(["settings", "project"]);
    expect(notesListQuery("gw_prj_x").queryKey).toEqual([
      "notes",
      "list",
      { project_id: "gw_prj_x", limit: 100 },
    ]);
  });

  it("maps the inbox route", () => {
    const keys = routeQueries("/").map((q) => q.queryKey);
    expect(keys).toContainEqual(["reviews", "list", { limit: 100 }]);
    expect(keys).toContainEqual(["notifications"]);
  });

  it("maps history, templates, notes and settings/project", () => {
    expect(routeQueries("/history").map((q) => q.queryKey)).toEqual([
      ["reviews", "history", "decided"],
      ["reviews", "history", "expired"],
    ]);
    expect(routeQueries("/templates").map((q) => q.queryKey)).toEqual([["templates"]]);
    // Notes maps only the project query; the id-dependent chain lives in prefetchRoute.
    expect(routeQueries("/notes").map((q) => q.queryKey)).toEqual([["settings", "project"]]);
    const settings = routeQueries("/settings/project").map((q) => q.queryKey);
    expect(settings).toContainEqual(["settings", "project"]);
    expect(settings).toContainEqual(["settings", "team"]);
    expect(settings).toContainEqual(["settings", "api-keys"]);
    expect(settings).toContainEqual(["settings", "webhooks"]);
    expect(settings).toContainEqual(["settings", "hmac-secret"]);
    expect(settings).toContainEqual(["templates"]);
  });

  it("returns nothing for unknown or public routes", () => {
    expect(routeQueries("/login")).toEqual([]);
    expect(routeQueries("/settings/account")).toEqual([]);
  });

  it("shell queries cover the badge pair", () => {
    expect(shellQueries().map((q) => q.queryKey)).toEqual([
      ["reviews", "pending"],
      ["notifications", "unread-count"],
    ]);
  });
});
