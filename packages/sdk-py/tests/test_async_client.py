"""Tests for the async client."""

from __future__ import annotations

import os
from unittest.mock import patch

import httpx
import pytest

from gatewerk import (
    create_async_client,
    AsyncGatewerkClient,
    ResponseInfo,
    Review,
    ReviewList,
    FeedbackList,
    TemplateList,
    TemplateStats,
    AuditList,
    KeyInfo,
)


def _make_async_client(handler, max_retries=0):
    from gatewerk.async_client import (
        AsyncReviewsResource, AsyncFeedbackResource, AsyncTemplatesResource,
        AsyncWebhooksResource, AsyncAuditResource, AsyncStatsResource,
        AsyncChainsResource, AsyncNotesResource,
    )
    from gatewerk._base import AsyncBaseResource

    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(
        transport=transport,
        base_url="http://test:3100",
        headers={"Authorization": "Bearer gw_key_test", "Content-Type": "application/json"},
    )

    client = AsyncGatewerkClient.__new__(AsyncGatewerkClient)
    client._http = http
    client._owns_http = True
    client._base = AsyncBaseResource(http, max_retries)
    client.reviews = AsyncReviewsResource(http, max_retries)
    client.feedback = AsyncFeedbackResource(http, max_retries)
    client.templates = AsyncTemplatesResource(http, max_retries)
    client.webhooks = AsyncWebhooksResource(http, max_retries)
    client.audit = AsyncAuditResource(http, max_retries)
    client.stats = AsyncStatsResource(http, max_retries)
    client.chains = AsyncChainsResource(http, max_retries)
    client.notes = AsyncNotesResource(http, max_retries)
    return client


# -- Factory -----------------------------------------------------------------


class TestCreateAsyncClient:
    def test_creates_with_explicit_config(self):
        gw = create_async_client(api_key="gw_key_test", url="http://localhost:3100")
        assert gw.reviews is not None

    def test_raises_without_api_key(self):
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ValueError, match="API key is required"):
                create_async_client()

    def test_custom_http_client(self):
        transport = httpx.MockTransport(lambda r: httpx.Response(200, json={}))
        custom = httpx.AsyncClient(transport=transport, base_url="http://custom:9999")
        gw = create_async_client(api_key="ignored", url="ignored", http_client=custom)
        assert gw._owns_http is False


# -- Reviews -----------------------------------------------------------------


class TestAsyncReviews:
    @pytest.mark.asyncio
    async def test_create(self):
        def handler(request: httpx.Request):
            return httpx.Response(201, json={"id": "gw_rev_001", "object": "review", "status": "pending"})

        gw = _make_async_client(handler)
        result = await gw.reviews.create("deploy", {"service": "api"})
        assert isinstance(result, Review)

    @pytest.mark.asyncio
    async def test_get(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "decided"})

        gw = _make_async_client(handler)
        result = await gw.reviews.get("gw_rev_001")
        assert result.status == "decided"

    @pytest.mark.asyncio
    async def test_list(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={
                "items": [{"id": "gw_rev_001", "object": "review"}], "total": 1, "has_more": False,
            })

        gw = _make_async_client(handler)
        result = await gw.reviews.list(status="pending")
        assert isinstance(result, ReviewList)

    @pytest.mark.asyncio
    async def test_decide(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "decision": "approved"})

        gw = _make_async_client(handler)
        result = await gw.reviews.decide("gw_rev_001", "approved")
        assert result.decision == "approved"

    @pytest.mark.asyncio
    async def test_cancel_request(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "pending"})

        gw = _make_async_client(handler)
        result = await gw.reviews.cancel_request("gw_rev_001")
        assert result.status == "pending"

    @pytest.mark.asyncio
    async def test_list_auto_paginate(self):
        call_count = 0

        def handler(request: httpx.Request):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return httpx.Response(200, json={
                    "items": [{"id": "gw_rev_001", "object": "review"}], "total": 2, "has_more": True,
                })
            return httpx.Response(200, json={
                "items": [{"id": "gw_rev_002", "object": "review"}], "total": 2, "has_more": False,
            })

        gw = _make_async_client(handler)
        reviews = []
        async for review in gw.reviews.list_auto_paginate(batch_size=1):
            reviews.append(review)
        assert len(reviews) == 2


# -- Feedback / Templates / Audit / Stats ------------------------------------


class TestAsyncFeedback:
    @pytest.mark.asyncio
    async def test_query(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"items": [{"review_id": "gw_rev_001"}], "total": 1, "has_more": False})

        gw = _make_async_client(handler)
        result = await gw.feedback.query(template="deploy")
        assert isinstance(result, FeedbackList)


class TestAsyncTemplates:
    @pytest.mark.asyncio
    async def test_list(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={
                "items": [{"id": "gw_tpl_001", "name": "Test", "slug": "test"}], "total": 1, "has_more": False,
            })

        gw = _make_async_client(handler)
        result = await gw.templates.list()
        assert isinstance(result, TemplateList)

    @pytest.mark.asyncio
    async def test_create(self):
        def handler(request: httpx.Request):
            return httpx.Response(201, json={"id": "gw_tpl_002", "name": "New", "slug": "new"})

        gw = _make_async_client(handler)
        result = await gw.templates.create("New", "new")
        assert result.id == "gw_tpl_002"

    @pytest.mark.asyncio
    async def test_update(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_tpl_001", "name": "Updated", "slug": "test"})

        gw = _make_async_client(handler)
        result = await gw.templates.update("gw_tpl_001", name="Updated")
        assert result.name == "Updated"

    @pytest.mark.asyncio
    async def test_delete(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"deleted": True})

        gw = _make_async_client(handler)
        result = await gw.templates.delete("gw_tpl_001")
        assert result["deleted"] is True

    @pytest.mark.asyncio
    async def test_stats(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"template_id": "gw_tpl_001", "approval_rate": 0.8})

        gw = _make_async_client(handler)
        result = await gw.templates.stats("gw_tpl_001")
        assert isinstance(result, TemplateStats)


class TestAsyncAudit:
    @pytest.mark.asyncio
    async def test_query(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"items": [{"id": "gw_aud_001", "action": "review.decided"}], "total": 1, "has_more": False})

        gw = _make_async_client(handler)
        result = await gw.audit.query(action="review.decided")
        assert isinstance(result, AuditList)


class TestAsyncStats:
    @pytest.mark.asyncio
    async def test_get(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"total_reviews": 42})

        gw = _make_async_client(handler)
        assert (await gw.stats.get())["total_reviews"] == 42


# -- Key Info / Context Manager / Webhook Verify / Response Metadata ----------


class TestAsyncKeyInfo:
    @pytest.mark.asyncio
    async def test_key_info(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"prefix": "gw_key_abc", "scopes": ["reviews:create"]})

        gw = _make_async_client(handler)
        result = await gw.key_info()
        assert isinstance(result, KeyInfo)


class TestAsyncContextManager:
    @pytest.mark.asyncio
    async def test_async_with(self):
        gw = create_async_client(api_key="gw_key_test", url="http://localhost:3100")
        async with gw:
            assert gw.reviews is not None


class TestAsyncWebhookVerify:
    @pytest.mark.asyncio
    async def test_verify_is_sync(self):
        import hashlib, hmac, json

        body = json.dumps({"event": "review.decided"})
        sig = hmac.new("secret".encode(), body.encode(), hashlib.sha256).hexdigest()

        def handler(request: httpx.Request):
            return httpx.Response(200, json={})

        gw = _make_async_client(handler)
        result = gw.webhooks.verify(body, f"sha256={sig}", "secret")
        assert result["event"] == "review.decided"


class TestAsyncResponseMetadata:
    @pytest.mark.asyncio
    async def test_last_response_populated(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review"},
                                  headers={"x-request-id": "srv-123"})

        gw = _make_async_client(handler)
        await gw.reviews.get("gw_rev_001")

        info = gw.reviews.last_response
        assert isinstance(info, ResponseInfo)
        assert info.server_request_id == "srv-123"
