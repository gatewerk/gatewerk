"""Webhooks resource for the Gatewerk Python SDK."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
from typing import Any, Optional

from .._base import BaseResource
from ..types import WebhookDeliveryList


_SIG_RE = re.compile(r"^sha256=([0-9a-f]{64})$")


def verify_signature(
    raw_body: str,
    signature_header: str,
    secret: str,
) -> dict[str, Any]:
    """Verify a webhook signature from the X-Webhook-Signature header.

    Header format: ``sha256=<hex>`` where ``hex`` is
    ``HMAC-SHA256(secret, raw_body)``. No timestamp — replay protection is
    not needed until webhooks accept third-party publishers. Use the
    ``X-Webhook-Id`` header as an idempotency key if dedupe is needed.

    Args:
        raw_body: The raw request body as a string.
        signature_header: The X-Webhook-Signature header value.
        secret: The HMAC secret for this project.

    Returns:
        The parsed payload dict if valid.

    Raises:
        ValueError: If the signature is invalid.
    """
    match = _SIG_RE.match(signature_header or "")
    if not match:
        raise ValueError("Invalid signature header format")
    provided = match.group(1)

    expected = hmac.new(
        secret.encode(),
        raw_body.encode(),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(provided, expected):
        raise ValueError("Webhook signature verification failed")

    return json.loads(raw_body)


class WebhooksResource(BaseResource):
    """Webhook signature verification and delivery log queries."""

    def verify(
        self,
        raw_body: str,
        signature_header: str,
        secret: str,
    ) -> dict[str, Any]:
        """Verify a webhook signature. Delegates to verify_signature()."""
        return verify_signature(raw_body, signature_header, secret)

    def deliveries(
        self,
        *,
        review_id: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> WebhookDeliveryList:
        """List webhook delivery attempts."""
        params: dict[str, Any] = {}
        if review_id is not None:
            params["review_id"] = review_id
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset

        data = self._request("GET", "/api/v1/webhooks/deliveries", params=params, timeout=timeout)
        return WebhookDeliveryList.model_validate(data)
