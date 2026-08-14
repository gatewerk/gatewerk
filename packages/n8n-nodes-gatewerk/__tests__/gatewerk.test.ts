import { describe, it, expect } from 'vitest';
import { Gatewerk } from '../nodes/Gatewerk/Gatewerk.node';
import { buildReviewBody, shouldResumeOn } from '../helpers/review';

const node = new Gatewerk();
const props = node.description.properties;
const prop = (name: string) => props.find((p) => p.name === name);
/** Operation property scoped to one resource (there is one per resource). */
const opFor = (resource: string) =>
  props.find(
    (p) =>
      p.name === 'operation' &&
      (p.displayOptions?.show?.resource as string[] | undefined)?.includes(resource),
  );
const opValues = (resource: string) =>
  (opFor(resource)?.options ?? []).map((o) => (o as { value: string }).value);

describe('buildReviewBody', () => {
  it('sends the required fields', () => {
    const body = buildReviewBody({
      template: 'email-review',
      payload: { subject: 'Hi' },
      callbackUrl: 'https://n8n.example.com/webhook-waiting/1/abc',
    });
    expect(body.template).toBe('email-review');
    expect(body.payload).toEqual({ subject: 'Hi' });
    expect(body.callback_url).toBe('https://n8n.example.com/webhook-waiting/1/abc');
  });

  it('OMITS optional keys rather than sending them undefined', () => {
    // Key absence is the invariant, not "the value is undefined": the API
    // distinguishes an absent field from an explicit null for several of these.
    const body = buildReviewBody({ template: 't', payload: {} });
    for (const key of [
      'callback_url',
      'priority',
      'actions',
      'confidence',
      'irreversibility',
      'assignee',
      'metadata',
      'timeout',
      'oversight',
      'assignment_ladder',
      'idempotency_key',
      'trace_url',
      'max_iterations',
    ]) {
      expect({ key, present: key in body }).toEqual({ key, present: false });
    }
  });

  it('nests timeout as {action, seconds} and defaults seconds to 3600', () => {
    expect(buildReviewBody({ template: 't', payload: {}, timeoutAction: 'expire' }).timeout).toEqual(
      { action: 'expire', seconds: 3600 },
    );
  });

  it('does not send a timeout when no timeout action is chosen', () => {
    expect('timeout' in buildReviewBody({ template: 't', payload: {}, timeoutSeconds: 900 })).toBe(
      false,
    );
  });

  it('sends confidence 0, which is a real value, not an absent one', () => {
    expect(buildReviewBody({ template: 't', payload: {}, confidence: 0 }).confidence).toBe(0);
  });

  it('sends the five previously unreachable create fields under their wire names', () => {
    const ladder = [{ actor: 'a@x.com', trigger_after_seconds: 3600 }];
    const body = buildReviewBody({
      template: 't',
      payload: {},
      oversight: 'monitoring',
      assignmentLadder: ladder,
      idempotencyKey: 'idem-1',
      traceUrl: 'https://trace.example.com/1',
      maxIterations: 3,
    });
    expect(body.oversight).toBe('monitoring');
    expect(body.assignment_ladder).toEqual(ladder);
    expect(body.idempotency_key).toBe('idem-1');
    expect(body.trace_url).toBe('https://trace.example.com/1');
    expect(body.max_iterations).toBe(3);
  });
});

describe('shouldResumeOn', () => {
  it('resumes on decisions and expiries by default', () => {
    expect(shouldResumeOn('decision', ['decision', 'expiry'])).toBe(true);
    expect(shouldResumeOn('expiry', ['decision', 'expiry'])).toBe(true);
  });

  // The false-resume bug: a review sent back must not resume the workflow.
  it('does NOT resume on iteration, assignment or chain events by default', () => {
    for (const cls of ['iteration', 'assignment', 'chain'] as const) {
      expect({ cls, resumes: shouldResumeOn(cls, ['decision', 'expiry']) }).toEqual({
        cls,
        resumes: false,
      });
    }
  });

  it('never resumes on an unknown event, whatever is selected', () => {
    expect(shouldResumeOn('unknown', ['decision', 'expiry', 'iteration', 'chain'])).toBe(false);
    expect(shouldResumeOn('unknown', ['unknown'])).toBe(false);
  });

  it('honours an explicit opt-in to iteration events', () => {
    expect(shouldResumeOn('iteration', ['decision', 'expiry', 'iteration'])).toBe(true);
  });

  it('falls back to the safe default when nothing is selected', () => {
    expect(shouldResumeOn('decision', [])).toBe(true);
    expect(shouldResumeOn('iteration', [])).toBe(false);
  });
});

/**
 * The resume-routing contract. If any of this breaks, every workflow using the
 * waiting operation hangs until its wait timeout with no error surfaced
 * anywhere, which is the worst failure mode this node has.
 */
describe('webhook descriptor', () => {
  const webhook = (node.description.webhooks ?? [])[0];

  it('declares exactly one restart webhook', () => {
    expect(node.description.webhooks).toHaveLength(1);
    expect(webhook.restartWebhook).toBe(true);
  });

  it('uses the node id as its path', () => {
    // n8n matches a waiting webhook with `webhook.path === suffix`
    // (waiting-webhooks.js:205-209), where suffix is the node id that
    // getSignedResumeUrl() puts in the URL. A literal path can never match.
    expect(webhook.path).toBe('={{ $nodeId }}');
    expect(webhook.isFullPath).toBe(true);
  });

  it('listens on POST, which is what Gatewerk sends', () => {
    expect(webhook.httpMethod).toBe('POST');
    expect(webhook.responseMode).toBe('onReceived');
  });
});

describe('node descriptor', () => {
  it('has exactly ONE output, because a waiting resume cannot deliver to any other', () => {
    // On resume n8n assigns workflowData as this node's INPUT while the node is
    // disabled; a disabled node forwards input 0 to output 0 and drops the rest.
    expect(node.description.outputs).toEqual(['main']);
    expect(node.description.outputNames).toBeUndefined();
  });

  it('is usable as an AI Agent tool', () => {
    expect(node.description.usableAsTool).toBe(true);
  });

  /**
   * Do not "simplify" this value away. n8n only builds a real human-in-the-loop
   * tool for a node whose `operation` property offers the literal `sendAndWait`
   * (tool-generation/hitl-tools.js:8-27,138), and only that `…HitlTool` variant
   * gets `rewireOutputLogTo = AiTool`, which returns the human's decision to a
   * calling AI Agent. Rename it and the node silently degrades to an ordinary
   * tool that suspends forever from the agent's point of view, with no error.
   *
   * Verified on n8n 2.6.3: with this value the instance generates
   * `gatewerkHitlTool`; without it, only the plain `…Tool` variant appears.
   */
  it('offers the literal `sendAndWait` operation that n8n keys HITL tooling off', () => {
    expect(opValues('review')).toContain('sendAndWait');
    expect(opFor('review')?.default).toBe('sendAndWait');
  });

  it('covers every resource the integration promises', () => {
    const resources = (prop('resource')?.options ?? []).map(
      (o) => (o as { value: string }).value,
    );
    expect(resources.sort()).toEqual(
      ['audit', 'chain', 'feedback', 'note', 'review', 'stat', 'template'].sort(),
    );
  });

  it('exposes read operations, which the old node set could not do at all', () => {
    // Previously there was no way to read a review from n8n: no get, no list.
    expect(opValues('review')).toEqual(
      expect.arrayContaining(['get', 'getAll', 'create', 'act', 'sendAndWait']),
    );
    expect(opValues('chain')).toEqual(expect.arrayContaining(['get', 'getForReview', 'start']));
    expect(opValues('note')).toContain('create');
    expect(opValues('template')).toContain('getAll');
    expect(opValues('audit')).toContain('getAll');
    expect(opValues('stat')).toContain('get');
    expect(opValues('feedback')).toContain('getAll');
  });

  it('closes the iteration loop: a revision can be submitted, not just received', () => {
    // Without `update` the node could receive review.retried and never answer
    // it, leaving the review parked in awaiting_iteration until it timed out.
    expect(opValues('review')).toContain('update');
  });

  it('can abort a chain run and mint an external review link', () => {
    expect(opValues('chain')).toContain('abort');
    expect(opValues('review')).toContain('createToken');
    expect(opValues('review')).toContain('getVersions');
  });

  /**
   * `GET /api/v1/notes` requires `project_id` in the query
   * (schemas/notes.ts:102) and nothing injects it for an api_key subject
   * (routes/notes/read.ts:20), while `GET /auth/key-info` does not expose the
   * project id. The operation could only ever 422, so it is deliberately absent.
   * Re-add it when the API resolves project_id server-side.
   */
  it('does NOT offer note Get Many, which cannot work with an API key', () => {
    expect(opValues('note')).not.toContain('getAll');
  });

  it('every resource declares its own operation property', () => {
    for (const r of ['review', 'note', 'chain', 'feedback', 'template', 'audit', 'stat']) {
      expect({ resource: r, hasOps: opValues(r).length > 0 }).toEqual({
        resource: r,
        hasOps: true,
      });
    }
  });

  it('loads templates and actions from the API rather than hardcoding them', () => {
    expect(prop('template')?.typeOptions?.loadOptionsMethod).toBe('getTemplates');
    expect(prop('actions')?.typeOptions?.loadOptionsMethod).toBe('getTemplateActions');
    expect(prop('actions')?.typeOptions?.loadOptionsDependsOn).toEqual(['template']);
  });

  it('registers every loadOptions method it advertises', () => {
    // A parameter naming an unregistered method fails silently in the n8n UI
    // with an empty dropdown.
    const advertised = props
      .map((p) => p.typeOptions?.loadOptionsMethod)
      .filter((m): m is string => typeof m === 'string');
    expect(advertised.length).toBeGreaterThan(0);
    for (const method of advertised) {
      expect({
        method,
        registered: typeof (node.methods.loadOptions as Record<string, unknown>)[method],
      }).toEqual({ method, registered: 'function' });
    }
  });
});
