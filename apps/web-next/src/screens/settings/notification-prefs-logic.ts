/**
 * notification-prefs-logic.ts — pure helpers for the notification preference matrix.
 *
 * No React, no fetch. All functions are immutable: they return new objects and
 * never mutate the input. Test-friendly by design.
 */
import type {
  NotificationPrefs,
  NotificationCategory,
} from "@gatewerk/shared";

// ── channel toggle ───────────────────────────────────────────────────────────

/**
 * Flip the email or slack value for one category. Returns a new `NotificationPrefs`
 * object; the original is never mutated.
 *
 * channel: "email" | "slack" (in-app is always-on and not toggleable).
 */
export function toggleChannel(
  prefs: NotificationPrefs,
  category: NotificationCategory,
  channel: "email" | "slack",
): NotificationPrefs {
  return {
    ...prefs,
    channels: {
      ...prefs.channels,
      [category]: {
        ...prefs.channels[category],
        [channel]: !prefs.channels[category][channel],
      },
    },
  };
}

// ── digest ───────────────────────────────────────────────────────────────────

/** Enable or disable the daily digest. Returns a new prefs object. */
export function setDigestEnabled(
  prefs: NotificationPrefs,
  enabled: boolean,
): NotificationPrefs {
  return { ...prefs, digest: { ...prefs.digest, enabled } };
}

/** Update the digest send time (HH:mm). Returns a new prefs object. */
export function setDigestAt(
  prefs: NotificationPrefs,
  at: string,
): NotificationPrefs {
  return { ...prefs, digest: { ...prefs.digest, at } };
}

// ── quiet hours ──────────────────────────────────────────────────────────────

/** Set quiet-hours start/end (HH:mm strings). Pass null to clear. */
export function setQuietHours(
  prefs: NotificationPrefs,
  quietHours: { start: string; end: string } | null,
): NotificationPrefs {
  return { ...prefs, quiet_hours: quietHours };
}

/** Set timezone string. Pass null to use browser default. */
export function setTimezone(
  prefs: NotificationPrefs,
  timezone: string | null,
): NotificationPrefs {
  return { ...prefs, timezone };
}

// ── label helpers ────────────────────────────────────────────────────────────

/** Human-readable label for a notification category. No dashes. */
export function categoryLabel(category: NotificationCategory): string {
  switch (category) {
    case "oversight":
      return "Oversight";
    case "my_activity":
      return "My activity";
    case "workspace":
      return "Workspace";
    case "updates":
      return "Updates";
  }
}

/** Short helper copy for each category. No dashes. */
export function categoryHelper(category: NotificationCategory): string {
  switch (category) {
    case "oversight":
      return "Reviews assigned to you and urgent escalations";
    case "my_activity":
      return "Decisions, replies, and chain completions";
    case "workspace":
      return "Team membership and project changes";
    case "updates":
      return "Product news and release notes";
  }
}
