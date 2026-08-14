import { describe, it, expect, vi } from 'vitest';
import { runOperation } from '../nodes/Gatewerk/Gatewerk.node';

/**
 * Covers the consolidated node's dispatch: which endpoint each
 * resource/operation hits, what body it builds and what query string it sends.
 *
 * This replaces the per-node body-builder suites that were deleted along with
 * the five nodes the `Gatewerk` node supersedes. Without it the routing table
 * would be entirely untested, and a wrong path or a wrong wire field name would
 * only surface against a live API.
 */

const NODE = { id: 'n1', name: 'Gatewerk', type: 'gatewerk', typeVersion: 1, position: [0, 0] };

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  qs?: Record<string, unknown>;
}

/** Mock IExecuteFunctions that records the HTTP call the node would make. */
function mockCtx(params: Record<string, unknown>, response: unknown = { ok: true }) {
  const calls: Call[] = [];
  const ctx = {
    calls,
    getNode: vi.fn().mockReturnValue(NODE),
    getCredentials: vi.fn().mockResolvedValue({
      apiKey: 'gwk_test',
      baseUrl: 'https://api.gatewerk.com',
    }),
    continueOnFail: () => false,
    addExecutionHints: vi.fn(),
    getSignedResumeUrl: vi.fn().mockReturnValue('https://n8n.example.com/webhook-waiting/1/n1'),
    getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
      name in params ? params[name] : fallback,
    helpers: {
      httpRequestWithAuthentication: vi.fn().mockImplementation(async (_cred: string, o: any) => {
        calls.push({ method: o.method, url: o.url, body: o.body, qs: o.qs });
        return response;
      }),
    },
  };
  return ctx;
}

const run = (ctx: any, resource: string, operation: string) =>
  runOperation(ctx as never, resource, operation, 0);

describe('review operations', () => {
  it('get hits the single-review endpoint and URL-encodes the ID', async () => {
    // An unencoded id containing ../ or ? would rewrite the request path.
    const ctx = mockCtx({ reviewId: 'gw_rev_a/../../admin' });
    await run(ctx, 'review', 'get');
    expect(ctx.calls[0].method).toBe('GET');
    expect(ctx.calls[0].url).toBe(
      'https://api.gatewerk.com/api/v1/reviews/gw_rev_a%2F..%2F..%2Fadmin',
    );
  });

  it('getAll sends filters and paging as a query string', async () => {
    const ctx = mockCtx(
      { reviewFilters: { status: 'pending', assignee: 'a@x.com' }, limit: 25, offset: 10 },
      { object: 'list', items: [{ id: 'r1' }, { id: 'r2' }] },
    );
    const out = await run(ctx, 'review', 'getAll');
    expect(ctx.calls[0].url).toBe('https://api.gatewerk.com/api/v1/reviews');
    expect(ctx.calls[0].qs).toEqual({
      status: 'pending',
      assignee: 'a@x.com',
      limit: 25,
      offset: 10,
    });
    // The list envelope is unwrapped into one n8n item per review.
    expect(out).toHaveLength(2);
  });

  it('getAll drops empty filters instead of sending blank query params', async () => {
    const ctx = mockCtx(
      { reviewFilters: { status: '', assignee: undefined }, limit: 50, offset: 0 },
      { object: 'list', items: [] },
    );
    await run(ctx, 'review', 'getAll');
    expect('status' in (ctx.calls[0].qs ?? {})).toBe(false);
    expect('assignee' in (ctx.calls[0].qs ?? {})).toBe(false);
  });

  it('act posts the action under its wire field names', async () => {
    const ctx = mockCtx({
      reviewId: 'gw_rev_1',
      actionId: 'approve',
      actionOptions: { feedback: 'looks good' },
    });
    await run(ctx, 'review', 'act');
    expect(ctx.calls[0].method).toBe('POST');
    expect(ctx.calls[0].url).toBe('https://api.gatewerk.com/api/v1/reviews/gw_rev_1/action');
    expect(ctx.calls[0].body).toEqual({ action_id: 'approve', feedback: 'looks good' });
  });

  it('act rejects a non-positive version instead of silently dropping it', async () => {
    // The previous node filtered `version > 0` before validating, so 0 and
    // negatives were discarded and the guard was unreachable.
    for (const version of [0, -1, 1.5]) {
      const ctx = mockCtx({
        reviewId: 'gw_rev_1',
        actionId: 'approve',
        actionOptions: { version },
      });
      await expect(run(ctx, 'review', 'act')).rejects.toThrow(/positive integer/);
    }
  });

  it('act passes a valid version through', async () => {
    const ctx = mockCtx({
      reviewId: 'gw_rev_1',
      actionId: 'approve',
      actionOptions: { version: 3 },
    });
    await run(ctx, 'review', 'act');
    expect(ctx.calls[0].body?.version).toBe(3);
  });

  it('create posts a review WITHOUT a callback url', async () => {
    const ctx = mockCtx({
      template: 'proposal-review',
      payload: '{"a":1}',
      priority: 'high',
      actions: [],
      timeoutAction: '',
      additionalOptions: {},
    });
    await run(ctx, 'review', 'create');
    expect(ctx.calls[0].url).toBe('https://api.gatewerk.com/api/v1/reviews');
    expect('callback_url' in (ctx.calls[0].body ?? {})).toBe(false);
    expect(ctx.calls[0].body?.template).toBe('proposal-review');
    expect(ctx.calls[0].body?.payload).toEqual({ a: 1 });
  });
});

describe('note operations', () => {
  /**
   * The attachment MUST go in `attachments[]`. CreateNoteBodySchema
   * (packages/shared/src/api/schemas/notes.ts:65) has no flat
   * target_kind/target_id, and zod objects here are non-strict, so flat fields
   * are silently stripped: the note is created and the attachment vanishes with
   * no error at either end.
   */
  it('create nests the attachment in attachments[], not as flat fields', async () => {
    const ctx = mockCtx({
      noteBody: 'hello',
      noteOptions: {
        targetKind: 'review',
        targetId: 'gw_rev_1',
        tags: 'urgent, legal',
        isShared: true,
      },
    });
    await run(ctx, 'note', 'create');
    expect(ctx.calls[0].body).toEqual({
      body: 'hello',
      attachments: [{ target_kind: 'review', target_id: 'gw_rev_1' }],
      tags: ['urgent', 'legal'],
      is_shared: true,
    });
    // Explicit: the flat spelling must never appear.
    expect('target_kind' in (ctx.calls[0].body ?? {})).toBe(false);
    expect('target_id' in (ctx.calls[0].body ?? {})).toBe(false);
  });

  it('create refuses a target kind without a target id', async () => {
    const ctx = mockCtx({ noteBody: 'x', noteOptions: { targetKind: 'review' } });
    await expect(run(ctx, 'note', 'create')).rejects.toThrow(/Target ID is required/);
  });

  it('create omits attachments entirely when kind is none', async () => {
    const ctx = mockCtx({ noteBody: 'x', noteOptions: { targetKind: 'none' } });
    await run(ctx, 'note', 'create');
    expect('attachments' in (ctx.calls[0].body ?? {})).toBe(false);
  });

  /**
   * TagSchema is /^[a-z0-9][a-z0-9_-]{0,31}$/ (schemas/notes.ts:13) and zod
   * validation runs BEFORE the handler's own toLowerCase
   * (routes/notes/write.ts:59), so an uppercase tag 422s instead of being
   * normalised. The node must lower-case before sending.
   */
  it('create lower-cases tags, which the API validates before normalising', async () => {
    const ctx = mockCtx({ noteBody: 'x', noteOptions: { tags: 'Follow-Up, LEGAL , ' } });
    await run(ctx, 'note', 'create');
    expect(ctx.calls[0].body?.tags).toEqual(['follow-up', 'legal']);
  });

  /**
   * The API defaults is_shared to false, and an api_key subject creating a
   * private note is rejected 422 api_key_cannot_create_private
   * (routes/notes/write.ts:43-51). An API key is the only credential this
   * package ships, so omitting the field would break note creation by default.
   */
  it('create always sends is_shared, defaulting to true for API-key callers', async () => {
    const ctx = mockCtx({ noteBody: 'x', noteOptions: {} });
    await run(ctx, 'note', 'create');
    expect(ctx.calls[0].body?.is_shared).toBe(true);
  });
});

describe('chain operations', () => {
  it('start posts definition and initial_payload parsed from JSON', async () => {
    const ctx = mockCtx({
      definition: '{"version":"1.0","mode":"sequential","steps":[]}',
      initialPayload: '{"x":1}',
    });
    await run(ctx, 'chain', 'start');
    expect(ctx.calls[0].url).toBe('https://api.gatewerk.com/api/v1/chain-runs');
    expect(ctx.calls[0].body?.initial_payload).toEqual({ x: 1 });
    expect((ctx.calls[0].body?.definition as any).mode).toBe('sequential');
  });

  it('start surfaces malformed JSON as a node error', async () => {
    const ctx = mockCtx({ definition: '{not json', initialPayload: '{}' });
    await expect(run(ctx, 'chain', 'start')).rejects.toThrow(/must be valid JSON/);
  });

  /**
   * A chain run with no callback_url emits no webhooks at all, so its progress
   * is invisible to n8n. Dropping this field would make chains silently
   * unobservable rather than visibly broken.
   */
  it('start forwards callback_url and metadata when supplied', async () => {
    const ctx = mockCtx({
      definition: '{"version":"1.0","mode":"sequential","steps":[]}',
      initialPayload: '{}',
      chainOptions: {
        callbackUrl: 'https://n8n.example.com/webhook/abc/webhook',
        metadata: '{"run":"nightly"}',
      },
    });
    await run(ctx, 'chain', 'start');
    expect(ctx.calls[0].body?.callback_url).toBe('https://n8n.example.com/webhook/abc/webhook');
    expect(ctx.calls[0].body?.metadata).toEqual({ run: 'nightly' });
  });

  it('start omits callback_url and empty metadata rather than sending blanks', async () => {
    const ctx = mockCtx({
      definition: '{"version":"1.0","mode":"sequential","steps":[]}',
      initialPayload: '{}',
      chainOptions: { metadata: '{}' },
    });
    await run(ctx, 'chain', 'start');
    expect('callback_url' in (ctx.calls[0].body ?? {})).toBe(false);
    expect('metadata' in (ctx.calls[0].body ?? {})).toBe(false);
  });

  it('get and getForReview hit their own endpoints', async () => {
    const a = mockCtx({ chainRunId: 'gw_chain_1' });
    await run(a, 'chain', 'get');
    expect(a.calls[0].url).toBe('https://api.gatewerk.com/api/v1/chain-runs/gw_chain_1');

    const b = mockCtx({ chainReviewId: 'gw_rev_1' });
    await run(b, 'chain', 'getForReview');
    expect(b.calls[0].url).toBe('https://api.gatewerk.com/api/v1/reviews/gw_rev_1/chain');
  });
});

describe('read-only resources', () => {
  it.each([
    ['feedback', 'getAll', 'https://api.gatewerk.com/api/v1/feedback'],
    ['template', 'getAll', 'https://api.gatewerk.com/api/v1/templates'],
    ['audit', 'getAll', 'https://api.gatewerk.com/api/v1/audit'],
    ['stat', 'get', 'https://api.gatewerk.com/api/v1/stats'],
  ])('%s %s hits %s', async (resource, operation, url) => {
    const ctx = mockCtx(
      { limit: 50, offset: 0, feedbackFilters: {}, auditFilters: {} },
      { object: 'list', items: [{ id: 1 }] },
    );
    await run(ctx, resource, operation);
    expect(ctx.calls[0].method).toBe('GET');
    expect(ctx.calls[0].url).toBe(url);
  });

  it('a bare object response becomes exactly one item', async () => {
    const ctx = mockCtx({}, { object: 'stats', total: 7 });
    const out = await run(ctx, 'stat', 'get');
    expect(out).toEqual([{ object: 'stats', total: 7 }]);
  });
});

describe('audit filtering', () => {
  /**
   * GET /api/v1/audit reads only action, resource_type, resource_id, actor,
   * from, to, limit, offset (routes/audit.ts:21-31). Sending `review_id` would
   * be silently ignored and the caller would receive the WHOLE project log
   * while believing it was scoped to one review. Review rows are keyed
   * resource_type:"review" + resource_id (routes/reviews/action.ts:56).
   */
  it('translates a Review ID filter into resource_type + resource_id', async () => {
    const ctx = mockCtx(
      { auditFilters: { reviewId: 'gw_rev_1' }, limit: 50, offset: 0 },
      { object: 'list', items: [] },
    );
    await run(ctx, 'audit', 'getAll');
    expect(ctx.calls[0].qs).toMatchObject({ resource_type: 'review', resource_id: 'gw_rev_1' });
    // The ignored spelling must never be sent.
    expect('review_id' in (ctx.calls[0].qs ?? {})).toBe(false);
    expect('reviewId' in (ctx.calls[0].qs ?? {})).toBe(false);
  });

  it('sends no resource scoping when no review filter is set', async () => {
    const ctx = mockCtx(
      { auditFilters: { action: 'review.decided' }, limit: 50, offset: 0 },
      { object: 'list', items: [] },
    );
    await run(ctx, 'audit', 'getAll');
    expect(ctx.calls[0].qs).toMatchObject({ action: 'review.decided' });
    expect('resource_type' in (ctx.calls[0].qs ?? {})).toBe(false);
  });
});

describe('review revision and links', () => {
  it('update PUTs the revised payload with its version', async () => {
    const ctx = mockCtx({
      reviewId: 'gw_rev_1',
      revisedPayload: '{"proposal":"tighter"}',
      revisionVersion: 2,
    });
    await run(ctx, 'review', 'update');
    expect(ctx.calls[0].method).toBe('PUT');
    expect(ctx.calls[0].url).toBe('https://api.gatewerk.com/api/v1/reviews/gw_rev_1');
    expect(ctx.calls[0].body).toEqual({ payload: { proposal: 'tighter' }, version: 2 });
  });

  it('createToken posts the expiry to the token endpoint', async () => {
    const ctx = mockCtx({ reviewId: 'gw_rev_1', expiryHours: 24 });
    await run(ctx, 'review', 'createToken');
    expect(ctx.calls[0].url).toBe('https://api.gatewerk.com/api/v1/reviews/gw_rev_1/token');
    expect(ctx.calls[0].body).toEqual({ expiryHours: 24 });
  });

  it('chain abort posts to the abort endpoint', async () => {
    const ctx = mockCtx({ chainRunId: 'gw_chain_1' });
    await run(ctx, 'chain', 'abort');
    expect(ctx.calls[0].method).toBe('POST');
    expect(ctx.calls[0].url).toBe('https://api.gatewerk.com/api/v1/chain-runs/gw_chain_1/abort');
  });
});

describe('list envelope', () => {
  // Discarding total/has_more would make limit/offset paging unusable, and
  // attaching them to only the last row would make items non-homogeneous.
  it('copies total and has_more onto every row', async () => {
    const ctx = mockCtx(
      { reviewFilters: {}, limit: 2, offset: 0 },
      { object: 'list', items: [{ id: 'a' }, { id: 'b' }], total: 7, has_more: true },
    );
    const out = await run(ctx, 'review', 'getAll');
    expect(out).toEqual([
      { id: 'a', _total: 7, _hasMore: true },
      { id: 'b', _total: 7, _hasMore: true },
    ]);
  });
});

describe('unknown routing', () => {
  it('throws rather than silently doing nothing', async () => {
    const ctx = mockCtx({});
    await expect(run(ctx, 'review', 'teleport')).rejects.toThrow(/Unsupported operation/);
    await expect(run(ctx, 'unicorn', 'get')).rejects.toThrow(/Unsupported operation/);
  });
});
