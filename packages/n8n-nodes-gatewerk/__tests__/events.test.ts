import { describe, it, expect } from 'vitest';
import {
  classifyGatewerkEvent,
  toOutputJson,
  GATEWERK_OUTCOMES,
  type GatewerkEventClass,
  type GatewerkOutcome,
} from '../helpers/events';
import { shouldResumeOn } from '../helpers/review';

/**
 * Every fixture below is a REAL body shape, transcribed from the site in
 * apps/api that constructs it. The file:line for each is in the `builtAt` field
 * so a future reader can re-verify rather than trust this file.
 *
 * The point of the table is coverage of the *whole* emitter surface: the node
 * used to branch on two event types and treat all remaining fourteen as
 * "decided", which is how a sent-back review resumed a workflow with
 * `decision: undefined`.
 */

interface Case {
  name: string;
  builtAt: string;
  body: Record<string, unknown>;
  expect: {
    eventClass: GatewerkEventClass;
    outcome: GatewerkOutcome;
    terminal: boolean;
    reviewId?: string;
    decision?: string;
  };
}

const CASES: Case[] = [
  // ---------------- terminal decisions ----------------
  {
    name: 'review.decided — approved',
    builtAt: 'services/webhooks.ts:393-410',
    body: {
      type: 'review.decided',
      review_id: 'gw_rev_1',
      decision: 'approved',
      decided_at: '2026-07-28T10:00:00.000Z',
      was_edited: false,
      reviewer: 'ana@example.com',
    },
    expect: {
      eventClass: 'decision',
      outcome: 'approved',
      terminal: true,
      reviewId: 'gw_rev_1',
      decision: 'approved',
    },
  },
  {
    name: 'review.decided — rejected',
    builtAt: 'services/webhooks.ts:393-410',
    body: {
      type: 'review.decided',
      review_id: 'gw_rev_2',
      decision: 'rejected',
      decided_at: '2026-07-28T10:00:00.000Z',
      was_edited: false,
      feedback: 'tone is wrong',
    },
    expect: {
      eventClass: 'decision',
      outcome: 'rejected',
      terminal: true,
      reviewId: 'gw_rev_2',
      decision: 'rejected',
    },
  },
  {
    name: 'review.decided — approved WITH edits routes to the edited branch',
    builtAt: 'services/webhooks.ts:393-410',
    body: {
      type: 'review.decided',
      review_id: 'gw_rev_3',
      decision: 'approved',
      was_edited: true,
      edited_payload: { subject: 'Revised' },
    },
    expect: {
      eventClass: 'decision',
      outcome: 'edited',
      terminal: true,
      reviewId: 'gw_rev_3',
      decision: 'approved',
    },
  },
  {
    name: 'review.decided — max_iterations_reached lands on expired',
    builtAt: 'services/timeout-worker.ts:419-425',
    body: {
      type: 'review.decided',
      review_id: 'gw_rev_4',
      decision: 'max_iterations_reached',
      was_edited: false,
    },
    expect: {
      eventClass: 'decision',
      outcome: 'expired',
      terminal: true,
      reviewId: 'gw_rev_4',
      decision: 'max_iterations_reached',
    },
  },
  {
    name: 'review.expired',
    builtAt: 'services/webhooks.ts:563-568',
    body: {
      type: 'review.expired',
      review_id: 'gw_rev_5',
      timeout_action: 'expire',
      expired_at: '2026-07-28T11:00:00.000Z',
    },
    expect: {
      eventClass: 'expiry',
      outcome: 'expired',
      terminal: true,
      reviewId: 'gw_rev_5',
      decision: 'expired',
    },
  },
  {
    name: 'review.vetoed (monitoring gate) is a rejection',
    builtAt: 'services/webhooks.ts:764-770',
    body: {
      type: 'review.vetoed',
      review_id: 'gw_rev_6',
      vetoed_at: '2026-07-28T11:00:00.000Z',
      vetoed_by: 'ana@example.com',
      note: 'do not send',
    },
    expect: {
      eventClass: 'decision',
      outcome: 'rejected',
      terminal: true,
      reviewId: 'gw_rev_6',
      decision: 'vetoed',
    },
  },
  {
    name: 'review.confirmed (monitoring window closed) is an approval',
    builtAt: 'services/webhooks.ts:796-802',
    body: {
      type: 'review.confirmed',
      review_id: 'gw_rev_7',
      confirmed_at: '2026-07-28T11:00:00.000Z',
      decided_by: 'system',
      lapsed: true,
    },
    expect: {
      eventClass: 'decision',
      outcome: 'approved',
      terminal: true,
      reviewId: 'gw_rev_7',
      decision: 'confirmed',
    },
  },

  // ---------------- still open: must NOT be treated as decisions ----------------
  {
    name: 'review.sent_back does NOT decide (regression: bug #1)',
    builtAt: 'services/webhooks.ts:706-712',
    body: {
      type: 'review.sent_back',
      review_id: 'gw_rev_8',
      recipient_label: 'Legal',
      reverted_at: '2026-07-28T11:00:00.000Z',
      decline_reason: 'needs counsel review',
    },
    expect: { eventClass: 'iteration', outcome: 'other', terminal: false, reviewId: 'gw_rev_8' },
  },
  {
    name: 'review.questions_raised does NOT decide',
    builtAt: 'services/webhooks.ts:733-739',
    body: {
      type: 'review.questions_raised',
      review_id: 'gw_rev_9',
      recipient_label: 'Legal',
      question_text: 'which entity?',
      reverted_at: '2026-07-28T11:00:00.000Z',
    },
    expect: { eventClass: 'iteration', outcome: 'other', terminal: false, reviewId: 'gw_rev_9' },
  },
  {
    name: 'review.retried does NOT decide',
    builtAt: 'services/webhooks.ts:427-434',
    body: {
      type: 'review.retried',
      review_id: 'gw_rev_10',
      action: 'retry',
      feedback: 'try again, shorter',
    },
    expect: {
      eventClass: 'iteration',
      outcome: 'other',
      terminal: false,
      reviewId: 'gw_rev_10',
      decision: 'retried',
    },
  },
  {
    name: 'review.action_taken uses `event`, not `type`, and does NOT decide',
    builtAt: 'services/reviews/actions.ts:275-298',
    body: {
      event: 'review.action_taken',
      review_id: 'gw_rev_11',
      review_version: 2,
      previous_version: 1,
      action: { id: 'request_changes', label: 'Request changes', kind: 'iteration' },
      actor: { type: 'user', id: 'usr_1', email: 'ana@example.com' },
      feedback: 'tighten the intro',
      edited_payload: null,
      trigger_path: 'ui',
      timestamp: '2026-07-28T11:00:00.000Z',
    },
    expect: { eventClass: 'iteration', outcome: 'other', terminal: false, reviewId: 'gw_rev_11' },
  },
  {
    name: 'operator-authored iteration event (arbitrary name, `event` key)',
    builtAt: 'services/reviews/actions.ts:332-344',
    body: {
      event: 'review.iteration_needs_legal',
      review_id: 'gw_rev_12',
      action_id: 'needs_legal',
      feedback: null,
      actor: 'ana@example.com',
      timestamp: '2026-07-28T11:00:00.000Z',
    },
    expect: { eventClass: 'iteration', outcome: 'other', terminal: false, reviewId: 'gw_rev_12' },
  },
  {
    name: 'assignment.escalated does NOT decide',
    builtAt: 'services/webhooks.ts:820-828',
    body: {
      type: 'assignment.escalated',
      review_id: 'gw_rev_13',
      previous_assignee: 'ana@example.com',
      new_assignee: 'bo@example.com',
      ladder_index: 1,
      escalated_at: '2026-07-28T11:00:00.000Z',
    },
    expect: { eventClass: 'assignment', outcome: 'other', terminal: false, reviewId: 'gw_rev_13' },
  },

  // ---------------- chain lifecycle, incl. the alternate id keys ----------------
  {
    name: 'chain.next_step_ready is keyed by next_review_id',
    builtAt: 'services/webhooks/chain-payloads.ts:78-94',
    body: {
      type: 'chain.next_step_ready',
      chain_run_id: 'gw_crun_1',
      step_number: 2,
      step_id: 'gw_cstep_2',
      previous_step_id: 'gw_cstep_1',
      next_review_id: 'gw_rev_14',
      assignee: { email: 'bo@example.com' },
      created_at: '2026-07-28T11:00:00.000Z',
    },
    expect: { eventClass: 'chain', outcome: 'other', terminal: false, reviewId: 'gw_rev_14' },
  },
  {
    // C1: reclassified to 'decision' — the chain terminated, so this must
    // resume a waiting execution the same as any other rejection.
    name: 'chain.rejected is a decision now (C1) and is keyed by rejecting_review_id',
    builtAt: 'services/webhooks/chain-payloads.ts:110-129',
    body: {
      type: 'chain.rejected',
      chain_run_id: 'gw_crun_2',
      status: 'rejected',
      rejected_at: '2026-07-28T11:00:00.000Z',
      rejection_policy: 'abort',
      rejecting_step_id: 'gw_cstep_3',
      rejecting_step_number: 3,
      rejecting_review_id: 'gw_rev_15',
      rejection_feedback: 'not compliant',
      transcript: [],
    },
    expect: {
      eventClass: 'decision',
      outcome: 'rejected',
      terminal: true,
      reviewId: 'gw_rev_15',
      decision: 'rejected',
    },
  },
  {
    // C1 follow-up: chain.completed is THE authorization signal for a chain
    // now, and buildChainCompletedPayload (chain-payloads.ts:134-155) names
    // final_review_id on the wire for exactly that reason — the one event
    // that says "you may act" could not be correlated to any review the
    // requester had ever seen. This module resolves reviewId from it.
    name: 'chain.completed is a decision now (C1) and names final_review_id',
    builtAt: 'services/webhooks/chain-payloads.ts buildChainCompletedPayload',
    body: {
      type: 'chain.completed',
      chain_run_id: 'gw_crun_3',
      status: 'completed',
      final_review_id: 'gw_rev_19',
      initial_review_id: 'gw_rev_14',
      final_decision: 'approved',
      decided_by: 'bo@example.com',
      decided_at: '2026-08-06T11:00:00.000Z',
      approved_value: { subject: 'Final' },
      edited_payload: null,
      was_edited: false,
      iteration_count: 0,
      completed_at: '2026-07-28T11:00:00.000Z',
      rejection_policy: 'abort',
      metadata: null,
      transcript: [],
    },
    expect: {
      eventClass: 'decision',
      outcome: 'approved',
      terminal: true,
      reviewId: 'gw_rev_19',
      decision: 'approved',
    },
  },
  {
    name: 'chain.step_rejected is non-terminal',
    builtAt: 'services/webhooks/chain-payloads.ts:127-142',
    body: {
      type: 'chain.step_rejected',
      chain_run_id: 'gw_crun_4',
      step_index: 1,
      applied_policy: 'continue',
      next_step_index: 2,
      rejecting_review_id: 'gw_rev_16',
      rejection_feedback: 'minor',
    },
    expect: { eventClass: 'chain', outcome: 'other', terminal: false, reviewId: 'gw_rev_16' },
  },
  {
    name: 'chain.step_halted is non-terminal',
    builtAt: 'services/webhooks/chain-payloads.ts:144-154',
    body: {
      type: 'chain.step_halted',
      chain_run_id: 'gw_crun_5',
      review_id: 'gw_rev_17',
      reason: 'assignee missing',
      code: 'no_assignee',
    },
    expect: { eventClass: 'chain', outcome: 'other', terminal: false, reviewId: 'gw_rev_17' },
  },
  {
    // The `continue` rejection policy reaches completeRun with a REJECTED
    // final step, so chain.completed can fire over a refusal. The API added
    // final_decision as the guard; reading it is what keeps "chain.completed
    // means approved" from being silently wrong the day `continue` ships.
    name: 'chain.completed over a rejected final step reads as rejected',
    builtAt: 'services/webhooks/chain-payloads.ts buildChainCompletedPayload',
    body: {
      type: 'chain.completed',
      chain_run_id: 'gw_crun_9',
      status: 'completed',
      final_review_id: 'gw_rev_last',
      initial_review_id: 'gw_rev_first',
      final_decision: 'rejected',
      completed_at: '2026-08-06T11:00:00.000Z',
      rejection_policy: 'continue',
      metadata: null,
      transcript: [],
    },
    expect: {
      eventClass: 'decision',
      outcome: 'rejected',
      terminal: true,
      reviewId: 'gw_rev_last',
      decision: 'rejected',
    },
  },
  {
    // C1: reclassified to 'decision'. It also now names the review it anchors
    // to (anchor_review_id), which it previously declared internally and then
    // dropped from the wire body — leaving it the only terminal chain event
    // with no correlator and no transcript to recover one from.
    name: 'chain.aborted is a decision now (C1) and names its anchor review',
    builtAt: 'services/webhooks/chain-payloads.ts buildChainAbortedPayload',
    body: {
      type: 'chain.aborted',
      chain_run_id: 'gw_crun_6',
      status: 'aborted',
      anchor_review_id: 'gw_rev_anchor',
      initial_review_id: 'gw_rev_first',
      aborted_by: 'ana@example.com',
      skipped_step_count: 2,
    },
    expect: {
      eventClass: 'decision',
      outcome: 'other',
      terminal: true,
      reviewId: 'gw_rev_anchor',
      decision: 'aborted',
    },
  },
  {
    // C1: one step of a route decided. Must stay non-terminal and out of
    // 'decision' — resuming here would wake the workflow on step 1 of an
    // N-step route, the exact bug this reclassification exists to prevent.
    name: 'chain.step_decided is non-terminal — a STEP decided, not the chain',
    builtAt: 'services/webhooks/chain-payloads.ts:209-225',
    body: {
      type: 'chain.step_decided',
      chain_run_id: 'gw_crun_7',
      step_index: 1,
      review_id: 'gw_rev_18',
      decision: 'approved',
      decided_by: 'ana@example.com',
      decided_at: '2026-08-06T11:00:00.000Z',
      feedback: null,
      edited_payload: null,
      approved_value: null,
      action: null,
    },
    expect: { eventClass: 'chain', outcome: 'other', terminal: false, reviewId: 'gw_rev_18' },
  },
];

describe('classifyGatewerkEvent — the whole emitter surface', () => {
  it.each(CASES)('$name', (c) => {
    const got = classifyGatewerkEvent(c.body);
    expect(got.eventClass).toBe(c.expect.eventClass);
    expect(got.outcome).toBe(c.expect.outcome);
    expect(got.terminal).toBe(c.expect.terminal);
    expect(got.reviewId).toBe(c.expect.reviewId);
    if (c.expect.decision === undefined) {
      expect(got.decision).toBeUndefined();
    } else {
      expect(got.decision).toBe(c.expect.decision);
    }
  });

  it('covers every event type the API can deliver to a callback_url', () => {
    // Guards against someone adding an emitter in apps/api without extending
    // this table. The list mirrors services/webhooks.ts + chain-payloads.ts.
    const EMITTED = [
      'review.decided',
      'review.retried',
      'review.action_taken',
      'review.expired',
      'review.sent_back',
      'review.questions_raised',
      'review.vetoed',
      'review.confirmed',
      'assignment.escalated',
      'chain.next_step_ready',
      'chain.completed',
      'chain.rejected',
      'chain.step_decided',
      'chain.step_rejected',
      'chain.step_halted',
      'chain.aborted',
    ];
    const covered = new Set(CASES.map((c) => (c.body.type ?? c.body.event) as string));
    for (const name of EMITTED) expect(covered.has(name)).toBe(true);
  });
});

describe('classifyGatewerkEvent — the fallback must never invent a decision', () => {
  // This is the exact regression that made a sent-back review resume the
  // workflow with `decision: undefined`.
  it('an unknown event is `unknown`, non-terminal, and carries no decision', () => {
    const got = classifyGatewerkEvent({ type: 'review.something_new', review_id: 'gw_rev_x' });
    expect(got.eventClass).toBe('unknown');
    expect(got.terminal).toBe(false);
    expect(got.decision).toBeUndefined();
    expect(got.outcome).toBe('other');
  });

  it('a body with neither `type` nor `event` is `unknown`, not a decision', () => {
    const got = classifyGatewerkEvent({ review_id: 'gw_rev_y', decision: 'approved' });
    expect(got.eventName).toBe('');
    expect(got.eventClass).toBe('unknown');
    expect(got.terminal).toBe(false);
    // Critically: it must NOT echo the attacker-supplied `decision` through.
    expect(got.decision).toBeUndefined();
  });

  it('an empty body does not throw and does not decide', () => {
    const got = classifyGatewerkEvent({});
    expect(got.eventClass).toBe('unknown');
    expect(got.decision).toBeUndefined();
    expect(got.reviewId).toBeUndefined();
  });
});

describe('outcome vocabulary', () => {
  it('is exhaustive and stable', () => {
    expect(GATEWERK_OUTCOMES).toEqual(['approved', 'rejected', 'edited', 'expired', 'other']);
  });

  it('every classified event lands on one of them', () => {
    for (const c of CASES) {
      const got = classifyGatewerkEvent(c.body);
      expect({ name: c.name, ok: GATEWERK_OUTCOMES.includes(got.outcome) }).toEqual({
        name: c.name,
        ok: true,
      });
    }
  });
});

describe('toOutputJson', () => {
  it('omits `decision` entirely for a non-deciding event', () => {
    const json = toOutputJson(
      classifyGatewerkEvent({ type: 'review.sent_back', review_id: 'gw_rev_1' }),
    );
    // A downstream `$json.decision === 'approved'` test must be unfoolable.
    expect('decision' in json).toBe(false);
    expect(json.event).toBe('review.sent_back');
    expect(json.terminal).toBe(false);
  });

  it('always preserves the raw body', () => {
    const body = { type: 'review.decided', review_id: 'gw_rev_1', decision: 'approved', odd: 1 };
    const json = toOutputJson(classifyGatewerkEvent(body));
    expect(json.rawPayload).toEqual(body);
  });

  // C1: both READMEs document `$json.decision` as the test expression a
  // workflow branches on. A chain's own outcome has to satisfy that same
  // contract, or "wait for a chain, then branch on $json.decision" silently
  // never fires the approved branch.
  it('chain.completed yields decision === "approved", same contract as review.decided', () => {
    const json = toOutputJson(
      classifyGatewerkEvent({ type: 'chain.completed', chain_run_id: 'gw_crun_1' }),
    );
    expect(json.decision).toBe('approved');
    expect(json.eventClass).toBe('decision');
    expect(json.terminal).toBe(true);
  });
});

/**
 * C1: the resume-routing contract for chains specifically. Before this
 * reclassification, `review.decided` suppression for chain-attached reviews
 * meant a chain NEVER produced a 'decision'- or 'expiry'-class event, so a
 * waiting execution hung until its wait timeout no matter what. Reclassifying
 * only the three terminal chain events fixes that without reopening the bug
 * `resumeOn: ['chain']` would reintroduce: resuming the moment step 1 is
 * approved.
 */
describe('shouldResumeOn — chain routing under the shipped default (C1)', () => {
  const DEFAULT_RESUME_ON = ['decision', 'expiry'];

  it('resumes on chain.completed', () => {
    const event = classifyGatewerkEvent({ type: 'chain.completed', chain_run_id: 'gw_crun_1' });
    expect(shouldResumeOn(event.eventClass, DEFAULT_RESUME_ON)).toBe(true);
  });

  it('resumes on chain.rejected', () => {
    const event = classifyGatewerkEvent({
      type: 'chain.rejected',
      chain_run_id: 'gw_crun_2',
      rejecting_review_id: 'gw_rev_1',
    });
    expect(shouldResumeOn(event.eventClass, DEFAULT_RESUME_ON)).toBe(true);
  });

  it('resumes on chain.aborted', () => {
    const event = classifyGatewerkEvent({ type: 'chain.aborted', chain_run_id: 'gw_crun_3' });
    expect(shouldResumeOn(event.eventClass, DEFAULT_RESUME_ON)).toBe(true);
  });

  it.each([
    'chain.next_step_ready',
    'chain.step_decided',
    'chain.step_rejected',
    'chain.step_halted',
  ])('does NOT resume on %s — a step, not the chain, decided', (type) => {
    const event = classifyGatewerkEvent({ type, chain_run_id: 'gw_crun_4' });
    expect(shouldResumeOn(event.eventClass, DEFAULT_RESUME_ON)).toBe(false);
  });
});
