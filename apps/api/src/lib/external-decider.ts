import type { ActionActor } from "../services/reviews/actions";

/**
 * Builds the actor for a decision made through a review link.
 *
 * `reviews.decided_by` is contracted to hold a human-readable decider, but
 * both recipient decide paths passed the raw token id, so History printed
 * `gw_tok_...` where a person belongs. This keeps the token id on `id` — it
 * still feeds `last_action_by` and the audit line, where being unambiguous
 * matters more than being readable — and puts the person on `display`.
 *
 * The verified identity is NOT simply the OTP email. The `account` tier
 * proves who someone is by making them sign in, and its identity arrives on
 * the session rather than in `verifiedEmail`, which stays null there (see
 * gateRecipientAuth in token-reviews-action.ts). Reading only `verifiedEmail`
 * would stamp the tier with the STRONGEST proof as unverified.
 *
 * A public link proves nothing, so it falls back to `recipient_label` — free
 * text the sharer typed — and reports verified:false so the screen can say so
 * rather than presenting it as a confirmed name.
 */
export function externalDeciderActor(
  tokenRecord: { id: string; recipient_label?: string | null },
  auth: { verifiedEmail?: string | null; accountSession?: { email?: string | null } | null },
): ActionActor {
  const identity =
    auth.verifiedEmail?.trim() || auth.accountSession?.email?.trim() || null;
  const label = tokenRecord.recipient_label?.trim() || null;

  return {
    kind: "external",
    id: tokenRecord.id,
    // Last resort only: a token row cannot exist without a recipient_label
    // (the create schema requires min(1)), so this is unreachable for rows
    // minted through the API rather than seeded by hand.
    display: identity ?? label ?? "External reviewer",
    verified: Boolean(identity),
    ...(identity ? { email: identity } : {}),
  };
}
