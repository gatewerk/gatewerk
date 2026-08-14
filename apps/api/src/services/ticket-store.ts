import { randomBytes } from "crypto";

export interface TicketContext {
  authType: "apikey" | "session";
  projectId?: string;
  apiKeyId?: string;
  reviewerId?: string;
  reviewerEmail?: string;
}

interface TicketEntry {
  context: TicketContext;
  expiresAt: number;
}

// Short-lived single-use tickets for SSE stream authentication.
//
// The SSE stream endpoint can't use `Authorization: Bearer ...` because the
// browser EventSource API cannot attach custom headers. Passing the long-
// lived JWT as a query param would leak it into server/proxy access logs.
// Instead, the dashboard exchanges its Bearer token for a 60-second single-
// use ticket (via POST /api/v1/events/ticket), then opens the stream with
// the ticket in the query string. The ticket is consumed on first use.
//
// In-process storage is fine for OSS standalone deployments (single API
// process). Cloud-tier multi-instance setups will swap this for a Redis-
// backed store; the interface here is intentionally minimal so that swap
// is a drop-in.
export class TicketStore {
  private readonly tickets = new Map<string, TicketEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = 60_000) {
    this.ttlMs = ttlMs;
  }

  issue(context: TicketContext): { ticket: string; expiresInSeconds: number } {
    this.sweep();
    const ticket = randomBytes(24).toString("hex");
    this.tickets.set(ticket, {
      context,
      expiresAt: Date.now() + this.ttlMs,
    });
    return { ticket, expiresInSeconds: Math.floor(this.ttlMs / 1000) };
  }

  consume(ticket: string): TicketContext | null {
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    // Single-use: always delete, even if expired (prevents replay windows).
    this.tickets.delete(ticket);
    if (entry.expiresAt <= Date.now()) return null;
    return entry.context;
  }

  // Test helper: visibility into current store size.
  size(): number {
    return this.tickets.size;
  }

  private sweep(): void {
    if (this.tickets.size < 32) return; // amortize — don't scan on every issue.
    const now = Date.now();
    for (const [ticket, entry] of this.tickets) {
      if (entry.expiresAt <= now) this.tickets.delete(ticket);
    }
  }
}
