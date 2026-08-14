import { describe, it, expect } from "vitest";
import { TicketStore, type TicketContext } from "../services/ticket-store";

const apiKeyContext: TicketContext = {
  authType: "apikey",
  projectId: "gw_prj_a",
  apiKeyId: "gw_key_a",
};

const sessionContext: TicketContext = {
  authType: "session",
  reviewerId: "gw_usr_a",
  reviewerEmail: "reviewer@example.com",
};

describe("TicketStore", () => {
  it("issues a hex ticket with a positive TTL", () => {
    const store = new TicketStore();
    const { ticket, expiresInSeconds } = store.issue(apiKeyContext);
    expect(ticket).toMatch(/^[0-9a-f]+$/);
    expect(ticket.length).toBeGreaterThanOrEqual(32);
    expect(expiresInSeconds).toBeGreaterThan(0);
  });

  it("returns the original context on first consume", () => {
    const store = new TicketStore();
    const { ticket } = store.issue(apiKeyContext);
    expect(store.consume(ticket)).toEqual(apiKeyContext);
  });

  it("rejects a second consume of the same ticket (single-use)", () => {
    const store = new TicketStore();
    const { ticket } = store.issue(sessionContext);
    expect(store.consume(ticket)).toEqual(sessionContext);
    expect(store.consume(ticket)).toBeNull();
  });

  it("returns null for an unknown ticket", () => {
    const store = new TicketStore();
    expect(store.consume("deadbeef")).toBeNull();
  });

  it("returns null for an expired ticket and removes it on consume", () => {
    const store = new TicketStore(1); // 1ms TTL
    const { ticket } = store.issue(apiKeyContext);
    // Busy-wait past expiry — 1ms is enough for a setTimeout(0) alternative
    // in vitest, but a tight spin is deterministic.
    const deadline = Date.now() + 5;
    while (Date.now() < deadline) { /* spin */ }
    expect(store.consume(ticket)).toBeNull();
    // Ticket is also removed from internal state (no replay window).
    expect(store.consume(ticket)).toBeNull();
  });

  it("does not leak tickets after they are consumed", () => {
    const store = new TicketStore();
    const { ticket: a } = store.issue(apiKeyContext);
    const { ticket: b } = store.issue(sessionContext);
    expect(store.size()).toBe(2);
    store.consume(a);
    expect(store.size()).toBe(1);
    store.consume(b);
    expect(store.size()).toBe(0);
  });
});
