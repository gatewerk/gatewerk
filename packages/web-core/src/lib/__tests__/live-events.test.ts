import { describe, it, expect } from "vitest";
import {
  backoffMs,
  eventKey,
  formatTabTitle,
  shouldShowToast,
  type DedupStorage,
  type LiveEvent,
} from "../live-events";

describe("backoffMs", () => {
  it("starts at 1s and doubles per attempt", () => {
    expect(backoffMs(0)).toBe(1000);
    expect(backoffMs(1)).toBe(2000);
    expect(backoffMs(2)).toBe(4000);
    expect(backoffMs(3)).toBe(8000);
    expect(backoffMs(4)).toBe(16000);
    expect(backoffMs(5)).toBe(30000); // 32000 clamped to 30000 default max
  });

  it("clamps growth at the 5th attempt before reaching max", () => {
    // Without max, 2^6 = 64s; we cap the exponent at 5 so it stays 32s.
    expect(backoffMs(6, 120_000)).toBe(32_000);
    expect(backoffMs(20, 120_000)).toBe(32_000);
  });

  it("respects the max ceiling", () => {
    expect(backoffMs(10)).toBe(30_000);
  });

  it("guards against negative input", () => {
    expect(backoffMs(-1)).toBe(1000);
  });
});

describe("eventKey", () => {
  const baseReview: LiveEvent = {
    type: "review.created",
    review_id: "gw_rev_abc",
    project_id: "gw_prj_1",
    template_slug: "refund",
    priority: "normal",
    created_at: "2026-04-24T00:00:00Z",
  };

  it("combines review_id, type, and created_at", () => {
    expect(eventKey(baseReview)).toBe("gw_rev_abc:review.created:2026-04-24T00:00:00Z");
  });

  it("produces distinct keys across event types for the same review", () => {
    const created = eventKey(baseReview);
    const decided = eventKey({ ...baseReview, type: "review.decided" });
    expect(created).not.toBe(decided);
  });

  it("returns a fixed key for the open frame", () => {
    expect(eventKey({ type: "open" })).toBe("open");
  });
});

describe("formatTabTitle", () => {
  it("returns base when count is zero", () => {
    expect(formatTabTitle("Gatewerk", 0)).toBe("Gatewerk");
  });

  it("prefixes the count when positive", () => {
    expect(formatTabTitle("Gatewerk", 7)).toBe("(7) Gatewerk");
  });

  it("caps the label at 99+ above 99", () => {
    expect(formatTabTitle("Gatewerk", 100)).toBe("(99+) Gatewerk");
    expect(formatTabTitle("Gatewerk", 5000)).toBe("(99+) Gatewerk");
  });

  it("treats negative counts as zero", () => {
    expect(formatTabTitle("Gatewerk", -3)).toBe("Gatewerk");
  });
});

describe("shouldShowToast", () => {
  function makeStorage(): DedupStorage & { store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
      store,
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
    };
  }

  it("returns true on first sighting and stamps the timestamp", () => {
    const s = makeStorage();
    expect(shouldShowToast("evt-1", s, 1_000)).toBe(true);
    expect(s.store.get("gw_toast:evt-1")).toBe("1000");
  });

  it("returns false if the key was written inside the TTL window", () => {
    const s = makeStorage();
    shouldShowToast("evt-1", s, 1_000);
    expect(shouldShowToast("evt-1", s, 1_000 + 2_000)).toBe(false);
  });

  it("returns true again once the TTL has elapsed", () => {
    const s = makeStorage();
    shouldShowToast("evt-1", s, 1_000);
    expect(shouldShowToast("evt-1", s, 1_000 + 6_000)).toBe(true);
  });

  it("fails open when storage throws (Safari private browsing case)", () => {
    const hostile: DedupStorage = {
      getItem: () => {
        throw new Error("QuotaExceeded");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    };
    expect(shouldShowToast("evt-1", hostile)).toBe(true);
  });

  it("handles corrupted stored timestamps gracefully", () => {
    const s = makeStorage();
    s.store.set("gw_toast:evt-1", "not-a-number");
    expect(shouldShowToast("evt-1", s, 10_000)).toBe(true);
  });
});
