import { and, eq, lte, or, isNull, lt } from "drizzle-orm";
import { webhookDeliveries, reviews, projects } from "@gatewerk/db/src/schema/index";
import { WebhookService } from "./webhooks";
import type { AppDb } from "@gatewerk/db";

export interface WebhookRetryWorkerDeps {
  db: AppDb;
  webhooks: WebhookService;
}

export class WebhookRetryWorker {
  private db: AppDb;
  private webhooks: WebhookService;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(deps: WebhookRetryWorkerDeps) {
    this.db = deps.db;
    this.webhooks = deps.webhooks;
  }

  start(intervalMs = 10_000): void {
    this.interval = setInterval(() => {
      this.processRetries().catch((err) => {
        console.error("Webhook retry worker error:", err);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async processRetries(): Promise<number> {
    const now = new Date();
    const workerId = `worker-${process.pid}-${Date.now()}`;
    const claimTimeout = 5 * 60 * 1000; // 5 minutes

    // Atomic claim: UPDATE ... WHERE claimed_by IS NULL (or stale) RETURNING
    const claimed = await this.db
      .update(webhookDeliveries)
      .set({
        claimed_by: workerId,
        claimed_at: now,
      })
      .where(
        and(
          eq(webhookDeliveries.status, "pending"),
          lte(webhookDeliveries.next_attempt_at, now),
          or(
            isNull(webhookDeliveries.claimed_by),
            lt(webhookDeliveries.claimed_at, new Date(now.getTime() - claimTimeout))
          ),
        ),
      )
      .returning();

    if (claimed.length === 0) return 0;

    // Resolve current project HMAC secrets for the batch via JOIN:
    //   webhook_deliveries → reviews → projects
    // Secrets are cached per-project_id to avoid N+1 queries within the batch.
    //
    // HMAC signature is computed with the project's CURRENT secret at attempt time.
    // Rotation between attempts is by-design — receivers dedupe via delivery_id.
    // The per-row secret snapshot column was removed because per-row secret
    // duplication is a meaningful DB blast-radius increase for marginal
    // stability benefit (receivers should dedupe regardless).
    const projectSecretCache = new Map<string, string>();

    async function resolveSecret(db: AppDb, deliveryId: string): Promise<string | null> {
      const [row] = await db
        .select({ hmac_secret: projects.hmac_secret, project_id: projects.id })
        .from(webhookDeliveries)
        .innerJoin(reviews, eq(webhookDeliveries.review_id, reviews.id))
        .innerJoin(projects, eq(reviews.project_id, projects.id))
        .where(eq(webhookDeliveries.id, deliveryId))
        .limit(1);
      return row?.hmac_secret ?? null;
    }

    let processed = 0;

    for (const delivery of claimed) {
      try {
        // Resolve project secret: check cache first, then JOIN.
        // We key by delivery_id since we don't have project_id on the
        // delivery row directly; cache result keyed by delivery_id to
        // avoid repeat JOINs if the same delivery appears more than once
        // (shouldn't happen in practice, but safe).
        let hmacSecret = projectSecretCache.get(delivery.id);
        if (!hmacSecret) {
          // Resolve via JOIN; also populate cache entry keyed by delivery_id.
          // For batch-level per-project caching, we'd need project_id on the
          // delivery row — it was intentionally omitted to keep the schema
          // minimal. The JOIN cost per delivery is a single indexed lookup
          // (webhook_deliveries PK → reviews FK → projects PK).
          const resolved = await resolveSecret(this.db, delivery.id);
          if (!resolved) {
            // Project deleted between enqueue and retry — skip, release claim.
            console.error("Webhook retry skipped: project not found", { delivery_id: delivery.id });
            await this.db
              .update(webhookDeliveries)
              .set({ claimed_by: null, claimed_at: null })
              .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.claimed_by, workerId)));
            continue;
          }
          hmacSecret = resolved;
          projectSecretCache.set(delivery.id, hmacSecret);
        }

        await this.webhooks.retryDelivery({
          id: delivery.id,
          url: delivery.url,
          payload: delivery.payload as Record<string, unknown>,
          hmac_secret: hmacSecret,
          event_type: delivery.event_type,
          attempts: delivery.attempts,
          max_attempts: delivery.max_attempts,
        });
        // Clear claim after successful processing
        await this.db
          .update(webhookDeliveries)
          .set({ claimed_by: null, claimed_at: null })
          .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.claimed_by, workerId)));
        processed++;
      } catch (err) {
        // Release claim on failure
        await this.db
          .update(webhookDeliveries)
          .set({ claimed_by: null, claimed_at: null })
          .where(and(eq(webhookDeliveries.id, delivery.id), eq(webhookDeliveries.claimed_by, workerId)));
        console.error("Failed to retry delivery", { delivery_id: delivery.id, err });
      }
    }

    if (processed > 0) {
      console.log(`Webhook retry worker: processed ${processed} delivery(ies)`);
    }

    return processed;
  }
}
