import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { verifyGatewerkSignature } from '../helpers/verifySignature';

const SECRET = 'whsec_test_secret_12345';
const BODY = JSON.stringify({ type: 'review.decided', review_id: 'rev_1', decision: 'approved' });

function v1HeaderFor(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function v2HeaderFor(body: string, secret: string, ts: number): string {
  const hex = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${hex}`;
}

describe('verifyGatewerkSignature', () => {
  it('accepts a valid v1 signature', () => {
    const result = verifyGatewerkSignature({
      rawBody: BODY,
      v1Header: v1HeaderFor(BODY, SECRET),
      secret: SECRET,
    });
    expect(result).toEqual({ ok: true, variant: 'v1' });
  });

  it('accepts a valid v2 signature with fresh timestamp', () => {
    const ts = Math.floor(Date.now() / 1000);
    const result = verifyGatewerkSignature({
      rawBody: BODY,
      v2Header: v2HeaderFor(BODY, SECRET, ts),
      secret: SECRET,
    });
    expect(result).toEqual({ ok: true, variant: 'v2' });
  });

  it('rejects v2 signature when timestamp is older than tolerance', () => {
    const nowMs = 1_700_000_000_000;
    const ts = Math.floor(nowMs / 1000) - 600; // 10 minutes old, tolerance 300s
    const result = verifyGatewerkSignature({
      rawBody: BODY,
      v2Header: v2HeaderFor(BODY, SECRET, ts),
      secret: SECRET,
      nowMs,
    });
    expect(result).toEqual({ ok: false, reason: 'timestamp_outside_tolerance' });
  });

  it('rejects v1 signature with wrong secret', () => {
    const result = verifyGatewerkSignature({
      rawBody: BODY,
      v1Header: v1HeaderFor(BODY, 'wrong_secret'),
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'v1_hmac_mismatch' });
  });

  it('rejects v2 signature with wrong secret', () => {
    const ts = Math.floor(Date.now() / 1000);
    const result = verifyGatewerkSignature({
      rawBody: BODY,
      v2Header: v2HeaderFor(BODY, 'wrong_secret', ts),
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'v2_hmac_mismatch' });
  });

  it('rejects when both signature headers are missing', () => {
    const result = verifyGatewerkSignature({
      rawBody: BODY,
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'missing_signature_header' });
  });

  it('rejects malformed v1 (no sha256= prefix)', () => {
    const result = verifyGatewerkSignature({
      rawBody: BODY,
      v1Header: 'beefcafe',
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed_v1_signature' });
  });

  it('rejects malformed v2 (missing fields)', () => {
    const result = verifyGatewerkSignature({
      rawBody: BODY,
      v2Header: 't=123',
      secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'malformed_v2_signature' });
  });

  it('prefers v2 when both headers are present and v2 is valid', () => {
    const ts = Math.floor(Date.now() / 1000);
    const result = verifyGatewerkSignature({
      rawBody: BODY,
      v1Header: 'sha256=deadbeef', // bogus
      v2Header: v2HeaderFor(BODY, SECRET, ts),
      secret: SECRET,
    });
    expect(result).toEqual({ ok: true, variant: 'v2' });
  });

  it('rejects v2 first even if v1 would succeed when both are present and v2 fails', () => {
    // Once v2 is present, we trust v2 — receivers shouldn't downgrade to a
    // weaker variant when a stronger one was supplied (signature stripping
    // attack defense).
    const ts = Math.floor(Date.now() / 1000);
    const result = verifyGatewerkSignature({
      rawBody: BODY,
      v1Header: v1HeaderFor(BODY, SECRET), // valid v1
      v2Header: v2HeaderFor(BODY, 'wrong_secret', ts), // invalid v2
      secret: SECRET,
    });
    expect(result.ok).toBe(false);
  });

  it('handles Buffer rawBody equivalently to string', () => {
    const buf = Buffer.from(BODY, 'utf8');
    const result = verifyGatewerkSignature({
      rawBody: buf,
      v1Header: v1HeaderFor(BODY, SECRET),
      secret: SECRET,
    });
    expect(result).toEqual({ ok: true, variant: 'v1' });
  });
});
