-- Migration 032: backfill last_action_* for historical decided reviews
-- Phase: configurable-actions Phase 1 (read-only context — no behavior change for live code paths)
--
-- Strategy: for status='decided' rows, derive last_action_id from canonical
-- decision values ('approved'→'approve', 'rejected'→'reject'). last_action_kind
-- is 'decision' for any decided row. last_action_at = decided_at. last_action_by
-- = 'reviewer:' || decided_by when present, else NULL.
--
-- Migration 028 already normalized legacy 'approve'/'reject' decision strings
-- to canonical 'approved'/'rejected' (see 028 lines 46-47), so the CASE below
-- is complete for in-production data.
--
-- Non-decided rows (pending, awaiting_iteration, expired, archived) are NOT
-- backfilled — the spec scopes backfill to decided reviews. NULL last_action_*
-- on those rows is the correct historical state.
--
-- Idempotent: WHERE last_action_id IS NULL guard. Re-running this migration
-- is a no-op once any row has been populated by Phase 2's action endpoint.

UPDATE reviews
SET
  last_action_id = CASE decision
    WHEN 'approved' THEN 'approve'
    WHEN 'rejected' THEN 'reject'
  END,
  last_action_kind = 'decision',
  last_action_at = decided_at,
  last_action_by = CASE
    WHEN decided_by IS NOT NULL THEN 'reviewer:' || decided_by
    ELSE NULL
  END
WHERE
  status = 'decided'
  AND decision IN ('approved', 'rejected')
  AND last_action_id IS NULL;
