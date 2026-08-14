import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { Router } from "express";
import type { GatewerkMode } from "@gatewerk/shared";
import { InvalidRequestError, NotFoundError, GatewerkError } from "@gatewerk/shared";
import { config } from "./config";
import { serverEnv } from "./env";
import { errorHandler } from "./middleware/error-handler";
import { tenantContext } from "./middleware/tenant";
import { apiKeyAuth } from "./middleware/api-key-auth";
import { requireMediaAccess, mediaUnavailable } from "./middleware/require-media-access";
import { dualAuth } from "./middleware/dual-auth";
import { requestId } from "./middleware/request-id";
import { requestLogging } from "./middleware/logging";
import { securityHeaders } from "./middleware/security-headers";
import { sessionAuth } from "./middleware/session-auth";
import { httpCaching } from "./middleware/http-caching";
import { createTemplateRoutes } from "./routes/templates";
import { createTemplateStatsRoutes } from "./routes/template-stats";
import { createReviewRoutes } from "./routes/reviews";
import { createFeedbackRoutes } from "./routes/feedback";
import { createAuditRoutes } from "./routes/audit";
import { createWebhookDeliveryRoutes } from "./routes/webhook-deliveries";
import { createAuthRoutes } from "./routes/auth";
import { createTwoFactorRoutes } from "./routes/two-factor";
import { createInviteRoutes } from "./routes/invite";
import { createSessionManagementRoutes } from "./routes/session-management";
import { createEventsRoutes } from "./routes/events";
import { createKeyInfoRoutes } from "./routes/key-info";
import { createLoginHistoryRoutes } from "./routes/login-history";
import { createAccountRoutes } from "./routes/account";
import { createStatsRoutes } from "./routes/stats";
import { createSettingsRoutes } from "./routes/settings";
import { createApiKeyRoutes } from "./routes/api-keys";
import { createTokenReviewRoutes } from "./routes/token-reviews";
import { createUnsubscribeRoutes } from "./routes/unsubscribe";
import { createChainRoutes } from "./routes/chains";
import { createNotesRoutes } from "./routes/notes";
import { openApiDocument } from "./openapi";
import { getPostmanCollection } from "./postman";
import { createAuditService } from "./services/audit";
import { EventBus } from "./services/events";
import { NotificationService } from "./services/notifications";
import { PersonalNotifier } from "./services/personal-notifier";
import { getPgBoss } from "./services/jobs/pg-boss-client";
import { TimeoutWorker } from "./services/timeout-worker";
import { WebhookService } from "./services/webhooks";
import { WebhookRetryWorker } from "./services/webhook-retry-worker";
import { ApiKeyUsageCleanup } from "./services/api-key-usage-cleanup";
import { NoteCleanupWorker } from "./services/note-cleanup";
import { ChainEngine } from "./services/chain-engine";
import { createEmailService, type EmailService } from "./services/email";
import type { EmailTransport } from "./services/email/transport";
import { isSuppressed } from "./services/email/suppression";
import { isTenantPaused } from "./services/email/pause";
import { recordSend } from "./services/email/send-log";
import { createSessionService } from "./services/sessions";
import { createAdminJobRoutes } from "./routes/admin/jobs";
import { createPasswordHashStatsRoute } from "./routes/admin/password-hash-stats";
import { createAdminEmailPauseRoutes } from "./routes/admin-email-pause";
import { requireRole } from "./middleware/require-role";
import { createPasskeyRoutes } from "./routes/passkeys";
import { notificationsRouter, createSeenRoute } from "./routes/notifications";
import { createSlackRoutes } from "./routes/slack";
import { createHealthRoutes } from "./routes/health";
import { mediaKeyPrefix } from "./services/media";

export interface AppDeps {
  db?: any;
  eventBus?: EventBus;
  /**
   * Test-only injection point for the email transport. When set, the
   * email service constructed inside createApp uses the injected
   * transport so integration tests can capture sends without spinning
   * up an SMTP server. Production path leaves this undefined.
   */
  emailTransport?: EmailTransport;
  /**
   * Test-only injection point for the audit service. When set, overrides
   * the real createAuditService so tests can avoid nested DB transactions
   * (PGlite single-connection cannot handle db.transaction inside a running
   * db.transaction — it deadlocks). Production path leaves this undefined.
   */
  auditService?: ReturnType<typeof createAuditService>;
  /**
   * Test-only injection point for the fetch function used by WebhookService.
   * When set, all outbound webhook POSTs use this spy instead of globalThis.fetch
   * so integration tests can capture outbound calls without a real HTTP server.
   */
  fetchForWebhook?: typeof globalThis.fetch;
}

export function createApp(deps?: AppDeps): Express {
  const app = express();

  // Trust reverse-proxy hops on loopback + docker-internal ranges so req.ip
  // reflects the real client (needed for per-key IP allowlist enforcement).
  // Narrow preset = does NOT honor X-Forwarded-For from arbitrary upstreams.
  app.set("trust proxy", "loopback, linklocal, uniquelocal");

  // Cookie parser — populates req.cookies for the recipient session
  // cookie used by the email-OTP flow on /r. Mounted before routes;
  // the secret arg is passed even though we do not use signed cookies
  // (the session JWT is the signature) so that v1.5 signed-cookie use
  // cases can opt in without re-mounting the middleware.
  app.use(cookieParser(config.jwtSecret));

  // Correlation + observability first — every later middleware will want to
  // log with req.requestId, including errors inside cors / body parsers.
  app.use(requestId());
  app.use(requestLogging());
  app.use(securityHeaders());

  app.use(cors({ origin: config.uiOrigin, credentials: true }));
  // Exempt inbound webhook paths from the global JSON parser so their
  // route-level express.raw() receives the unmodified Buffer (needed for
  // HMAC signature verification). express.json sets req._body=true on the
  // FIRST body-parser that runs; a subsequent express.raw on the same
  // request sees _body===true and skips, leaving req.body as a parsed
  // object instead of a Buffer — making (req.body as Buffer).toString()
  // return "[object Object]" and every valid signature fail.
  const jsonParser = express.json({ limit: "1mb" });
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/v1/webhooks/")) return next();
    return jsonParser(req, res, next);
  });
  app.use(tenantContext());
  app.use(httpCaching());

  // Serve uploaded media files. This mount exists in EVERY mode — it is the
  // OSS storage path (services/media.ts falls back to disk when R2 is absent),
  // so the entitlement gate belongs here and not only on the cloud route below.
  const mediaGuard = deps?.db ? requireMediaAccess(deps.db) : mediaUnavailable;
  app.use("/uploads", mediaGuard, express.static(serverEnv.UPLOADS_DIR ?? "/data/uploads", {
    setHeaders: (res, filePath) => {
      res.setHeader("Content-Disposition", "attachment");
      res.setHeader("X-Content-Type-Options", "nosniff");
      // Written here rather than via the `maxAge`/`immutable` options because
      // serve-static emits its own Cache-Control first and this callback is
      // the last writer. It used to say `public`, which let any shared proxy
      // keep an attachment and hand it to the next requester — harmless while
      // the route was open to everyone, a bypass of the gate now that it is
      // not. Clients may still cache; caches they share may not.
      res.setHeader("Cache-Control", "private, max-age=604800, immutable");
    },
  }));

  if (config.mode === "cloud") {
    const r2Endpoint = config.cloud.r2Endpoint;
    app.get("/api/v1/media/:reviewId/:filename", mediaGuard, async (req, res) => {
      try {
        // The 302 target is a 15-minute presigned bearer URL, so this response
        // must not be cached and re-handed to a later, unentitled requester.
        res.setHeader("Cache-Control", "private, no-store");
        // String(): with a middleware in the chain express widens the inferred
        // param type, matching how every route handler here reads params.
        const safeId = String(req.params.reviewId).replace(/[^a-zA-Z0-9_-]/g, "");
        const safeName = String(req.params.filename).replace(/[^a-zA-Z0-9_.-]/g, "");
        if (!safeId || !safeName) return res.status(400).json(new InvalidRequestError("Invalid path").toJSON());
        const key = `${mediaKeyPrefix(safeId)}${safeName}`;
        const r2StoragePath = (): string => new URL("../../../ee/api/storage/r2-storage.js", import.meta.url).href;
        const { getSignedDownloadUrl } = await import(r2StoragePath()) as { getSignedDownloadUrl: (key: string) => Promise<string | null> };
        const presignedUrl = await getSignedDownloadUrl(key);
        if (!presignedUrl) return res.status(404).json(new NotFoundError("Not found").toJSON());
        if (r2Endpoint && !presignedUrl.startsWith(r2Endpoint)) {
          return res.status(500).json(
            new GatewerkError("Storage error", 500, "internal_error", "storage_error").toJSON(),
          );
        }
        // nosemgrep: javascript.express.web.tainted-redirect-express.tainted-redirect-express
        res.redirect(302, presignedUrl);
      } catch {
        res.status(500).json(
          new GatewerkError("Storage error", 500, "internal_error", "storage_error").toJSON(),
        );
      }
    });
  }

  // Liveness (public). Deliberately static: four compose healthchecks, the
  // tagged-release deploy gate, nginx and quickstart all poll this, so making
  // it touch the database would turn a transient DB blip into a restart loop.
  // "Is this deployment actually working" is a different question and is
  // answered by GET /health/ready — see routes/health.ts.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.use("/health", createHealthRoutes(app, deps?.db));

  app.get("/.well-known/security.txt", (_req, res) => {
    res.type("text/plain").send(
      "Contact: mailto:security@gatewerk.com\n" +
      "Preferred-Languages: en\n" +
      "Canonical: https://app.gatewerk.com/.well-known/security.txt\n" +
      "Expires: 2027-06-01T00:00:00.000Z\n"
    );
  });

  // Version info (public)
  app.get("/api/v1", (_req, res) => {
    res.json({ version: "1", protocol: "HRP/1.0", name: "Gatewerk", mode: config.mode });
  });

  // Developer docs: public in OSS (SDK/integration work), auth-gated in Cloud
  if (config.mode === "cloud" && deps?.db) {
    const docAuth = sessionAuth(deps.db);
    app.get("/api/v1/openapi.json", docAuth, (_req, res) => {
      res.type("application/json").json(openApiDocument);
    });
    app.get("/api/v1/postman.json", docAuth, async (_req, res, next) => {
      try {
        const collection = await getPostmanCollection();
        res.type("application/json").json(collection);
      } catch (err) {
        next(err);
      }
    });
  } else {
    app.get("/api/v1/openapi.json", (_req, res) => {
      res.type("application/json").json(openApiDocument);
    });
    app.get("/api/v1/postman.json", async (_req, res, next) => {
      try {
        const collection = await getPostmanCollection();
        res.type("application/json").json(collection);
      } catch (err) {
        next(err);
      }
    });
  }

  // Authenticated API routes
  if (deps?.db) {
    (app as any).db = deps.db;

    // Set up EventBus and NotificationService
    const eventBus = deps.eventBus || new EventBus();
    const notifications = new NotificationService({ db: deps.db, uiOrigin: config.uiOrigin });
    notifications.register(eventBus);
    const personalNotifier = new PersonalNotifier(deps.db, {
      enqueueEmailFallback: async (o) => {
        const boss = await getPgBoss();
        await boss.send(
          'oss.notification-email',
          { notificationId: o.notificationId, email: o.email },
          {
            startAfter: o.delaySeconds,
            singletonKey: o.reviewerId + ':' + o.reviewId,
          },
        );
      },
      enqueueSlack: async (o) => {
        const boss = await getPgBoss();
        await boss.send(
          'oss.notification-slack',
          { notificationId: o.notificationId, email: o.email, reviewerId: o.reviewerId },
          {
            // I-4: quiet hours now apply to Slack the same way they apply to
            // the email fallback above, including the urgent bypass.
            startAfter: o.delaySeconds,
            singletonKey: o.reviewerId + ':' + o.reviewId,
          },
        );
      },
    });
    personalNotifier.register(eventBus);

    const webhooks = new WebhookService({ db: deps.db, fetch: deps.fetchForWebhook, eventBus });
    // auditService is constructed here so the TimeoutWorker can record
    // `review.assignment_escalated` entries when a ladder promotes (M9
    // Phase 1). Moved above the TimeoutWorker construction so the worker's
    // dep bundle can reference it.
    // deps.auditService allows test suites to inject a lightweight stub that
    // avoids nested db.transaction() calls — PGlite single-connection hangs
    // when a second transaction is opened inside a running transaction.
    const auditService = deps.auditService ?? createAuditService(deps.db);
    const timeoutWorker = new TimeoutWorker({ db: deps.db, webhooks, eventBus, auditService });

    const webhookRetryWorker = new WebhookRetryWorker({ db: deps.db, webhooks });
    const apiKeyUsageCleanup = new ApiKeyUsageCleanup({ db: deps.db });
    const noteCleanupWorker = new NoteCleanupWorker({ db: deps.db });

    // Email service. Instantiated before ChainEngine so the SMTP-configured
    // predicate can be threaded into the engine for the email_otp guard.
    // Also needed before SIGTERM can close the nodemailer pool (see index.ts).
    const emailService = createEmailService({
      audit: auditService,
      transport: deps.emailTransport,
      checkSuppressed: (address) => isSuppressed(deps.db, address),
      checkTenantPaused: (orgId) => isTenantPaused(deps.db, orgId),
      logSend: (i) => recordSend(deps.db, i),
    });

    // Chain engine (M10 Phase 1). Lives alongside TimeoutWorker: the worker
    // handles claim-based expiry + ladder promotion, the engine handles
    // event-driven chain advancement on review.decided. Subscribed to the
    // same EventBus NotificationService is registered on.
    const chainEngine = new ChainEngine({ db: deps.db, webhooks, eventBus, auditService, isEmailConfigured: () => emailService.isEmailConfigured() });
    chainEngine.subscribe(eventBus);
    (app as any).chainEngine = chainEngine;

    // Attach to app for server startup
    (app as any).timeoutWorker = timeoutWorker;
    (app as any).webhookRetryWorker = webhookRetryWorker;
    (app as any).apiKeyUsageCleanup = apiKeyUsageCleanup;
    (app as any).noteCleanupWorker = noteCleanupWorker;
    (app as any).emailService = emailService;
    (app as any).auditService = auditService;

    const sessionService = createSessionService(deps.db);
    setInterval(() => { sessionService.cleanup().catch(() => {}); }, 6 * 60 * 60 * 1000);

    // Public token review routes (no auth required)
    // Mounted at both /r (direct API access) and /api/v1/r (through nginx proxy)
    const tokenReviewRoutes = createTokenReviewRoutes(deps.db, eventBus, auditService, webhooks, emailService);
    app.use("/r", tokenReviewRoutes);
    app.use("/api/v1/r", tokenReviewRoutes);

    // Public one-click unsubscribe route (RFC 8058) — no auth required.
    // Flips the reviewer's digest pref; never calls suppress().
    app.use("/api/v1/unsub", createUnsubscribeRoutes(deps.db, auditService));

    // Slack OAuth routes — /install and /status need sessionAuth (per-route),
    // /callback is PUBLIC (state-verified). Must be mounted BEFORE the
    // dualRouter so the public callback is not intercepted by dualAuth.
    app.use("/api/v1/slack", createSlackRoutes(deps.db, auditService));

    // Key info (API key auth only — must be before /api/v1/auth)
    app.use("/api/v1/auth/key-info", apiKeyAuth(deps.db), createKeyInfoRoutes());

    // Passkey (WebAuthn) routes — register/login options+verify + account list/delete
    app.use("/api/v1", createPasskeyRoutes(deps.db, auditService, emailService));

    // Auth routes (public login, session-protected /me)
    app.use("/api/v1/auth", createAuthRoutes(deps.db, auditService, emailService));
    app.use("/api/v1/auth/invite", createInviteRoutes(deps.db, auditService));
    app.use("/api/v1/auth", createSessionManagementRoutes(deps.db, auditService));
    app.use("/api/v1/auth/2fa", createTwoFactorRoutes(deps.db, auditService));
    app.use("/api/v1/auth/login-history", createLoginHistoryRoutes(deps.db));
    app.use("/api/v1/auth", createAccountRoutes(deps.db, auditService, emailService));

    // Live feed (M1). Ticket endpoint is dualAuth'd per-route; stream
    // endpoint consumes tickets via query string because browser
    // EventSource cannot send a Bearer header. Mounted outside dualRouter
    // so the stream bypasses the Bearer requirement.
    app.use("/api/v1/events", createEventsRoutes(deps.db, eventBus));

    // Dual auth routes (API key or JWT session)
    const dualRouter = Router();

    /**
     * Provider callbacks that authenticate by cryptographic signature, not by
     * an API key or a session.
     *
     * Their routers live in ee/api/bootstrap.ts, which registerEE mounts AFTER
     * this one. Express matches in mount order, so every Stripe and Resend
     * callback hit dualAuth first and came back 401 missing_credentials — the
     * handlers were unreachable in cloud production and nothing said so.
     *
     * EXACT paths, never a prefix: /api/v1/webhooks/deliveries sits under the
     * same segment and is an authenticated admin surface. `next("router")`
     * leaves this router entirely so the later ee/ mounts get the request.
     *
     * These endpoints are not becoming unauthenticated — each handler
     * verifies its provider signature and rejects on failure (stripe
     * webhooks.constructEvent, resend webhooks.verify). This moves the
     * check from the wrong credential type to the right one.
     */
    const SIGNED_PROVIDER_CALLBACKS = new Set(["/webhooks/stripe", "/webhooks/resend"]);
    const dualAuthMw = dualAuth(deps.db);
    dualRouter.use((req, res, next) => {
      if (SIGNED_PROVIDER_CALLBACKS.has(req.path)) return next("router");
      return dualAuthMw(req, res, next);
    });
    dualRouter.use("/reviews", createReviewRoutes(deps.db, eventBus, auditService, webhooks, chainEngine, emailService));
    dualRouter.use("/stats", createStatsRoutes(deps.db));
    dualRouter.use("/templates", createTemplateRoutes(deps.db, auditService));
    dualRouter.use("/templates", createTemplateStatsRoutes(deps.db));
    // Chain routes mount at the dualRouter root (not under a prefix) because
    // they span two resource families: /chain-runs and /reviews/:id/chain.
    // Registered AFTER /reviews so the /reviews/:id/chain sub-path is not
    // swallowed by the /reviews router's /:id handler.
    dualRouter.use(createChainRoutes(deps.db, chainEngine, eventBus));
    dualRouter.use("/notes", createNotesRoutes(deps.db, auditService));
    // /audit and /webhooks/deliveries are admin observability surfaces — they
    // need to be reachable both by agents (API key scoped audit:read) AND by
    // dashboard admins (session). Moved here from the apiKeyAuth-only router
    // when the Admin Observability UI shipped. requireScope on each route
    // handles per-subject authz (sessions resolve scopes via role policy).
    dualRouter.use("/audit", createAuditRoutes(deps.db));
    dualRouter.use("/webhooks/deliveries", createWebhookDeliveryRoutes(deps.db, auditService));
    app.use("/api/v1", dualRouter);

    // Session auth only routes (settings)
    app.use("/api/v1/settings", createSettingsRoutes(deps.db, auditService, emailService));
    app.use("/api/v1/settings/api-keys", createApiKeyRoutes(deps.db, eventBus, auditService));

    // Notification routes (session auth only)
    app.use("/api/v1/notifications", notificationsRouter(deps.db));
    app.use("/api/v1/reviews", createSeenRoute(deps.db));

    // Admin-only operational endpoints — session-auth + role=admin.
    app.use(
      "/api/v1/admin/jobs",
      sessionAuth(deps.db),
      requireRole("admin"),
      createAdminJobRoutes(deps.db, emailService, auditService),
    );
    // More specific than the "/api/v1/admin" mount below, and registered
    // first, so it must come before it: app.use() matches by registration
    // order, and the generic mount below would otherwise intercept this
    // path's requests at its own sessionAuth/requireRole layer before ever
    // reaching this router's 404 for an unknown organization.
    app.use(
      "/api/v1/admin/email-pause",
      sessionAuth(deps.db),
      requireRole("admin"),
      createAdminEmailPauseRoutes(deps.db, auditService),
    );
    app.use(
      "/api/v1/admin",
      sessionAuth(deps.db),
      requireRole("admin"),
      createPasswordHashStatsRoute(deps.db),
    );

    // API key auth only routes. apiKeyAuth MUST be scoped to the specific
    // mount path — NOT applied as a blanket `.use()` on a /api/v1 router.
    // A blanket apiKeyAuth here runs for every /api/v1 request that falls
    // through the routers above (anything without a matching route), and
    // rejects it with "invalid_api_key_format" because the token is not
    // gwk_-prefixed. That intercepts the EE cloud routes (/api/v1/billing/*)
    // which registerEE mounts AFTER this router, so a Supabase session token
    // never reaches cloudAuth. In cloud mode the dashboard polls
    // /api/v1/billing/status on every page → 401 → http.ts hard-redirects to
    // /login → reload → loop. Scoping apiKeyAuth to /feedback keeps the
    // feedback endpoint API-key-only while letting cloud routes fall through.
    app.use("/api/v1/feedback", apiKeyAuth(deps.db), createFeedbackRoutes(deps.db));
  }

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}

/**
 * Cloud-tier bootstrap gate. When `mode === "cloud"`, dynamically loads
 * `ee/api/bootstrap.ts` and invokes `registerEE(app)`. When `mode ===
 * "standalone"`, short-circuits without touching the module resolver — OSS
 * builds do not ship the `ee/` directory at all.
 *
 * The module specifier is produced by a function returning `string` so that
 * neither the src-only `tsconfig.json` nor the cloud `ee/api/tsconfig.json`
 * treats it as a literal and attempts static resolution. Static resolution
 * from `src/` is what the one-way import rule forbids; the function
 * indirection is how we keep both tsconfig profiles type-clean.
 *
 * It must be an ABSOLUTE URL, not the bare relative string it used to be.
 * The ee tree lives at the repo root now, above this app, and vite resolves a
 * dynamic specifier against the importer's path relative to the VITE ROOT —
 * which for this package is apps/api. A plain "../../../ee/api/bootstrap.js"
 * therefore climbs past that root, gets clamped, and resolves to the literal
 * filesystem path /ee/api/bootstrap.js under vitest while working fine under
 * Bun. Deriving it from import.meta.url sidesteps the resolver's root-relative
 * arithmetic entirely. Both runtimes then map the .js extension onto the .ts
 * file on disk, which is why the extension stays .js here.
 *
 * Exported separately from `createApp` so the synchronous app factory
 * signature stays unchanged — test suites that call `createApp()` keep
 * working, and only the async entry-point (`index.ts`) or cloud-wiring
 * tests need to await this helper.
 */
export async function mountEeIfCloud(
  app: Express,
  mode: GatewerkMode = config.mode,
): Promise<void> {
  if (mode !== "cloud") return;
  const eeSpecifier = (): string => new URL("../../../ee/api/bootstrap.js", import.meta.url).href;
  const mod = (await import(eeSpecifier())) as {
    registerEE: (app: Express) => void;
  };
  mod.registerEE(app);
}
