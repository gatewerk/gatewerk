import { config } from "../../config";
import { PgBossWebhookDispatcher } from "./pg-boss-webhook-dispatcher";
import { WebhookService } from "../webhooks";
import type { WebhookDispatcher } from "./webhook-dispatcher";
import type { AppDb } from "@gatewerk/db";
import type { GatewerkMode } from "@gatewerk/shared";

export type { WebhookDispatcher } from "./webhook-dispatcher";
export type { Signature, WebhookEvent, DispatchId, DeliveryStatus } from "./webhook-dispatcher";

/**
 * Factory for WebhookDispatcher.
 *
 * Returns (Promise resolving to):
 *   - HookdeckWebhookDispatcher when `mode === "cloud"` AND `HOOKDECK_API_KEY` is set
 *   - PgBossWebhookDispatcher otherwise (OSS default — wraps existing WebhookService + retry worker)
 *
 * Async because the Cloud path uses `await import()` with function-indirection
 * (project canonical EE-boundary pattern — see app.ts:mountEeIfCloud and
 * services/email/index.ts:createEmailSender).
 *
 * Existing WebhookService and WebhookRetryWorker continue to be imported directly
 * by existing route handlers. This factory is the new entry point for code that
 * wants to dispatch without being coupled to the provider.
 */
export async function createWebhookDispatcher(opts?: {
  mode?: GatewerkMode;
  hookdeckApiKey?: string;
  webhookService?: WebhookService;
  db?: AppDb;
}): Promise<WebhookDispatcher> {
  const mode = opts?.mode ?? config.mode;
  const hookdeckApiKey = opts?.hookdeckApiKey ?? config.hookdeckApiKey;

  if (mode === "cloud" && hookdeckApiKey) {
    // Function-indirection prevents bundler from following this statically.
    // Required for OSS bundle isolation; canonical pattern.
    const eeSpecifier = (): string => new URL("../../../../../ee/api/adapters/hookdeck-webhook-dispatcher.js", import.meta.url).href;
    const mod = (await import(eeSpecifier())) as {
      HookdeckWebhookDispatcher: new (
        apiKey: string,
        fetchFn?: typeof globalThis.fetch,
      ) => WebhookDispatcher;
    };
    return new mod.HookdeckWebhookDispatcher(hookdeckApiKey);
  }

  const service = opts?.webhookService ?? new WebhookService({ db: opts?.db });
  if (!opts?.webhookService && !opts?.db) {
    throw new Error(
      "createWebhookDispatcher: OSS path requires either `webhookService` or `db` in opts. Without a db, persistence and status polling cannot work.",
    );
  }
  return new PgBossWebhookDispatcher(service, opts?.db);
}
