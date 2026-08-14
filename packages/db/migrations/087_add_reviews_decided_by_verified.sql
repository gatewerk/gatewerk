-- reviews.decided_by is meant to hold a human-readable decider (see the
-- "Legacy SDK contract" note in services/reviews/actions.ts). Decisions made
-- through a review link violated that: they stored the raw token id, so the
-- History screen shows `gw_tok_...` where a person belongs.
--
-- Fixing the write path is not enough on its own. A public link verifies
-- nobody, so its decider is `recipient_label` — free text the SHARER typed.
-- That is worth showing, but only if the screen can say it was never
-- confirmed, and `decided_by` alone cannot carry that distinction.
--
-- Stored on the review rather than joined from review_tokens at read time:
-- History is a list screen, and this would otherwise be a per-row lookup on
-- every render of every page.
--
-- NULL means "no claim" — not decided, or decided before this column existed
-- and not recoverable below. Readers must treat NULL as "show no marker",
-- never as "unverified".

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS decided_by_verified BOOLEAN;

-- Backfill 1: decisions made through a link. The token row is the authority.
-- A verified address exists exactly when the recipient proved control of it
-- (email_otp) or signed in (account); a public link never has one.
--
-- Joined on t.id = r.decided_by, NOT on t.review_id = r.id. A review can hold
-- several used tokens — dev data has one with two, decided by different people
-- ten hours apart — and `UPDATE ... FROM` with a multi-row match picks one
-- arbitrarily. That would have stamped the wrong human onto an audit record,
-- silently and unrepeatably. The broken value we are replacing IS the token
-- id, which makes it an exact key back to the row that actually decided.
UPDATE reviews r
SET
  decided_by = COALESCE(NULLIF(t.decided_by_email, ''), NULLIF(t.recipient_label, ''), r.decided_by),
  decided_by_verified = (t.decided_by_email IS NOT NULL AND t.decided_by_email <> '')
FROM review_tokens t
WHERE t.id = r.decided_by
  AND r.decided_by IS NOT NULL
  AND r.decided_by LIKE 'gw_tok_%';

-- Backfill 2: everything else that was already decided got there through a
-- signed-in reviewer, an API key or the system, all of which are identified.
UPDATE reviews
SET decided_by_verified = TRUE
WHERE decided_by IS NOT NULL
  AND decided_by NOT LIKE 'gw_tok_%'
  AND decided_by_verified IS NULL;

-- DOWN
-- ALTER TABLE reviews DROP COLUMN IF EXISTS decided_by_verified;
