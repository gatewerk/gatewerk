import type {
  IExecuteFunctions,
  IWebhookFunctions,
  ILoadOptionsFunctions,
  IHookFunctions,
  ICredentialDataDecryptedObject,
  JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

/** Any n8n context that can carry a Gatewerk credential and make requests. */
export type GatewerkRequestContext =
  | IExecuteFunctions
  | IWebhookFunctions
  | ILoadOptionsFunctions
  | IHookFunctions;

/**
 * The Gatewerk API speaks TWO incompatible error shapes, and a client that
 * knows only one of them silently loses the message on the other.
 *
 *  NESTED — everything routed through `middleware/error-handler.ts`, via
 *    `GatewerkError.toJSON()` (packages/shared/src/errors.ts:18-29):
 *      { error: { type, code, message, param?, doc_url, details? } }
 *
 *  FLAT — `middleware/require-scope.ts:9-13,24-28` writes the response itself
 *    and bypasses the error handler entirely:
 *      { error: "Forbidden", message: "Missing required scope(s): reviews:create", status: 403 }
 *
 * The flat shape is what a *correctly scoped-but-insufficient* key gets, i.e.
 * exactly the case a user most needs a legible message for. The previous
 * implementation read only `body.error.message`, so on a 403 it surfaced
 * `undefined` and fell back to n8n's generic "Forbidden".
 *
 * Note also that zod validation failures are **422**, not 400
 * (`middleware/validate.ts:7-33`), and carry a `details[]` array.
 */
export interface ParsedGatewerkError {
  message: string;
  code?: string;
  /** Field the API blamed, when it said. */
  param?: string;
  /** Per-field messages from a 422. */
  details?: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Normalise either error envelope into one shape. Exported for direct testing —
 * asserting only that *some* error was thrown is the kind of hollow test that
 * lets an entire parsing block be deleted without a failure.
 */
export function parseGatewerkErrorBody(rawBody: unknown): ParsedGatewerkError | undefined {
  let body = rawBody;

  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      // Not JSON — a proxy error page, a gateway timeout body, etc. Surface a
      // trimmed excerpt rather than dropping it.
      const text = (rawBody as string).trim();
      return text.length > 0 ? { message: text.slice(0, 300) } : undefined;
    }
  }

  const record = asRecord(body);
  if (!record) return undefined;

  // --- NESTED: { error: { message, code, param, details } } ---
  const nested = asRecord(record.error);
  if (nested) {
    const message = typeof nested.message === 'string' ? nested.message : undefined;
    const details = Array.isArray(nested.details)
      ? nested.details
          .map((d) => {
            const entry = asRecord(d);
            if (!entry) return undefined;
            const path = typeof entry.path === 'string' ? entry.path : undefined;
            const msg = typeof entry.message === 'string' ? entry.message : undefined;
            if (!msg) return undefined;
            return path ? `${path}: ${msg}` : msg;
          })
          .filter((d): d is string => d !== undefined)
      : undefined;

    return {
      message: message ?? 'Gatewerk API error',
      code: typeof nested.code === 'string' ? nested.code : undefined,
      param: typeof nested.param === 'string' ? nested.param : undefined,
      details: details && details.length > 0 ? details : undefined,
    };
  }

  // --- FLAT: { error: "Forbidden", message: "...", status: 403 } ---
  if (typeof record.error === 'string') {
    const message = typeof record.message === 'string' ? record.message : record.error;
    return {
      message,
      // The flat shape has no machine code; the human label is the best proxy.
      code: record.error,
    };
  }

  if (typeof record.message === 'string') return { message: record.message };

  return undefined;
}

/** Pull the response body off whatever n8n wrapped the HTTP failure in. */
function extractBody(error: unknown): unknown {
  const err = asRecord(error);
  if (!err) return undefined;
  if (err.body !== undefined) return err.body;
  const response = asRecord(err.response);
  if (response?.body !== undefined) return response.body;
  if (response?.data !== undefined) return response.data;
  return undefined;
}

function extractStatus(error: unknown): number | undefined {
  const err = asRecord(error);
  if (!err) return undefined;
  for (const key of ['statusCode', 'status', 'httpCode'] as const) {
    const value = err[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  const response = asRecord(err.response);
  for (const key of ['statusCode', 'status'] as const) {
    const value = response?.[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/**
 * Make an authenticated request to the Gatewerk API.
 *
 * Uses n8n's `httpRequestWithAuthentication`, which injects the Authorization
 * header from the `gatewerkApi` credential.
 *
 * Throws `NodeApiError` (not a bespoke error class) so n8n renders the HTTP
 * code, the real API message and the offending field in the node's error panel,
 * and so `continueOnFail()` attaches it to the right item.
 */
export async function gatewerkApiRequest(
  this: GatewerkRequestContext,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  endpoint: string,
  body?: Record<string, unknown>,
  qs?: Record<string, string | number>,
  itemIndex?: number,
): Promise<unknown> {
  const credentials = (await this.getCredentials('gatewerkApi')) as ICredentialDataDecryptedObject;
  const baseUrl = String(credentials.baseUrl ?? '').replace(/\/+$/, '');

  const options: Record<string, unknown> = {
    method,
    url: `${baseUrl}${endpoint}`,
    json: true,
  };

  if (body && Object.keys(body).length > 0) options.body = body;
  if (qs && Object.keys(qs).length > 0) options.qs = qs;

  try {
    return await this.helpers.httpRequestWithAuthentication.call(
      this,
      'gatewerkApi',
      options as never,
    );
  } catch (error) {
    const parsed = parseGatewerkErrorBody(extractBody(error));
    const status = extractStatus(error);

    // Build the description separately from the message: n8n shows the message
    // in the node header and the description in the expandable detail.
    const descriptionParts: string[] = [];
    if (parsed?.param) descriptionParts.push(`Field: ${parsed.param}`);
    if (parsed?.details?.length) descriptionParts.push(parsed.details.join('; '));
    if (parsed?.code) descriptionParts.push(`Gatewerk code: ${parsed.code}`);

    throw new NodeApiError(this.getNode(), error as JsonObject, {
      message: parsed?.message,
      description: descriptionParts.length > 0 ? descriptionParts.join(' · ') : undefined,
      httpCode: status !== undefined ? String(status) : undefined,
      itemIndex,
    });
  }
}
