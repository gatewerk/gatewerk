# The audit-write contract

**Status:** Decided.

---

## The question

245 decision-state transitions were enumerated. 141 of them write their audit
row fire-and-forget:

```js
auditService.log({...}).catch(() => {});
```

Two write it in the same transaction as the state change. `createAuditService.log()`
opened its own `db.transaction`, so **no caller could enlist it even if it wanted to**.

The question posed: does a decision **fail** when its audit write fails
(fail-closed), or **succeed and record the failure**?

## The answer

**Neither, globally. The tier is a property of the call site, and it must be
declared there.**

A single global rule is wrong in both directions. Fail-closed everywhere means a
transient audit-table problem stops emails sending and blocks reads — an
availability catastrophe caused by a logging subsystem. Best-effort everywhere
is what we have now, and it means the product's central claim rests on a write
nobody checks.

So the contract is three tiers, chosen per call site by one test:

> **Is the audit row the only evidence this happened?**

### Tier 1 — SEALED

`auditService.log(data, { tx })`

The audit row is written **inside the caller's transaction**. If the audit write
fails, the state change rolls back. If the state change fails, the audit row
rolls back with it. There is no window in which one exists without the other.

**Use when the audit row is the sole record of an authority exercise or an
irreversible act.** If the row is lost, the event becomes unprovable and
unreconstructible.

Qualifying sites:

| Site | Why sealed |
|---|---|
| `routes/reviews/decide.ts` `chain.admin_bypass` | The only record that an admin decided a step they were not assigned to. Nothing else in the schema retains it. |
| `routes/reviews/bulk.ts` `review.bulk_deleted` | `details.ids` is the only surviving record of which reviews were destroyed. The rows are gone. |
| `routes/reviews/crud.ts` hard `DELETE /reviews/:id` | Cascades to versions, notes, tokens. Nothing remains to reconstruct from. |
| `routes/settings/hmac.ts` `hmac_secret.revealed` | The endpoint exists *only* to make secret disclosure auditable. A lost row defeats its entire purpose. |
| `routes/api-keys/crud.ts` create + scope change | An API key is a decision-capable principal. Its creation and its authority are otherwise unattributed. |

### Tier 2 — REQUIRED

`await auditService.log(data)` — awaited, failure propagates.

The write is awaited and a failure surfaces as a request error. The operation
does **not** get to report success while its proof silently failed.

**Use when the state change is durable and self-describing, but the audit row
carries authority context the state does not.** A review row records *what* was
decided; only the audit row records *by whom, under what authority*.

Qualifying sites: `services/reviews/execute-action.ts` (every human
approve/reject/request-changes), `routes/reviews/monitoring.ts` (the only record
of a HOTL human attestation), template config changes, and the timeout worker's
unattended outcomes.

### Tier 3 — BEST_EFFORT

`auditService.logBestEffort(data, reason)`

Failure is **logged loudly** and the operation continues. `reason` is required
and is the argument for why losing this row is tolerable.

**Use when the audited event is a side-effect of an operation whose success must
not depend on the audit subsystem.** An audit-write failure must not stop an
email from sending.

Qualifying sites: notification delivery outcomes, read-path access logging,
digest bookkeeping.

---

## Why `reason` is mandatory

The defect being fixed is not only that failures were swallowed. It is that
**a deliberate best-effort write and an oversight were spelled identically.**

`.catch(() => {})` appears 34 times in `apps/api`. Reading the code, there is no
way to tell which of those were reasoned about and which were copied from the
line above — classifying them as deliberate or accidental takes a manual audit
every time, precisely because the code does not say.

`logBestEffort(data, reason)` makes the tier greppable and the argument local. A
reviewer can disagree with a `reason`; they cannot disagree with `.catch(() => {})`
because it makes no claim.

## Why not fail-closed everywhere

Considered and rejected. The audit chain would become a single point of failure
for the entire product: a full disk, a lock timeout, or a migration holding an
exclusive lock on `audit_log` would take down decisions, notifications and reads
together. For an oversight product, being *unavailable* during an incident is
its own kind of failure — the reviewer cannot approve the rollback that fixes
the outage.

Sealing the sites where proof is irreplaceable gets the guarantee that matters
without coupling availability to the logging path.

---

## The enabling change

`createAuditService.log()` now takes an optional transaction handle:

```ts
log(data: AuditWrite, opts?: { tx?: AuditTx })
```

Two correctness details, both non-obvious:

1. **An enlisted write never trusts the in-memory `prev_signature`.** It reads
   the partition tail inside the caller's transaction, where it can see that
   transaction's own uncommitted rows.

2. **An enlisted write does not advance the in-memory chain** (`nextPrev: null`).
   The caller's transaction may still roll back. If the chain advanced to a
   signature that then vanished, every later write in that partition would link
   to a phantom row and `verify()` would report `chain_break` on rows nobody
   touched — the audit chain accusing itself of tampering because of an ordinary
   rolled-back transaction. Instead the partition is invalidated and the next
   writer re-reads the real tail.

   This is pinned by `__tests__/audit-enlisted-write.test.ts` test 3, which was
   mutation-proven on 2026-07-31: changing `nextPrev: null` to
   `nextPrev: signature` turns that test red with `valid === false`, and leaves
   the other four green.

The advisory lock is acquired on the caller's handle, so when enlisted it is
held for the whole of the caller's transaction — the state change and its proof
serialize together against other writers in the partition.

## What is deliberately not changed

Existing `.catch(() => {})` sites are migrated tier by tier, not in one sweep.
An audit row appearing where none appeared before changes what `verify()` covers
and what the ledger UI shows; doing 141 at once would make any regression
untraceable. The sites listed under Tier 1 and Tier 2 above are the ones whose
loss is load-bearing for the launch claim.
