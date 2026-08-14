/**
 * Pure-logic tests for the API keys form helpers. No DOM render — web-next has
 * no React render harness by design (see Settings.test.tsx header).
 */
import { describe, it, expect } from "vitest";
import { SCOPE_PRESETS } from "@gatewerk/shared";
import type { ApiKeyWithSecret } from "@gatewerk/web-core/api/api-keys";
import {
  apiKeyToForm,
  daysUntil,
  detectPreset,
  emptyKeyForm,
  formToCreateBody,
  formToUpdateBody,
  resolveExpiresAt,
  revealFromResult,
} from "./_forms";

const baseKey = {
  id: "key_1",
  name: "My agent",
  label: null,
  description: null,
  key_prefix: "gw_live_ab12",
  scopes: [...SCOPE_PRESETS.agent],
  template_ids: null,
  callback_url: null,
  default_reviewer: null,
  rate_limit_per_hour: null,
  is_active: true,
  last_used_at: null,
  created_at: "2026-08-01T00:00:00.000Z",
  expires_at: null,
  ip_allowlist: null,
};

describe("detectPreset", () => {
  it("null scopes read as legacy full access (admin)", () => {
    expect(detectPreset(null)).toBe("admin");
  });

  it("recognizes each preset regardless of order", () => {
    expect(detectPreset([...SCOPE_PRESETS.agent].reverse())).toBe("agent");
    expect(detectPreset([...SCOPE_PRESETS.reviewer].reverse())).toBe("reviewer");
    expect(detectPreset([...SCOPE_PRESETS.admin].reverse())).toBe("admin");
  });

  it("anything else is custom", () => {
    expect(detectPreset(["reviews:create"])).toBe("custom");
  });
});

describe("resolveExpiresAt", () => {
  it("never resolves to null (explicitly no expiry)", () => {
    expect(resolveExpiresAt({ ...emptyKeyForm(), expiration: "never" })).toBeNull();
  });

  it("custom with an empty date resolves to undefined so the field is skipped", () => {
    expect(resolveExpiresAt({ ...emptyKeyForm(), expiration: "custom", expiresAt: "" })).toBeUndefined();
  });

  it("custom with a date resolves to that UTC midnight", () => {
    expect(resolveExpiresAt({ ...emptyKeyForm(), expiration: "custom", expiresAt: "2027-01-02" })).toBe(
      "2027-01-02T00:00:00.000Z",
    );
  });

  it("30d resolves roughly 30 days out", () => {
    const iso = resolveExpiresAt({ ...emptyKeyForm(), expiration: "30d" });
    expect(iso).toBeTruthy();
    const days = (new Date(iso as string).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });
});

describe("apiKeyToForm round trip", () => {
  it("an unrestricted key maps to allTemplates with no ids", () => {
    const form = apiKeyToForm(baseKey);
    expect(form.allTemplates).toBe(true);
    expect(form.templateIds).toEqual([]);
    expect(form.scopePreset).toBe("agent");
  });

  it("a comma separated default_reviewer splits into chips", () => {
    const form = apiKeyToForm({ ...baseKey, default_reviewer: "a@x.com, b@x.com" });
    expect(form.defaultReviewers).toEqual(["a@x.com", "b@x.com"]);
  });
});

describe("payload builders", () => {
  it("create body sends null template_ids for allTemplates", () => {
    const body = formToCreateBody({ ...emptyKeyForm(), name: "k" });
    expect(body.template_ids).toBeNull();
    expect(body.name).toBe("k");
    expect(body.scopes).toEqual(SCOPE_PRESETS.agent);
  });

  it("create body omits expires_at when custom date is empty", () => {
    const body = formToCreateBody({ ...emptyKeyForm(), name: "k", expiration: "custom", expiresAt: "" });
    expect("expires_at" in body).toBe(false);
  });

  it("create body carries the ip allowlist when present", () => {
    const body = formToCreateBody({ ...emptyKeyForm(), name: "k", ipAllowlist: ["10.0.0.0/8"] });
    expect(body.ip_allowlist).toEqual(["10.0.0.0/8"]);
  });

  it("update body nulls cleared fields instead of omitting them", () => {
    const body = formToUpdateBody({ ...emptyKeyForm(), name: "k" });
    expect(body.callback_url).toBeNull();
    expect(body.rate_limit_per_hour).toBeNull();
    expect(body.default_reviewer).toBeNull();
  });
});

describe("revealFromResult", () => {
  it("passes a real secret through", () => {
    const result = { ...baseKey, raw_key: "gw_live_secret" } as ApiKeyWithSecret;
    expect(revealFromResult(result, "My agent")).toEqual({ rawKey: "gw_live_secret", name: "My agent" });
  });

  it("refuses a missing or empty secret — the defect that would render an empty reveal", () => {
    expect(revealFromResult({ ...baseKey, raw_key: "" } as ApiKeyWithSecret, "x")).toBeNull();
    expect(revealFromResult({ ...baseKey } as ApiKeyWithSecret, "x")).toBeNull();
  });
});

describe("daysUntil", () => {
  it("is negative for a past date", () => {
    expect(daysUntil("2020-01-01T00:00:00.000Z")).toBeLessThan(0);
  });
});
