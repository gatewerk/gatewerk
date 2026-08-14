/**
 * NotificationsPane.test.ts — pure-logic tests for notification preference helpers.
 *
 * web-next has no React-render test harness (@testing-library/react) and no MSW.
 * All tests here verify pure functions only — no DOM render, no fetch.
 *
 * Covered:
 *   - toggleChannel: immutability, correct cell flip, only targeted cell changes
 *   - setDigestEnabled: immutability, boolean flip
 *   - setDigestAt: immutability, at field update
 *   - setQuietHours: set and clear
 *   - setTimezone: set and clear
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_NOTIFICATION_PREFS } from "@gatewerk/shared";
import {
  toggleChannel,
  setDigestEnabled,
  setDigestAt,
  setQuietHours,
  setTimezone,
  categoryLabel,
  categoryHelper,
} from "./notification-prefs-logic";

// ── toggleChannel ────────────────────────────────────────────────────────────

describe("toggleChannel", () => {
  it("flips email on → off for oversight", () => {
    // Default: oversight.email = true
    const result = toggleChannel(DEFAULT_NOTIFICATION_PREFS, "oversight", "email");
    expect(result.channels.oversight.email).toBe(false);
  });

  it("flips email off → on for workspace", () => {
    // Default: workspace.email = false
    const result = toggleChannel(DEFAULT_NOTIFICATION_PREFS, "workspace", "email");
    expect(result.channels.workspace.email).toBe(true);
  });

  it("flips slack off → on", () => {
    // Default: oversight.slack = false
    const result = toggleChannel(DEFAULT_NOTIFICATION_PREFS, "oversight", "slack");
    expect(result.channels.oversight.slack).toBe(true);
  });

  it("does NOT mutate the original prefs object", () => {
    const original = DEFAULT_NOTIFICATION_PREFS;
    const before = original.channels.oversight.email;
    toggleChannel(original, "oversight", "email");
    // The original must be unchanged
    expect(original.channels.oversight.email).toBe(before);
  });

  it("only changes the targeted cell — other categories unchanged", () => {
    const result = toggleChannel(DEFAULT_NOTIFICATION_PREFS, "oversight", "email");
    // my_activity.email must still be as in defaults
    expect(result.channels.my_activity.email).toBe(
      DEFAULT_NOTIFICATION_PREFS.channels.my_activity.email,
    );
    expect(result.channels.workspace.email).toBe(
      DEFAULT_NOTIFICATION_PREFS.channels.workspace.email,
    );
    expect(result.channels.updates.email).toBe(
      DEFAULT_NOTIFICATION_PREFS.channels.updates.email,
    );
  });

  it("only changes the targeted channel — other channel in same category unchanged", () => {
    const result = toggleChannel(DEFAULT_NOTIFICATION_PREFS, "oversight", "email");
    // slack in the same category must be unchanged
    expect(result.channels.oversight.slack).toBe(
      DEFAULT_NOTIFICATION_PREFS.channels.oversight.slack,
    );
  });

  it("double toggle returns to original value", () => {
    const once = toggleChannel(DEFAULT_NOTIFICATION_PREFS, "my_activity", "email");
    const twice = toggleChannel(once, "my_activity", "email");
    expect(twice.channels.my_activity.email).toBe(
      DEFAULT_NOTIFICATION_PREFS.channels.my_activity.email,
    );
  });
});

// ── setDigestEnabled ─────────────────────────────────────────────────────────

describe("setDigestEnabled", () => {
  it("enables the digest", () => {
    const result = setDigestEnabled(DEFAULT_NOTIFICATION_PREFS, true);
    expect(result.digest.enabled).toBe(true);
  });

  it("disables the digest", () => {
    const enabled = setDigestEnabled(DEFAULT_NOTIFICATION_PREFS, true);
    const disabled = setDigestEnabled(enabled, false);
    expect(disabled.digest.enabled).toBe(false);
  });

  it("does not mutate the original", () => {
    const original = DEFAULT_NOTIFICATION_PREFS;
    const before = original.digest.enabled;
    setDigestEnabled(original, !before);
    expect(original.digest.enabled).toBe(before);
  });

  it("preserves the at field", () => {
    const result = setDigestEnabled(DEFAULT_NOTIFICATION_PREFS, true);
    expect(result.digest.at).toBe(DEFAULT_NOTIFICATION_PREFS.digest.at);
  });
});

// ── setDigestAt ──────────────────────────────────────────────────────────────

describe("setDigestAt", () => {
  it("updates the at time", () => {
    const result = setDigestAt(DEFAULT_NOTIFICATION_PREFS, "14:00");
    expect(result.digest.at).toBe("14:00");
  });

  it("does not mutate the original", () => {
    const original = DEFAULT_NOTIFICATION_PREFS;
    setDigestAt(original, "14:00");
    expect(original.digest.at).toBe("09:00");
  });

  it("preserves the enabled field", () => {
    const result = setDigestAt(DEFAULT_NOTIFICATION_PREFS, "08:30");
    expect(result.digest.enabled).toBe(DEFAULT_NOTIFICATION_PREFS.digest.enabled);
  });
});

// ── setQuietHours ────────────────────────────────────────────────────────────

describe("setQuietHours", () => {
  it("sets quiet hours", () => {
    const result = setQuietHours(DEFAULT_NOTIFICATION_PREFS, {
      start: "22:00",
      end: "07:00",
    });
    expect(result.quiet_hours).toEqual({ start: "22:00", end: "07:00" });
  });

  it("clears quiet hours when null", () => {
    const withHours = setQuietHours(DEFAULT_NOTIFICATION_PREFS, {
      start: "22:00",
      end: "07:00",
    });
    const cleared = setQuietHours(withHours, null);
    expect(cleared.quiet_hours).toBeNull();
  });

  it("does not mutate the original", () => {
    const original = DEFAULT_NOTIFICATION_PREFS;
    setQuietHours(original, { start: "22:00", end: "07:00" });
    expect(original.quiet_hours).toBeNull();
  });
});

// ── setTimezone ──────────────────────────────────────────────────────────────

describe("setTimezone", () => {
  it("sets a timezone string", () => {
    const result = setTimezone(DEFAULT_NOTIFICATION_PREFS, "America/New_York");
    expect(result.timezone).toBe("America/New_York");
  });

  it("clears timezone with null", () => {
    const withTz = setTimezone(DEFAULT_NOTIFICATION_PREFS, "Europe/London");
    const cleared = setTimezone(withTz, null);
    expect(cleared.timezone).toBeNull();
  });
});

// ── label helpers ────────────────────────────────────────────────────────────

describe("categoryLabel", () => {
  it("maps all four categories to human labels without dashes", () => {
    const labels = [
      categoryLabel("oversight"),
      categoryLabel("my_activity"),
      categoryLabel("workspace"),
      categoryLabel("updates"),
    ];
    for (const label of labels) {
      expect(label).not.toContain("-");
      expect(label).not.toContain("—");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("categoryHelper", () => {
  it("returns non-empty helper text without dashes for all categories", () => {
    const helpers = [
      categoryHelper("oversight"),
      categoryHelper("my_activity"),
      categoryHelper("workspace"),
      categoryHelper("updates"),
    ];
    for (const h of helpers) {
      expect(h).not.toContain("-");
      expect(h).not.toContain("—");
      expect(h.length).toBeGreaterThan(0);
    }
  });
});
