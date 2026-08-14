/**
 * recipient-state.ts — pure helpers for the external review page (/r/:token).
 *
 * Covers the terminal states + final copy and the wiring contract. Pure: no
 * React, no fetch.
 */

import { ApiError } from "@gatewerk/web-core/api/client/http";

// ── terminal states ──────────────────────────────────────────────────────────

/**
 * Every terminal tile the recipient can land on. Ten come from the design
 * (proto:187-198); `error` is the spec Q7 addition for an unclassified failure.
 */
export type StatusKind =
  | "approved"
  | "rejected"
  | "declined"
  | "questions"
  | "expired"
  | "used"
  | "invalid"
  | "locked"
  | "login"
  | "mismatch"
  | "error";

export type StatusTone = "green" | "red" | "amber" | "neutral";
export type StatusIcon = "check" | "cross" | "clock" | "shield" | "login" | "question";

export interface StatusCopy {
  icon: StatusIcon;
  tone: StatusTone;
  title: string;
  /** Static description; `used` / `mismatch` / `error` interpolate at render. */
  desc: string;
  /** Render the "Sent by <sender>" line. */
  sender: boolean;
  cta?: string;
}

/** Copy is final (design README §3) — do not reword. */
export const STATUS_COPY: Record<StatusKind, StatusCopy> = {
  approved: {
    icon: "check",
    tone: "green",
    title: "Confirmed",
    desc: "Your decision has been recorded and the agent has been notified. You can close this page.",
    sender: false,
  },
  rejected: {
    icon: "cross",
    tone: "red",
    title: "Rejected",
    desc: "Your decision has been recorded. The agent will not proceed. You can close this page.",
    sender: false,
  },
  declined: {
    icon: "cross",
    tone: "red",
    title: "Review declined",
    desc: "Your decline has been recorded and the sender has been notified.",
    sender: false,
  },
  questions: {
    icon: "question",
    tone: "green",
    title: "Questions sent",
    desc: "Your questions have been sent. The reviewer will follow up before this proceeds.",
    sender: false,
  },
  expired: {
    icon: "clock",
    tone: "amber",
    title: "Link expired",
    desc: "This review link has expired. Please request a new link from the person who sent it to you.",
    sender: true,
  },
  used: {
    icon: "check",
    tone: "green",
    title: "Already decided",
    desc: "This review has already been decided. No further action is needed.",
    sender: false,
  },
  invalid: {
    icon: "shield",
    tone: "red",
    title: "Invalid link",
    desc: "This review link is not valid. It may have been revoked, or the URL is incorrect.",
    sender: false,
  },
  locked: {
    icon: "shield",
    tone: "red",
    title: "Link locked",
    desc: "Too many wrong attempts. This link is temporarily locked. Contact the sender to request a new link.",
    sender: true,
  },
  login: {
    icon: "login",
    tone: "neutral",
    title: "Sign in to continue",
    desc: "This review link requires you to be signed in to your Gatewerk account.",
    sender: false,
    cta: "Sign in",
  },
  mismatch: {
    icon: "login",
    tone: "amber",
    title: "Wrong account",
    desc: "This link is not for your account.",
    sender: true,
    cta: "Switch accounts",
  },
  error: {
    icon: "shield",
    tone: "red",
    title: "Something went wrong",
    desc: "This review could not be loaded. Please try again, or contact the person who sent you this link.",
    sender: false,
  },
};

// ── time + date ──────────────────────────────────────────────────────────────

const MINUTE = 60;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;

/**
 * Verbose relative time ("8 minutes ago") as the design writes it (proto:164).
 * The inbox's compact `timeAgo` ("8m ago") is deliberately not reused: this is
 * the lowest-context surface in the product and reads as prose.
 */
export function verboseAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "just now";
  if (seconds < MINUTE) return "just now";
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (seconds < HOUR) return plural(Math.floor(seconds / MINUTE), "minute");
  if (seconds < DAY) return plural(Math.floor(seconds / HOUR), "hour");
  const days = Math.floor(seconds / DAY);
  if (days < 30) return plural(days, "day");
  if (days < 365) return plural(Math.floor(days / 30), "month");
  return plural(Math.floor(days / 365), "year");
}

/** "Jul 15, 2026" — the format the design's `used` copy uses. */
export function formatDecidedDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * `used` tile description. Falls back to the decision-only sentence when the
 * server did not send `decided_at` (spec Q8).
 */
export function usedDescription(decision: string | undefined, decidedAt: string | undefined): string {
  const date = formatDecidedDate(decidedAt);
  if (!date || !decision || decision === "unknown") return STATUS_COPY.used.desc;
  return `This review was ${decision} on ${date}. No further action is needed.`;
}

// ── error copy ───────────────────────────────────────────────────────────────

/**
 * Recipients share an IP behind an office NAT, so the public router's
 * per-IP ceiling is reachable by ordinary use. The raw server message reads
 * as a broken link to someone with no product context; say what happened and
 * what to do.
 */
const THROTTLED = "Too many attempts from your network. Please wait a minute and try again.";

function isThrottled(err: unknown): boolean {
  const api = err instanceof ApiError ? err : null;
  return api?.status === 429 || api?.code === "rate_limit_exceeded";
}

/** Inline copy under the email input (spec §2.5). */
export function emailErrorMessage(err: unknown): string {
  const api = err instanceof ApiError ? err : null;
  switch (api?.code) {
    case "email_rate_limited":
      return "Too many code requests. Please wait an hour or contact the sender.";
    case "email_send_failed":
      return "Could not deliver the verification email. Please try again in a moment.";
    default:
      if (isThrottled(err)) return THROTTLED;
      return api?.message || "Could not send the verification code";
  }
}

/** Inline copy under the code input (spec §3.7). */
export function codeErrorMessage(err: unknown): string {
  const api = err instanceof ApiError ? err : null;
  if (isThrottled(err)) return THROTTLED;
  return api?.message || "That code was not accepted";
}

/** True when an OTP failure means the link is locked for an hour (spec §8). */
export function isLockedError(err: unknown): boolean {
  const api = err instanceof ApiError ? err : null;
  return api?.code === "token_locked" || api?.status === 423;
}

/** A failed GET /r/:token maps to `invalid` only for a genuinely bad link. */
export function loadFailureKind(err: unknown): StatusKind {
  const api = err instanceof ApiError ? err : null;
  if (api?.status === 404 || api?.code === "invalid_token_format") return "invalid";
  return "error";
}
