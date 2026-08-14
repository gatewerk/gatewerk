import { describe, it, expect } from "vitest";
import { PLAN_LIMITS } from "./cloud";

/**
 * These assert the LITERAL prices, which is unusual and deliberate.
 *
 * Every other price in the codebase now derives from PLAN_LIMITS: the trial
 * emails, the tombstone MRR calculation. That is the right shape, but it means
 * no other test can catch PLAN_LIMITS itself being wrong, because they all
 * agree with whatever it says. A single source of truth needs exactly one test
 * that does not trust it.
 *
 * This is the file that would have caught the real bug: Solo sat at 1200 for
 * months while the agreed price was 600, and it reached customer-facing email
 * copy quoting double the actual price.
 */
describe("PLAN_LIMITS prices", () => {
  it("Solo is 6 dollars per month", () => {
    expect(PLAN_LIMITS.solo.price).toBe(600);
  });

  it("Team is 49 dollars per month", () => {
    expect(PLAN_LIMITS.team.price).toBe(4900);
  });

  it("Business is 149 dollars per month", () => {
    expect(PLAN_LIMITS.business.price).toBe(14900);
  });

  it("free tiers are actually free", () => {
    expect(PLAN_LIMITS.trial.price).toBe(0);
    expect(PLAN_LIMITS.community.price).toBe(0);
  });

  it("every price is a whole number of cents", () => {
    // A fractional cent would render as "6.005 dollars" wherever a template
    // divides by 100, and would silently misreport revenue in the tombstone.
    for (const [plan, limits] of Object.entries(PLAN_LIMITS)) {
      expect(Number.isInteger(limits.price), `${plan} price must be an integer`).toBe(true);
      expect(limits.price, `${plan} price must not be negative`).toBeGreaterThanOrEqual(0);
    }
  });
});
