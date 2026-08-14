import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function timeAgo(date: string | Date): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diff = now - then;

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/**
 * Compact relative age for dense list rows: "2h", "9d", "3wk" — no "ago".
 * Detail surfaces keep timeAgo()'s "1d ago" per DetailHistory.dc.html:33.
 * `now` is injectable so day/week boundaries are testable (same rule as
 * history-model.ts).
 */
export function timeAgoShort(date: string | Date, now: Date = new Date()): string {
  const diff = now.getTime() - new Date(date).getTime();
  if (diff < 60_000) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  // An unparseable timestamp makes every comparison above false and falls
  // through to the last line, where it printed "NaNy" on a live list row.
  if (Number.isNaN(days)) return "unknown";
  if (days < 14) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks}wk`;
  // Guard on days, not on a 30-day month count: 12 thirty-day months is day
  // 360, but a year is 365 days, so [360, 364] fell into the years branch and
  // rendered "0y".
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(date));
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "--";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

export function getReviewTitle(payload: Record<string, unknown>, id: string): string {
  // Explicit title/subject fields
  if (typeof payload.title === "string" && payload.title) return payload.title;
  if (typeof payload.subject === "string" && payload.subject) return payload.subject;
  // Identity fields (who/what is this about)
  if (typeof payload.job_title === "string" && payload.job_title) return payload.job_title;
  if (typeof payload.customer_name === "string" && payload.customer_name) return payload.customer_name;
  if (typeof payload.employee === "string" && payload.employee) return payload.employee;
  if (typeof payload.name === "string" && payload.name) return payload.name;
  // Service + version for deploy-style reviews
  if (typeof payload.service === "string" && payload.service) {
    const version = typeof payload.version === "string" ? ` ${payload.version}` : "";
    return `${payload.service}${version}`;
  }
  // Fallback: first short string value
  for (const val of Object.values(payload)) {
    if (typeof val === "string" && val.length > 0 && val.length <= 60) return val;
  }
  return `Review #${id.slice(7, 13)}`;
}

export function displayName(nameOrEmail: string): string {
  if (!nameOrEmail.includes("@")) return nameOrEmail;
  const local = nameOrEmail.split("@")[0];
  return local
    .replace(/[._-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function maskApiKey(prefix: string): string {
  return `${prefix}****...`;
}

export function downloadFile(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
