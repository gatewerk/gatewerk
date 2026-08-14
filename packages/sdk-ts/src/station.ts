import type { PaginatedResponse, FeedbackItem, ReviewStatus } from "@gatewerk/shared";
/**
 * Inlined from @gatewerk/shared's enums.ts rather than imported.
 *
 * `@gatewerk/shared` is `private: true` and is never published, so ANY
 * runtime import of it survives compilation into dist/ and makes the
 * published SDK unresolvable: "Cannot find package '@gatewerk/shared'".
 * resources/chains.ts and resources/notes.ts already say the SDK cannot
 * depend on shared at runtime; this file was the one place that did, via a
 * value import sitting next to the type-only ones (those erase, this did
 * not). It shipped in gatewerk@0.1.0 and broke `npx @gatewerk/mcp`.
 *
 * Keep in step with TERMINAL_REVIEW_STATUSES in packages/shared/src/enums.ts.
 * Duplication is the price of the SDK having no workspace dependency at all.
 */
const TERMINAL_REVIEW_STATUSES: readonly string[] = ["decided", "expired", "archived"];

function isTerminalReviewStatus(s: ReviewStatus): boolean {
  return TERMINAL_REVIEW_STATUSES.includes(s);
}

// Fallback cadence for the chain guard inside waitForDecisionSSE, which has
// no caller-supplied poll interval in scope (only timeoutMs). reviewAndWait
// doesn't need an equivalent constant — it reuses its own pollIntervalMs.
const CHAIN_POLL_INTERVAL_MS = 1000;

export interface StationConfig {
  baseUrl: string;
  apiKey: string;
}

export interface ReviewOptions {
  template: string;
  payload: Record<string, unknown>;
  callback_url: string;
  priority?: string;
  actions?: string[];
  confidence?: number;
  irreversibility?: string;
  assignee?: string;
  metadata?: Record<string, unknown>;
  timeout?: { action: string; seconds: number };
  /**
   * Oversight axis for the review. "monitoring" creates a non-blocking gate
   * — the agent continues immediately while a human reviews asynchronously.
   * "blocking" (default) halts the agent until a human decides.
   * See HRP Monitoring Outcomes for the full outcome matrix.
   * Note: supplying timeout.action alongside oversight:"monitoring" is a
   * schema validation error (the API rejects it before any monitoring_forbids_*
   * error code is surfaced).
   */
  oversight?: "blocking" | "monitoring";
}

export interface ReviewAndWaitOptions extends ReviewOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export interface WaitForDecisionOptions {
  timeoutMs?: number;
}

export interface FeedbackOptions {
  template?: string;
  outcome?: string;
  limit?: number;
  offset?: number;
}

export class Station {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: StationConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Resolve what a chain-attached review's wait should return, or null when
   * the route is still running.
   *
   * A plain review (chain_run_id null/absent) resolves to itself as soon as it
   * is terminal. A chain review reaching a terminal status only means ONE
   * step's reviewer decided, so:
   *
   *   run still active   -> null, keep waiting
   *   run completed      -> this review; the route authorized and this step is
   *                         part of how it got there
   *   run rejected       -> the review of the step that rejected. Returning
   *                         THIS review would hand back decision:"approved"
   *                         for a request the route refused, which is the
   *                         intermediate-vs-final confusion wearing a
   *                         different hat
   *   run aborted        -> throw. An operator force-stopped the route; there
   *                         is no decision to report and pretending otherwise
   *                         is worse than failing
   *
   * Gate on the review object, never on an SSE frame: the server's chain
   * context resolver returns null when the chain row is missing and the frame
   * then goes out indistinguishable from a non-chain emit.
   *
   * Caveat, documented rather than handled: under the rejection policy
   * `continue` (held back at launch) a route can complete with a rejected step,
   * and this returns that step's own review.
   */
  private async resolveChainOutcome(
    review: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    const chainRunId = review.chain_run_id as string | null | undefined;
    if (chainRunId == null) return review;

    const chain = (await this.getJson(
      `/api/v1/reviews/${review.id as string}/chain`,
      signal,
    )) as {
      id?: string;
      status?: string;
      steps?: Array<{ review_id: string | null; decision: string | null }>;
    };

    if (chain.status === "active") return null;
    if (chain.status === "completed") return review;

    if (chain.status === "rejected") {
      const refusing = (chain.steps ?? []).find(
        (st) => st.decision === "rejected" || st.decision === "expired",
      );
      if (refusing?.review_id && refusing.review_id !== review.id) {
        return (await this.getJson(
          `/api/v1/reviews/${refusing.review_id}`,
          signal,
        )) as Record<string, unknown>;
      }
      return review;
    }

    throw new Error(
      `Chain ${chain.id ?? chainRunId} ended "${chain.status}" without a decision; review ${review.id as string} was not authorized`,
    );
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers(),
      signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(
        (body as { error?: { message?: string }; message?: string }).error?.message ||
          (body as { message?: string }).message ||
          `GET ${path} failed with status ${res.status}`,
      );
    }
    return res.json();
  }

  async review(opts: ReviewOptions): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/api/v1/reviews`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(opts),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(body.error?.message || body.message || `Request failed with status ${res.status}`);
    }

    return res.json();
  }

  async reviewAndWait(opts: ReviewAndWaitOptions): Promise<Record<string, unknown>> {
    const pollIntervalMs = opts.pollIntervalMs ?? 1000;
    const timeoutMs = opts.timeoutMs ?? 300_000;

    const { pollIntervalMs: _p, timeoutMs: _t, ...reviewOpts } = opts;
    const created = await this.review(reviewOpts);
    const reviewId = created.id as string;

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const res = await fetch(`${this.baseUrl}/api/v1/reviews/${reviewId}`, {
        method: "GET",
        headers: this.headers(),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(body.error?.message || body.message || `Request failed with status ${res.status}`);
      }

      const review = await res.json();

      // Keep polling while the review is non-terminal. `awaiting_iteration` /
      // `awaiting_external` are NOT done — returning on them hands the caller a
      // half-formed review. Single canonical check shared across the SDKs.
      if (isTerminalReviewStatus(review.status as ReviewStatus)) {
        // A chain review reaching a terminal status is only ONE step's
        // decision, not the request's authorization — see
        // resolveChainOutcome. Null means the route is still running, so we
        // fall through and keep polling exactly like a non-terminal review.
        const outcome = await this.resolveChainOutcome(review);
        if (outcome !== null) {
          return outcome;
        }
      }

      if (Date.now() + pollIntervalMs > deadline) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Review ${reviewId} timed out after ${timeoutMs}ms`);
  }

  async waitForDecisionSSE(
    reviewId: string,
    opts?: WaitForDecisionOptions,
  ): Promise<Record<string, unknown>> {
    const timeoutMs = opts?.timeoutMs ?? 300_000;

    // Hard wall-clock bound. A dead-but-open stream (no heartbeat, no FIN)
    // would otherwise block reader.read() forever, making the deadline
    // unreachable. AbortController tears down the socket on timeout so the
    // fetch/reader rejects instead of hanging.
    const controller = new AbortController();
    const timedOut = { value: false };
    const timer = setTimeout(() => {
      timedOut.value = true;
      controller.abort();
    }, timeoutMs);

    try {
      // 1. Obtain a short-lived streaming ticket
      const ticketRes = await fetch(`${this.baseUrl}/api/v1/events/ticket`, {
        method: "POST",
        headers: this.headers(),
        signal: controller.signal,
      });
      if (!ticketRes.ok) {
        const body = await ticketRes.json().catch(() => ({ message: ticketRes.statusText }));
        throw new Error(
          (body as { error?: { message?: string }; message?: string }).error?.message ||
            (body as { message?: string }).message ||
            `Ticket request failed with status ${ticketRes.status}`,
        );
      }
      const { ticket } = (await ticketRes.json()) as { ticket: string };

      // 2. Open the SSE stream (no double-slash — baseUrl already has trailing slash stripped)
      const streamUrl = `${this.baseUrl}/api/v1/events/stream?ticket=${encodeURIComponent(ticket)}`;
      const streamRes = await fetch(streamUrl, {
        headers: this.headers(),
        signal: controller.signal,
      });
      if (!streamRes.ok) {
        const body = await streamRes.json().catch(() => ({ message: streamRes.statusText }));
        throw new Error(
          (body as { error?: { message?: string }; message?: string }).error?.message ||
            (body as { message?: string }).message ||
            `Stream request failed with status ${streamRes.status}`,
        );
      }

      // 3. Read stream via ReadableStream reader (Node 18+ / browser — no eventsource dep)
      if (!streamRes.body) {
        throw new Error("waitForDecisionSSE: stream response has no readable body");
      }
      const reader = streamRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Terminal event types for monitoring reviews (review.vetoed /
      // review.confirmed) were added with the oversight axis — without them a
      // wait on a monitoring review hangs to wall-clock timeout.
      const TERMINAL_TYPES = new Set(["review.decided", "review.expired", "review.vetoed", "review.confirmed"]);

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            throw new Error(
              `waitForDecisionSSE: stream closed before review ${reviewId} reached a terminal state`,
            );
          }

          buffer += decoder.decode(value, { stream: true });

          // Split on SSE frame boundary (\n\n); last element may be incomplete
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";

          for (const frame of frames) {
            if (!frame.trim()) continue;

            // Collect data: lines (multi-line data fields are joined)
            const dataLines = frame
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice("data:".length).trim());

            if (dataLines.length === 0) continue; // heartbeat comment (: ...) or empty

            let payload: Record<string, unknown>;
            try {
              payload = JSON.parse(dataLines.join("")) as Record<string, unknown>;
            } catch {
              continue;
            }

            // Terminal when this frame targets our review and carries a final-decision type
            if (
              payload.review_id === reviewId &&
              typeof payload.type === "string" &&
              TERMINAL_TYPES.has(payload.type)
            ) {
              reader.cancel().catch(() => {});

              // 4. Fetch authoritative review state and resolve
              const finalRes = await fetch(`${this.baseUrl}/api/v1/reviews/${reviewId}`, {
                method: "GET",
                headers: this.headers(),
                signal: controller.signal,
              });
              if (!finalRes.ok) {
                const body = await finalRes.json().catch(() => ({ message: finalRes.statusText }));
                throw new Error(
                  (body as { error?: { message?: string }; message?: string }).error?.message ||
                    (body as { message?: string }).message ||
                    `Final review GET failed with status ${finalRes.status}`,
                );
              }
              const finalReview = (await finalRes.json()) as Record<string, unknown>;

              // Chain guard: the terminal frame only proves THIS review
              // decided. If it belongs to a chain, no further SSE frame will
              // ever target this review_id again (it has already reached a
              // terminal status), so poll the chain endpoint instead of
              // continuing to read the stream.
              let outcome = await this.resolveChainOutcome(finalReview, controller.signal);
              while (outcome === null) {
                await new Promise((resolve) => setTimeout(resolve, CHAIN_POLL_INTERVAL_MS));
                outcome = await this.resolveChainOutcome(finalReview, controller.signal);
              }

              return outcome;
            }
          }
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    } catch (err) {
      // The abort fired: surface a clear timeout error instead of the raw
      // AbortError so callers get a deterministic, documented failure.
      if (timedOut.value) {
        throw new Error(
          `waitForDecisionSSE: review ${reviewId} timed out after ${timeoutMs}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async feedback(opts?: FeedbackOptions): Promise<PaginatedResponse<FeedbackItem>> {
    const params = new URLSearchParams();

    if (opts?.template) params.set("template", opts.template);
    if (opts?.outcome) params.set("outcome", opts.outcome);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));

    const qs = params.toString();
    const url = `${this.baseUrl}/api/v1/feedback${qs ? `?${qs}` : ""}`;

    const res = await fetch(url, {
      method: "GET",
      headers: this.headers(),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(body.error?.message || body.message || `Request failed with status ${res.status}`);
    }

    return res.json();
  }
}
