/**
 * In-memory dual-axis sliding window rate limiter for the email service.
 *
 * Two independent windows:
 *   - per-email: 5 sends per recipient address per 1 hour
 *   - per-IP:   20 sends per source IP per 1 hour
 *
 * Why dual-axis: per-email alone permits a single attacker IP to spray
 * unique recipients (relay abuse). Per-IP alone permits an attacker
 * controlling many IPs to flood one victim mailbox. Both axes together
 * cap each path independently. NIST SP 800-63B Rev.4 §5.2.2 throttle
 * guidance for OTP-bearing transactional surfaces.
 *
 * Sliding window vs fixed: a fixed 1-hour bucket allows a 2x burst at
 * window boundaries (e.g. 5 sends at 12:59 + 5 more at 13:00). Sliding
 * window prunes timestamps older than the window head on every check,
 * so the cap is honored continuously.
 *
 * OSS scope: in-memory state — single-instance OSS deploys. Cloud Solo
 * M30 layers a Redis-backed store via a separate RateLimiter
 * implementation; this file is the OSS reference.
 */

const PER_EMAIL_CAP = 5;
const PER_IP_CAP = 20;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

export type RateLimitAxis = "per_email" | "per_ip";

export interface RateLimiter {
  /** Returns true when allowed (under cap), false when rate-limited. Does NOT record. */
  check(key: string, axis: RateLimitAxis): boolean;
  /** Records a hit at Date.now(); also prunes old entries from the window head. */
  record(key: string, axis: RateLimitAxis): void;
}

export function createRateLimiter(): RateLimiter {
  // Map<axis:key, timestamps[]>. Single map keyed by axis prefix keeps the
  // implementation flat — per-email and per-IP windows can never collide
  // because the prefix differentiates them.
  const windows = new Map<string, number[]>();

  function capFor(axis: RateLimitAxis): number {
    return axis === "per_email" ? PER_EMAIL_CAP : PER_IP_CAP;
  }

  function pruneAndGet(mapKey: string): number[] {
    const arr = windows.get(mapKey);
    if (!arr) return [];
    const cutoff = Date.now() - WINDOW_MS;
    // Find first index >= cutoff. Since timestamps are appended in order,
    // we can slice from the first non-stale index. Linear scan from head
    // is fine at OSS scale (max ~20 entries per window).
    let firstFresh = 0;
    while (firstFresh < arr.length && arr[firstFresh]! < cutoff) {
      firstFresh++;
    }
    if (firstFresh > 0) {
      const pruned = arr.slice(firstFresh);
      if (pruned.length === 0) {
        windows.delete(mapKey);
      } else {
        windows.set(mapKey, pruned);
      }
      return pruned;
    }
    return arr;
  }

  return {
    check(key, axis) {
      const mapKey = `${axis}:${key}`;
      const fresh = pruneAndGet(mapKey);
      return fresh.length < capFor(axis);
    },
    record(key, axis) {
      const mapKey = `${axis}:${key}`;
      const fresh = pruneAndGet(mapKey);
      fresh.push(Date.now());
      windows.set(mapKey, fresh);
    },
  };
}
