import type { Priority } from "@gatewerk/shared";

/**
 * The template-form priority picker shows only Normal/High. Low and Critical
 * bucket into their nearer neighbour for display — matching the Inbox's own
 * routine (low|normal) vs urgent (high|critical) split
 * (screens/inbox/review-filters.ts). Saving the draft after this writes back
 * literally "normal"/"high": a template already defaulted to Low or Critical
 * loses that value on its next save. Deliberate.
 */
export function priorityBucket(p: Priority): "normal" | "high" {
  return p === "high" || p === "critical" ? "high" : "normal";
}

export const PRIORITY_TOGGLE_TABS = [
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
] as const;
