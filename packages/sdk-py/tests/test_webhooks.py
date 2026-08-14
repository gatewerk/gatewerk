"""Tests for webhook signature verification."""

from __future__ import annotations

import hashlib
import hmac
import json

import httpx
import pytest

from gatewerk.resources.webhooks import WebhooksResource


@pytest.fixture
def wh():
    transport = httpx.MockTransport(lambda r: httpx.Response(200))
    http = httpx.Client(transport=transport, base_url="http://test:3100")
    return WebhooksResource(http, max_retries=0)


SECRET = "whsec_test_secret_123"


def _sign(body: str, secret: str = SECRET) -> str:
    sig = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"sha256={sig}"


class TestWebhookVerify:
    def test_valid_signature(self, wh):
        body = json.dumps({"event": "review.decided", "review_id": "gw_rev_001"})
        sig = _sign(body)

        result = wh.verify(body, sig, SECRET)

        assert result["event"] == "review.decided"
        assert result["review_id"] == "gw_rev_001"

    def test_invalid_signature_raises(self, wh):
        body = json.dumps({"event": "review.decided"})
        sig = _sign(body, secret="wrong_secret")

        with pytest.raises(ValueError, match="verification failed"):
            wh.verify(body, sig, SECRET)

    def test_malformed_header_raises(self, wh):
        body = json.dumps({"event": "review.decided"})

        with pytest.raises(ValueError, match="Invalid signature"):
            wh.verify(body, "garbage", SECRET)

    def test_old_style_header_rejected(self, wh):
        """t=...,v1=... timestamped format was dropped; it must not parse."""
        body = json.dumps({"event": "review.decided"})
        legacy = "t=1700000000,v1=" + "0" * 64

        with pytest.raises(ValueError, match="Invalid signature"):
            wh.verify(body, legacy, SECRET)

    def test_signature_is_over_raw_body_only(self, wh):
        """HMAC input is raw body — no timestamp prefix in v2."""
        body = json.dumps({"event": "review.decided", "review_id": "gw_rev_999"})
        # Compute expected sig identically to the service
        expected = hmac.new(SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
        sig = f"sha256={expected}"

        result = wh.verify(body, sig, SECRET)
        assert result["review_id"] == "gw_rev_999"
