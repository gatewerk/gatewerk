import { lt } from "drizzle-orm";
import { apiKeyUsage } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";

export interface ApiKeyUsageCleanupDeps {
  db: AppDb;
  retentionDays?: number;
}

/**
 * Deletes `api_key_usage` rows older than `retentionDays` (default 30) on a
 * daily cadence. Mirrors the timeout-worker / webhook-retry-worker pattern
 * (setInterval + start/stop) so the single-container deploy has a consistent
 * worker shape.
 *
 * pg_cron is the right eventual home for this (survives API restarts, one
 * instance under replica fan-out) but requires `shared_preload_libraries`
 * + container restart to install. Migration 018's conditional DO block
 * already picks up a pg_cron schedule if the extension later becomes
 * present; if that happens, this worker should be removed in the same PR
 * so the two don't race-DELETE the same rows.
 */
export class ApiKeyUsageCleanup {
  private db: AppDb;
  private retentionDays: number;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ApiKeyUsageCleanupDeps) {
    this.db = deps.db;
    this.retentionDays = deps.retentionDays ?? 30;
  }

  start(intervalMs = 24 * 60 * 60 * 1000): void {
    // Fire once soon after startup so a long-uptime container doesn't wait
    // 24h for its first sweep. 30s delay lets the DB pool warm up first.
    setTimeout(() => {
      this.cleanup().catch((err) => {
        console.error("API key usage cleanup error:", err);
      });
    }, 30_000);

    this.interval = setInterval(() => {
      this.cleanup().catch((err) => {
        console.error("API key usage cleanup error:", err);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async cleanup(): Promise<number> {
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.db
      .delete(apiKeyUsage)
      .where(lt(apiKeyUsage.created_at, cutoff))
      .returning({ id: apiKeyUsage.id });

    const n = result.length;
    if (n > 0) {
      console.log(`API key usage cleanup: deleted ${n} row(s) older than ${this.retentionDays}d`);
    }
    return n;
  }
}
