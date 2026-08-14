import { describe, it, expect, vi } from 'vitest';
import { NodeApiError } from 'n8n-workflow';
import { gatewerkApiRequest, parseGatewerkErrorBody } from '../helpers/api';

const NODE = { id: 'n1', name: 'Gatewerk', type: 'gatewerkRequestReview', typeVersion: 2, position: [0, 0] };

// Mocks the n8n context: these tests cover request building and error parsing,
// not the HTTP transport, which n8n owns.
function createMockContext(responseData: unknown, statusCode = 200) {
  return {
    getNode: vi.fn().mockReturnValue(NODE),
    getCredentials: vi.fn().mockResolvedValue({
      apiKey: 'gwk_test_key_123',
      baseUrl: 'https://api.gatewerk.com',
    }),
    helpers: {
      httpRequestWithAuthentication: vi.fn().mockImplementation(async () => {
        if (statusCode >= 400) {
          const error: any = new Error(`Request failed with status ${statusCode}`);
          error.statusCode = statusCode;
          error.body = JSON.stringify(responseData);
          throw error;
        }
        return responseData;
      }),
    },
  };
}

describe('gatewerkApiRequest — request building', () => {
  it('sends GET request with correct URL', async () => {
    const ctx = createMockContext({ items: [] });
    await gatewerkApiRequest.call(ctx as any, 'GET', '/api/v1/reviews');
    expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledWith(
      'gatewerkApi',
      expect.objectContaining({
        method: 'GET',
        url: 'https://api.gatewerk.com/api/v1/reviews',
        json: true,
      }),
    );
  });

  it('sends POST request with body', async () => {
    const ctx = createMockContext({ id: 'gw_rev_123' });
    const body = { template: 'email-review', payload: { subject: 'Test' } };
    await gatewerkApiRequest.call(ctx as any, 'POST', '/api/v1/reviews', body);
    expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledWith(
      'gatewerkApi',
      expect.objectContaining({ method: 'POST', body, json: true }),
    );
  });

  it('appends query string parameters', async () => {
    const ctx = createMockContext({ items: [] });
    await gatewerkApiRequest.call(ctx as any, 'GET', '/api/v1/feedback', undefined, {
      template: 'email',
      outcome: 'approved',
    });
    expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledWith(
      'gatewerkApi',
      expect.objectContaining({ qs: { template: 'email', outcome: 'approved' } }),
    );
  });

  it('omits an empty body and an empty query string', async () => {
    const ctx = createMockContext({ ok: true });
    await gatewerkApiRequest.call(ctx as any, 'GET', '/api/v1/reviews', {}, {});
    const options = ctx.helpers.httpRequestWithAuthentication.mock.calls[0][1];
    expect('body' in options).toBe(false);
    expect('qs' in options).toBe(false);
  });

  it('strips trailing slash from base URL', async () => {
    const ctx = createMockContext({ items: [] });
    ctx.getCredentials = vi
      .fn()
      .mockResolvedValue({ apiKey: 'gwk_test', baseUrl: 'https://api.gatewerk.com/' });
    await gatewerkApiRequest.call(ctx as any, 'GET', '/api/v1/reviews');
    expect(ctx.helpers.httpRequestWithAuthentication).toHaveBeenCalledWith(
      'gatewerkApi',
      expect.objectContaining({ url: 'https://api.gatewerk.com/api/v1/reviews' }),
    );
  });
});

/**
 * The Gatewerk API speaks two incompatible error envelopes. Asserting only that
 * *an* error was thrown is hollow: the catch block always throws, so the entire
 * parsing block could be deleted and such a test would stay green. These assert
 * the parsed contents.
 */
describe('parseGatewerkErrorBody — both API error shapes', () => {
  it('reads the NESTED envelope from error-handler.ts', () => {
    const parsed = parseGatewerkErrorBody({
      error: {
        type: 'invalid_request',
        code: 'invalid_callback_url',
        message: 'Invalid callback URL: Webhook URL must not point to private or reserved addresses',
        param: 'callback_url',
      },
    });
    expect(parsed?.message).toContain('must not point to private or reserved addresses');
    expect(parsed?.code).toBe('invalid_callback_url');
    expect(parsed?.param).toBe('callback_url');
  });

  // This is the regression: require-scope.ts writes the response itself and
  // bypasses the error handler, so a scope denial has no `error.message` at all.
  it('reads the FLAT envelope from require-scope.ts (403)', () => {
    const parsed = parseGatewerkErrorBody({
      error: 'Forbidden',
      message: 'Missing required scope(s): reviews:create',
      status: 403,
    });
    expect(parsed?.message).toBe('Missing required scope(s): reviews:create');
    expect(parsed?.code).toBe('Forbidden');
  });

  it('reads the FLAT envelope from require-scope.ts (401)', () => {
    const parsed = parseGatewerkErrorBody({
      error: 'Unauthorized',
      message: 'Authentication required',
      status: 401,
    });
    expect(parsed?.message).toBe('Authentication required');
  });

  it('flattens the 422 zod details array', () => {
    const parsed = parseGatewerkErrorBody({
      error: {
        type: 'invalid_request',
        code: 'validation_failed',
        message: 'Invalid body: Required',
        param: 'body.template',
        details: [
          { path: 'body.template', message: 'Required', code: 'invalid_type' },
          { path: 'body.payload', message: 'Required', code: 'invalid_type' },
        ],
      },
    });
    expect(parsed?.details).toEqual(['body.template: Required', 'body.payload: Required']);
  });

  it('parses a JSON string body', () => {
    const parsed = parseGatewerkErrorBody('{"error":{"message":"Not found","code":"not_found"}}');
    expect(parsed?.message).toBe('Not found');
    expect(parsed?.code).toBe('not_found');
  });

  it('surfaces a non-JSON body as text rather than dropping it', () => {
    const parsed = parseGatewerkErrorBody('<html>502 Bad Gateway</html>');
    expect(parsed?.message).toContain('502 Bad Gateway');
  });

  it('returns undefined for an unusable body', () => {
    expect(parseGatewerkErrorBody(undefined)).toBeUndefined();
    expect(parseGatewerkErrorBody('')).toBeUndefined();
    expect(parseGatewerkErrorBody(42)).toBeUndefined();
  });
});

describe('gatewerkApiRequest — error surfacing', () => {
  it('throws NodeApiError carrying the real API message, not a generic one', async () => {
    const ctx = createMockContext(
      { error: { message: 'Template not found', code: 'template_not_found' } },
      404,
    );
    await expect(
      gatewerkApiRequest.call(ctx as any, 'GET', '/api/v1/reviews/nope'),
    ).rejects.toThrow(NodeApiError);

    // Assert the CONTENT, so deleting the parser fails this test.
    const err = await gatewerkApiRequest
      .call(ctx as any, 'GET', '/api/v1/reviews/nope')
      .catch((e: Error) => e);
    expect(err.message).toContain('Template not found');
  });

  it('preserves the scope-denial message from the flat 403 shape', async () => {
    const ctx = createMockContext(
      { error: 'Forbidden', message: 'Missing required scope(s): reviews:create', status: 403 },
      403,
    );
    const err = await gatewerkApiRequest
      .call(ctx as any, 'POST', '/api/v1/reviews', { template: 't', payload: {} })
      .catch((e: Error) => e);
    expect(err.message).toContain('Missing required scope(s): reviews:create');
  });
});
