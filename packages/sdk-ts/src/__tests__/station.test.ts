import { describe, it, expect, vi, beforeEach } from "vitest";
import { Station } from "../station.js";

const mockFetch = vi.fn();
global.fetch = mockFetch;

const BASE_URL = "http://localhost:3100";
const API_KEY = "ck_test_key_123";

function makeStation() {
  return new Station({ baseUrl: BASE_URL, apiKey: API_KEY });
}

function jsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("Station", () => {
  describe("review()", () => {
    it("sends POST to correct URL with auth header and body, returns review object", async () => {
      const reviewData = {
        id: "rev_001",
        status: "pending",
        template_slug: "deploy",
        priority: "high",
      };
      mockFetch.mockReturnValueOnce(jsonResponse(reviewData));

      const station = makeStation();
      const result = await station.review({
        template: "deploy",
        payload: { service: "api", version: "1.2.0" },
        callback_url: "https://example.com/webhook",
        priority: "high",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/v1/reviews`);
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      });
      const body = JSON.parse(init.body);
      expect(body.template).toBe("deploy");
      expect(body.payload).toEqual({ service: "api", version: "1.2.0" });
      expect(body.callback_url).toBe("https://example.com/webhook");
      expect(body.priority).toBe("high");
      expect(result).toEqual(reviewData);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockReturnValueOnce(
        jsonResponse({ message: "Missing required fields: template, payload, callback_url" }, 400)
      );

      const station = makeStation();
      await expect(
        station.review({
          template: "",
          payload: {},
          callback_url: "",
        })
      ).rejects.toThrow("Missing required fields: template, payload, callback_url");
    });
  });

  describe("reviewAndWait()", () => {
    it("polls until status is decided, returns final review", async () => {
      const createdReview = { id: "rev_002", status: "pending" };
      const pendingReview = { id: "rev_002", status: "pending" };
      const decidedReview = { id: "rev_002", status: "decided", decision: "approved" };

      mockFetch
        .mockReturnValueOnce(jsonResponse(createdReview)) // POST create
        .mockReturnValueOnce(jsonResponse(pendingReview)) // GET poll 1
        .mockReturnValueOnce(jsonResponse(decidedReview)); // GET poll 2

      const station = makeStation();
      const result = await station.reviewAndWait({
        template: "deploy",
        payload: { service: "api" },
        callback_url: "https://example.com/webhook",
        pollIntervalMs: 10,
        timeoutMs: 5000,
      });

      expect(result).toEqual(decidedReview);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // First call is POST (create)
      expect(mockFetch.mock.calls[0][1].method).toBe("POST");
      // Subsequent calls are GET (poll)
      expect(mockFetch.mock.calls[1][0]).toBe(`${BASE_URL}/api/v1/reviews/rev_002`);
      expect(mockFetch.mock.calls[1][1].method).toBe("GET");
      expect(mockFetch.mock.calls[2][0]).toBe(`${BASE_URL}/api/v1/reviews/rev_002`);
      expect(mockFetch.mock.calls[2][1].method).toBe("GET");
    });

    it("does NOT resolve on awaiting_iteration / awaiting_external (non-terminal) — keeps polling", async () => {
      const createdReview = { id: "rev_004", status: "pending" };
      const iterationReview = { id: "rev_004", status: "awaiting_iteration" };
      const externalReview = { id: "rev_004", status: "awaiting_external" };
      const decidedReview = { id: "rev_004", status: "decided", decision: "approved" };

      mockFetch
        .mockReturnValueOnce(jsonResponse(createdReview)) // POST create
        .mockReturnValueOnce(jsonResponse(iterationReview)) // GET poll 1 — must NOT resolve
        .mockReturnValueOnce(jsonResponse(externalReview)) // GET poll 2 — must NOT resolve
        .mockReturnValueOnce(jsonResponse(decidedReview)); // GET poll 3 — terminal

      const station = makeStation();
      const result = await station.reviewAndWait({
        template: "deploy",
        payload: { service: "api" },
        callback_url: "https://example.com/webhook",
        pollIntervalMs: 10,
        timeoutMs: 5000,
      });

      // If awaiting_* were wrongly treated as terminal, this would be the
      // iteration review after only 2 calls. It must keep polling to decided.
      expect(result).toEqual(decidedReview);
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("throws on timeout", async () => {
      const createdReview = { id: "rev_003", status: "pending" };
      const pendingReview = { id: "rev_003", status: "pending" };

      mockFetch
        .mockReturnValueOnce(jsonResponse(createdReview)) // POST create
        .mockReturnValue(jsonResponse(pendingReview)); // GET poll always pending

      const station = makeStation();
      await expect(
        station.reviewAndWait({
          template: "deploy",
          payload: { service: "api" },
          callback_url: "https://example.com/webhook",
          pollIntervalMs: 10,
          timeoutMs: 100,
        })
      ).rejects.toThrow("Review rev_003 timed out after 100ms");
    });

    it("does NOT resolve a chain review while its chain run is active; resolves once the run completes", async () => {
      const createdReview = { id: "rev_chain_001", status: "pending" };
      const decidedReview = {
        id: "rev_chain_001",
        status: "decided",
        decision: "approved",
        chain_run_id: "run_001",
      };

      mockFetch
        .mockReturnValueOnce(jsonResponse(createdReview)) // POST create
        .mockReturnValueOnce(jsonResponse(decidedReview)) // GET poll 1 — step 1 decided
        .mockReturnValueOnce(jsonResponse({ status: "active" })) // GET chain check 1 — run still active
        .mockReturnValueOnce(jsonResponse(decidedReview)) // GET poll 2 — same review
        .mockReturnValueOnce(jsonResponse({ status: "completed" })); // GET chain check 2 — run resolved

      const station = makeStation();
      const result = await station.reviewAndWait({
        template: "deploy",
        payload: { service: "api" },
        callback_url: "https://example.com/webhook",
        pollIntervalMs: 10,
        timeoutMs: 5000,
      });

      // If the chain guard were missing, this would resolve after the first
      // poll — with only ONE step's approval, not the whole route's.
      expect(result).toEqual(decidedReview);
      expect(mockFetch).toHaveBeenCalledTimes(5);
      expect(mockFetch.mock.calls[2][0]).toBe(
        `${BASE_URL}/api/v1/reviews/rev_chain_001/chain`,
      );
      expect(mockFetch.mock.calls[4][0]).toBe(
        `${BASE_URL}/api/v1/reviews/rev_chain_001/chain`,
      );
    });

    // The chain guard has to resolve the route's OUTCOME, not merely its
    // timing. Waiting until the run leaves "active" and then handing back the
    // caller's own step review returns decision:"approved" for a request the
    // route refused — the intermediate-vs-final confusion wearing a hat.
    it("a route rejected downstream does not resolve as the caller's own approval", async () => {
      const createdReview = { id: "rev_chain_002", status: "pending" };
      const myStepApproved = {
        id: "rev_chain_002",
        status: "decided",
        decision: "approved",
        chain_run_id: "run_002",
      };
      const theRefusal = {
        id: "rev_vp_refused",
        status: "decided",
        decision: "rejected",
        feedback: "Over budget",
        chain_run_id: "run_002",
      };

      mockFetch
        .mockReturnValueOnce(jsonResponse(createdReview))
        .mockReturnValueOnce(jsonResponse(myStepApproved))
        .mockReturnValueOnce(
          jsonResponse({
            id: "run_002",
            status: "rejected",
            steps: [
              { review_id: "rev_chain_002", decision: "approved" },
              { review_id: "rev_vp_refused", decision: "rejected" },
            ],
          }),
        )
        .mockReturnValueOnce(jsonResponse(theRefusal));

      const station = makeStation();
      const result = await station.reviewAndWait({
        template: "expense",
        payload: { amount: 12000 },
        callback_url: "https://example.com/webhook",
        pollIntervalMs: 10,
        timeoutMs: 5000,
      });

      expect(result).toEqual(theRefusal);
      expect((result as { decision?: string }).decision).toBe("rejected");
    });

    it("an aborted route throws rather than inventing a decision", async () => {
      const createdReview = { id: "rev_chain_003", status: "pending" };
      const myStepApproved = {
        id: "rev_chain_003",
        status: "decided",
        decision: "approved",
        chain_run_id: "run_003",
      };

      mockFetch
        .mockReturnValueOnce(jsonResponse(createdReview))
        .mockReturnValueOnce(jsonResponse(myStepApproved))
        .mockReturnValueOnce(
          jsonResponse({ id: "run_003", status: "aborted", steps: [] }),
        );

      const station = makeStation();
      await expect(
        station.reviewAndWait({
          template: "expense",
          payload: { amount: 12000 },
          callback_url: "https://example.com/webhook",
          pollIntervalMs: 10,
          timeoutMs: 5000,
        }),
      ).rejects.toThrow(/without a decision/);
    });

    it("chain_run_id: null behaves exactly like a non-chain review (no chain lookup, regression fence)", async () => {
      const createdReview = { id: "rev_nochain", status: "pending" };
      const decidedReview = {
        id: "rev_nochain",
        status: "decided",
        decision: "approved",
        chain_run_id: null,
      };

      mockFetch
        .mockReturnValueOnce(jsonResponse(createdReview)) // POST create
        .mockReturnValueOnce(jsonResponse(decidedReview)); // GET poll 1 — terminal, resolves immediately

      const station = makeStation();
      const result = await station.reviewAndWait({
        template: "deploy",
        payload: { service: "api" },
        callback_url: "https://example.com/webhook",
        pollIntervalMs: 10,
        timeoutMs: 5000,
      });

      expect(result).toEqual(decidedReview);
      expect(mockFetch).toHaveBeenCalledTimes(2); // no extra /chain lookup
    });
  });

  describe("waitForDecisionSSE()", () => {
    /** Build a fake ReadableStream that yields each frame string as a chunk. */
    function makeSseBody(frames: string[]) {
      const encoder = new TextEncoder();
      const chunks = frames.map((f) => encoder.encode(f));
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index < chunks.length) {
            controller.enqueue(chunks[index++]);
          } else {
            controller.close();
          }
        },
      });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        body: stream,
        // json() is never called on the stream response — provide a stub
        json: () => Promise.resolve({}),
      };
    }

    it("resolves with final review when review.decided frame matches target review_id", async () => {
      const ticketData = { ticket: "tk_abc123", expires_in: 60 };
      const finalReview = { id: "rev_sse_001", status: "decided", decision: "approved" };

      const openFrame = `data: {"type":"open"}\n\n`;
      const noiseFrame = `data: {"type":"review.created","review_id":"rev_OTHER","project_id":"prj_1"}\n\n`;
      const terminalFrame = `data: {"type":"review.decided","review_id":"rev_sse_001","decision":"approved"}\n\n`;

      mockFetch
        .mockReturnValueOnce(jsonResponse(ticketData)) // POST /api/v1/events/ticket
        .mockReturnValueOnce(Promise.resolve(makeSseBody([openFrame, noiseFrame, terminalFrame]))) // GET /api/v1/events/stream
        .mockReturnValueOnce(jsonResponse(finalReview)); // GET /api/v1/reviews/rev_sse_001

      const station = makeStation();
      const result = await station.waitForDecisionSSE("rev_sse_001");

      expect(result).toEqual(finalReview);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // 1st call: POST ticket
      const [ticketUrl, ticketInit] = mockFetch.mock.calls[0];
      expect(ticketUrl).toBe(`${BASE_URL}/api/v1/events/ticket`);
      expect(ticketInit.method).toBe("POST");
      expect(ticketInit.headers.Authorization).toBe(`Bearer ${API_KEY}`);

      // 2nd call: GET stream with ticket param
      const [streamUrl] = mockFetch.mock.calls[1];
      expect(streamUrl).toContain("/api/v1/events/stream?ticket=tk_abc123");

      // 3rd call: GET final review
      const [reviewUrl, reviewInit] = mockFetch.mock.calls[2];
      expect(reviewUrl).toBe(`${BASE_URL}/api/v1/reviews/rev_sse_001`);
      expect(reviewInit.method).toBe("GET");
    });

    it("resolves on review.expired (also terminal) frame", async () => {
      const ticketData = { ticket: "tk_exp", expires_in: 60 };
      const finalReview = { id: "rev_sse_003", status: "expired" };

      const terminalFrame = `data: {"type":"review.expired","review_id":"rev_sse_003"}\n\n`;

      mockFetch
        .mockReturnValueOnce(jsonResponse(ticketData))
        .mockReturnValueOnce(Promise.resolve(makeSseBody([terminalFrame])))
        .mockReturnValueOnce(jsonResponse(finalReview));

      const station = makeStation();
      const result = await station.waitForDecisionSSE("rev_sse_003");
      expect(result).toEqual(finalReview);
    });

    it("resolves on review.vetoed frame (monitoring terminal — oversight axis)", async () => {
      const ticketData = { ticket: "tk_veto", expires_in: 60 };
      const finalReview = { id: "rev_sse_veto", status: "decided", decision: "rejected" };

      const terminalFrame = `data: {"type":"review.vetoed","review_id":"rev_sse_veto"}\n\n`;

      mockFetch
        .mockReturnValueOnce(jsonResponse(ticketData))
        .mockReturnValueOnce(Promise.resolve(makeSseBody([terminalFrame])))
        .mockReturnValueOnce(jsonResponse(finalReview));

      const station = makeStation();
      const result = await station.waitForDecisionSSE("rev_sse_veto");
      expect(result).toEqual(finalReview);
    });

    it("resolves on review.confirmed frame (monitoring terminal — oversight axis)", async () => {
      const ticketData = { ticket: "tk_conf", expires_in: 60 };
      const finalReview = { id: "rev_sse_conf", status: "decided", decision: "approved" };

      const terminalFrame = `data: {"type":"review.confirmed","review_id":"rev_sse_conf"}\n\n`;

      mockFetch
        .mockReturnValueOnce(jsonResponse(ticketData))
        .mockReturnValueOnce(Promise.resolve(makeSseBody([terminalFrame])))
        .mockReturnValueOnce(jsonResponse(finalReview));

      const station = makeStation();
      const result = await station.waitForDecisionSSE("rev_sse_conf");
      expect(result).toEqual(finalReview);
    });

    it("does NOT resolve early on frames for a different review_id or non-terminal type (review.retried)", async () => {
      const ticketData = { ticket: "tk_test2", expires_in: 60 };
      const finalReview = { id: "rev_sse_002", status: "decided", decision: "approved" };

      // First: decided for a DIFFERENT review — must not trigger resolution
      // Second: review.retried for our review — NOT terminal, must not trigger
      // Third: decided for our review — terminal, triggers resolution
      const otherDecidedFrame = `data: {"type":"review.decided","review_id":"rev_OTHER"}\n\n`;
      const retriedFrame = `data: {"type":"review.retried","review_id":"rev_sse_002"}\n\n`;
      const terminalFrame = `data: {"type":"review.decided","review_id":"rev_sse_002"}\n\n`;

      mockFetch
        .mockReturnValueOnce(jsonResponse(ticketData))
        .mockReturnValueOnce(
          Promise.resolve(makeSseBody([otherDecidedFrame, retriedFrame, terminalFrame])),
        )
        .mockReturnValueOnce(jsonResponse(finalReview));

      const station = makeStation();
      const result = await station.waitForDecisionSSE("rev_sse_002");

      // Must resolve only after the correct terminal frame
      expect(result).toEqual(finalReview);
      // fetch called 3 times: ticket POST + stream GET + final review GET (not more)
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("throws when stream closes without a terminal frame for the target review", async () => {
      const ticketData = { ticket: "tk_closed", expires_in: 60 };

      // Stream ends after an open frame — no terminal frame for our review
      const openFrame = `data: {"type":"open"}\n\n`;

      mockFetch
        .mockReturnValueOnce(jsonResponse(ticketData))
        .mockReturnValueOnce(Promise.resolve(makeSseBody([openFrame])));

      const station = makeStation();
      await expect(station.waitForDecisionSSE("rev_never_decides")).rejects.toThrow(
        "stream closed before review rev_never_decides",
      );
    });

    it("throws on non-ok ticket response", async () => {
      mockFetch.mockReturnValueOnce(jsonResponse({ message: "Unauthorized" }, 401));
      const station = makeStation();
      await expect(station.waitForDecisionSSE("rev_x")).rejects.toThrow("Unauthorized");
    });

    it("throws on non-ok stream response", async () => {
      mockFetch
        .mockReturnValueOnce(jsonResponse({ ticket: "tk_ok", expires_in: 60 }))
        .mockReturnValueOnce(jsonResponse({ message: "Stream unavailable" }, 503));
      const station = makeStation();
      await expect(station.waitForDecisionSSE("rev_x")).rejects.toThrow("Stream unavailable");
    });

    it("rejects with a timeout error when the stream stays open with no terminal frame", async () => {
      // A live-but-silent stream: it emits an open frame, then blocks forever
      // (never a terminal frame, never closes). The AbortController must fire
      // after timeoutMs, error the stream, and surface a clear timeout error —
      // otherwise reader.read() would hang indefinitely. The mock wires the
      // abort signal to error the stream, mirroring undici/browser behavior.
      const encoder = new TextEncoder();
      const openFrame = `data: {"type":"open"}\n\n`;

      mockFetch.mockImplementation((url: string, init: { signal: AbortSignal }) => {
        if (url.endsWith("/api/v1/events/ticket")) {
          return jsonResponse({ ticket: "tk_timeout", expires_in: 60 });
        }
        // stream GET
        const signal = init.signal;
        let sentOpen = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener("abort", () => {
              controller.error(new Error("aborted"));
            });
          },
          pull(controller) {
            if (!sentOpen) {
              sentOpen = true;
              controller.enqueue(encoder.encode(openFrame));
              return;
            }
            // Block until the abort signal errors the stream.
            return new Promise<void>(() => {});
          },
        });
        return Promise.resolve({
          ok: true,
          status: 200,
          statusText: "OK",
          body: stream,
          json: () => Promise.resolve({}),
        });
      });

      const station = makeStation();
      await expect(
        station.waitForDecisionSSE("rev_never", { timeoutMs: 30 }),
      ).rejects.toThrow("review rev_never timed out after 30ms");
    });

    it("does NOT resolve a chain review whose run is still active; polls the chain endpoint until it completes", async () => {
      const decidedReview = {
        id: "rev_sse_chain",
        status: "decided",
        decision: "approved",
        chain_run_id: "run_chain_1",
      };
      const terminalFrame = `data: {"type":"review.decided","review_id":"rev_sse_chain","decision":"approved"}\n\n`;

      mockFetch
        .mockReturnValueOnce(jsonResponse({ ticket: "tk_chain", expires_in: 60 })) // POST ticket
        .mockReturnValueOnce(Promise.resolve(makeSseBody([terminalFrame]))) // GET stream
        .mockReturnValueOnce(jsonResponse(decidedReview)) // GET final review
        .mockReturnValueOnce(jsonResponse({ status: "active" })) // GET chain check 1 — still active
        .mockReturnValueOnce(jsonResponse({ status: "completed" })); // GET chain check 2 — resolved

      const station = makeStation();
      const result = await station.waitForDecisionSSE("rev_sse_chain");

      // If the chain guard were missing, this would resolve on the terminal
      // frame alone — with only ONE step's approval, not the whole route's.
      expect(result).toEqual(decidedReview);
      expect(mockFetch).toHaveBeenCalledTimes(5);
      expect(mockFetch.mock.calls[3][0]).toBe(
        `${BASE_URL}/api/v1/reviews/rev_sse_chain/chain`,
      );
      expect(mockFetch.mock.calls[4][0]).toBe(
        `${BASE_URL}/api/v1/reviews/rev_sse_chain/chain`,
      );
    }, 10000);

    it("chain_run_id: null on the fetched review resolves immediately (no chain lookup, regression fence)", async () => {
      const finalReview = {
        id: "rev_sse_nochain",
        status: "decided",
        decision: "approved",
        chain_run_id: null,
      };
      const terminalFrame = `data: {"type":"review.decided","review_id":"rev_sse_nochain"}\n\n`;

      mockFetch
        .mockReturnValueOnce(jsonResponse({ ticket: "tk_nochain", expires_in: 60 }))
        .mockReturnValueOnce(Promise.resolve(makeSseBody([terminalFrame])))
        .mockReturnValueOnce(jsonResponse(finalReview));

      const station = makeStation();
      const result = await station.waitForDecisionSSE("rev_sse_nochain");

      expect(result).toEqual(finalReview);
      expect(mockFetch).toHaveBeenCalledTimes(3); // no extra /chain lookup
    });
  });

  describe("feedback()", () => {
    it("sends GET with query params, returns paginated response", async () => {
      const feedbackData = {
        items: [
          {
            review_id: "rev_010",
            template: "deploy",
            decision: "approved",
            original_payload: { service: "api" },
            decided_at: "2026-01-15T10:00:00Z",
          },
        ],
        total: 1,
        has_more: false,
      };
      mockFetch.mockReturnValueOnce(jsonResponse(feedbackData));

      const station = makeStation();
      const result = await station.feedback({
        template: "deploy",
        outcome: "approved",
        limit: 10,
        offset: 0,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/v1/feedback?template=deploy&outcome=approved&limit=10&offset=0`);
      expect(init.method).toBe("GET");
      expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(result).toEqual(feedbackData);
    });

    it("with no params sends GET without query string", async () => {
      const feedbackData = {
        items: [],
        total: 0,
        has_more: false,
      };
      mockFetch.mockReturnValueOnce(jsonResponse(feedbackData));

      const station = makeStation();
      const result = await station.feedback();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/api/v1/feedback`);
      expect(result).toEqual(feedbackData);
    });
  });
});
