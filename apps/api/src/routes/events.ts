import { Router, type Request, type Response } from "express";
import type { AppDb } from "@gatewerk/db";
import { AuthenticationError } from "@gatewerk/shared";
import { dualAuth } from "../middleware/dual-auth";
import type { EventBus } from "../services/events";
import { TicketStore, type TicketContext } from "../services/ticket-store";
import {
  acquireConnectionSlot,
  subscribeAll,
  toWirePayload,
} from "../services/sse-hub";
import { RateLimitError } from "../lib/http-errors";

const MAX_CONNECTIONS_PER_USER = 5;
const HEARTBEAT_MS = 30_000;

/**
 * Live-feed endpoints for the dashboard:
 *
 *   POST /api/v1/events/ticket  — exchange Bearer for a 60s single-use
 *                                 ticket (dualAuth'd).
 *   GET  /api/v1/events/stream  — Server-Sent Events feed, ticket in the
 *                                 query string. No Bearer header (browser
 *                                 EventSource can't send one).
 *
 * Scoping. API-key subscribers are scoped to their project; session
 * subscribers see every event (standalone mode has a single project).
 * When cloud mode lands, session scoping will widen to the caller's
 * project-membership list — the filter point is already in place here.
 */
export function createEventsRoutes(db: AppDb, eventBus: EventBus): Router {
  const router = Router();
  const tickets = new TicketStore();

  router.post("/ticket", dualAuth(db), (req: Request, res: Response) => {
    const context = ticketContextFromRequest(req);
    if (!context) {
      res.status(401).json(new AuthenticationError("Invalid auth context", "invalid_auth").toJSON());
      return;
    }
    const { ticket, expiresInSeconds } = tickets.issue(context);
    res.json({ ticket, expires_in: expiresInSeconds });
  });

  router.get("/stream", (req: Request, res: Response) => {
    const ticketParam = req.query.ticket;
    if (typeof ticketParam !== "string" || ticketParam.length === 0) {
      res.status(401).json(new AuthenticationError("Missing ticket", "missing_ticket").toJSON());
      return;
    }
    const context = tickets.consume(ticketParam);
    if (!context) {
      res.status(401).json(new AuthenticationError("Invalid or expired ticket", "invalid_ticket").toJSON());
      return;
    }

    const counterKey = connectionCounterKey(context);
    if (!acquireConnectionSlot(counterKey, MAX_CONNECTIONS_PER_USER)) {
      res.status(429).json(
        new RateLimitError(
          `Live feed limit reached (max ${MAX_CONNECTIONS_PER_USER} concurrent tabs)`,
          "too_many_connections",
        ).toJSON(),
      );
      return;
    }

    openSseStream(req, res, eventBus, context, counterKey);
  });

  return router;
}

function ticketContextFromRequest(req: Request): TicketContext | null {
  const authType = (req as any).authType as "apikey" | "session" | undefined;
  if (authType === "apikey") {
    const projectId = (req as any).projectId as string | undefined;
    const apiKeyId = (req as any).apiKeyId as string | undefined;
    if (!projectId || !apiKeyId) return null;
    return { authType: "apikey", projectId, apiKeyId };
  }
  if (authType === "session") {
    const reviewer = (req as any).reviewer as
      | { id: string; email: string }
      | undefined;
    if (!reviewer) return null;
    return {
      authType: "session",
      reviewerId: reviewer.id,
      reviewerEmail: reviewer.email,
    };
  }
  return null;
}

function connectionCounterKey(context: TicketContext): string {
  if (context.authType === "apikey") {
    return `apikey:${context.projectId}:${context.apiKeyId}`;
  }
  return `session:${context.reviewerId}`;
}

function openSseStream(
  req: Request,
  res: Response,
  eventBus: EventBus,
  context: TicketContext,
  counterKey: string,
): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  // nginx: do not buffer — SSE must stream byte-by-byte.
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // Let the client see the connection is live before the first real event.
  res.write(`data: ${JSON.stringify({ type: "open" })}\n\n`);

  const shouldDeliver = eventDeliveryFilter(context);

  const subscription = subscribeAll(eventBus, counterKey, (event, data) => {
    if (!shouldDeliver(data.project_id)) return;
    const payload = toWirePayload(event, data);
    // Write failure means the socket went away between check and write;
    // swallowing keeps emit() dispatch to other subscribers intact (the
    // close handler below will run when the socket's "close" event fires).
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      /* ignore — connection torn down */
    }
  });

  const heartbeat = setInterval(() => {
    try {
      // SSE comment line — ignored by EventSource but keeps proxies awake.
      res.write(":\n\n");
    } catch {
      /* ignore — connection torn down */
    }
  }, HEARTBEAT_MS);
  // Don't let the heartbeat keep the process alive when nothing else does.
  heartbeat.unref?.();

  const cleanup = () => {
    clearInterval(heartbeat);
    subscription.close();
  };

  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("error", cleanup);
}

function eventDeliveryFilter(context: TicketContext): (projectId: string) => boolean {
  if (context.authType === "apikey") {
    const allowed = context.projectId;
    return (projectId: string) => projectId === allowed;
  }
  // Session users in standalone mode see every project's events — there is
  // only one project. Cloud mode will substitute a membership-based filter.
  return () => true;
}
