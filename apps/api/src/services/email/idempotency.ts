/**
 * In-memory idempotency dedup store for the email service.
 *
 * Caller-supplied key (typically a per-form-mount UUID) maps to a prior
 * `messageId` for 60 seconds. Within that window,
 * a repeat send with the same key returns the original messageId without
 * touching the SMTP transport — protects against form double-submit and
 * mid-flight duplicate POSTs from a flaky network.
 *
 * 60s window rationale: long enough to absorb retry storms from network
 * blips (typical TCP retry budget is sub-30s); short enough that a
 * legitimate manual retry by a user 1-2 minutes later still fires fresh.
 *
 * No background cleanup: pruning happens on each `get` (lazy expiry).
 * At OSS scale (sub-thousand active keys) the map stays bounded; keys
 * older than 60s drop on next access. A future high-volume Cloud
 * implementation can layer Redis with TTL — out of scope here.
 */

const WINDOW_MS = 60 * 1000;

interface Entry {
  messageId: string;
  expiresAt: number;
}

export interface IdempotencyStore {
  /** Returns prior messageId if active (within 60s); undefined otherwise. */
  get(key: string): string | undefined;
  /** Records a fresh entry; expires 60s from now. */
  set(key: string, messageId: string): void;
}

export function createIdempotencyStore(): IdempotencyStore {
  const entries = new Map<string, Entry>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.messageId;
    },
    set(key, messageId) {
      entries.set(key, {
        messageId,
        expiresAt: Date.now() + WINDOW_MS,
      });
    },
  };
}
