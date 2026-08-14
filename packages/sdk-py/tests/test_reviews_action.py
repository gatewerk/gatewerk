"""Tests for reviews.action() and deprecation warnings on legacy methods."""

from __future__ import annotations

import json
import warnings

import httpx
import pytest

from gatewerk import Review


def _make_client(handler, max_retries=0):
    from gatewerk.client import GatewerkClient
    from gatewerk._base import BaseResource
    from gatewerk.resources.reviews import ReviewsResource
    from gatewerk.resources.feedback import FeedbackResource
    from gatewerk.resources.templates import TemplatesResource
    from gatewerk.resources.webhooks import WebhooksResource
    from gatewerk.resources.audit import AuditResource
    from gatewerk.resources.stats import StatsResource
    from gatewerk.resources.chains import ChainsResource
    from gatewerk.resources.notes import NotesResource

    transport = httpx.MockTransport(handler)
    http = httpx.Client(
        transport=transport,
        base_url="http://test:3100",
        headers={"Authorization": "Bearer gw_key_test", "Content-Type": "application/json"},
    )

    client = GatewerkClient.__new__(GatewerkClient)
    client._http = http
    client._owns_http = True
    client._base = BaseResource(http, max_retries)
    client.reviews = ReviewsResource(http, max_retries)
    client.feedback = FeedbackResource(http, max_retries)
    client.templates = TemplatesResource(http, max_retries)
    client.webhooks = WebhooksResource(http, max_retries)
    client.audit = AuditResource(http, max_retries)
    client.stats = StatsResource(http, max_retries)
    client.chains = ChainsResource(http, max_retries)
    client.notes = NotesResource(http, max_retries)
    return client


class TestReviewsAction:
    # T1: POSTs correct URL + body via httpx mock
    def test_action_posts_correct_url_and_body(self):
        captured = {}

        def handler(request: httpx.Request):
            captured["url"] = str(request.url)
            captured["method"] = request.method
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "decided"})

        gw = _make_client(handler)
        result = gw.reviews.action("gw_rev_001", "approve")

        assert captured["url"].endswith("/api/v1/reviews/gw_rev_001/action")
        assert captured["method"] == "POST"
        assert captured["body"] == {"action_id": "approve"}
        assert isinstance(result, Review)

    # T2: passes optional fields when set
    def test_action_passes_optional_fields(self):
        captured = {}

        def handler(request: httpx.Request):
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "decided"})

        gw = _make_client(handler)
        gw.reviews.action(
            "gw_rev_001",
            "approve",
            feedback="Looks good",
            edited_payload={"subject": "Updated"},
            version=3,
        )

        assert captured["body"]["action_id"] == "approve"
        assert captured["body"]["feedback"] == "Looks good"
        assert captured["body"]["edited_payload"] == {"subject": "Updated"}
        assert captured["body"]["version"] == 3

    # T3: omits optional fields when None
    def test_action_omits_none_fields(self):
        captured = {}

        def handler(request: httpx.Request):
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "decided"})

        gw = _make_client(handler)
        gw.reviews.action("gw_rev_001", "reject")

        assert "feedback" not in captured["body"]
        assert "edited_payload" not in captured["body"]
        assert "version" not in captured["body"]

    # T4: returns Review model
    def test_action_returns_review_model(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "decided"})

        gw = _make_client(handler)
        result = gw.reviews.action("gw_rev_001", "approve")
        assert isinstance(result, Review)
        assert result.id == "gw_rev_001"

    # T5: reviews.decide() emits DeprecationWarning
    def test_decide_emits_deprecation_warning(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "decided"})

        gw = _make_client(handler)
        with pytest.warns(DeprecationWarning, match="reviews.decide"):
            gw.reviews.decide("gw_rev_001", "approved")

    # T6: reviews.retry() emits DeprecationWarning
    def test_retry_emits_deprecation_warning(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "pending"})

        gw = _make_client(handler)
        with pytest.warns(DeprecationWarning, match="reviews.retry"):
            gw.reviews.retry("gw_rev_001")

    # T7: reviews.cancel_request() emits DeprecationWarning
    def test_cancel_request_emits_deprecation_warning(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "pending"})

        gw = _make_client(handler)
        with pytest.warns(DeprecationWarning, match="reviews.cancel_request"):
            gw.reviews.cancel_request("gw_rev_001")

    # T5a: async reviews.decide() emits DeprecationWarning
    @pytest.mark.asyncio
    async def test_async_decide_emits_deprecation_warning(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "decided"})

        from gatewerk.async_client import AsyncReviewsResource
        transport = httpx.MockTransport(handler)
        http = httpx.AsyncClient(
            transport=transport,
            base_url="http://test:3100",
            headers={"Authorization": "Bearer gw_key_test", "Content-Type": "application/json"},
        )
        resource = AsyncReviewsResource(http, 0)
        with pytest.warns(DeprecationWarning, match="reviews.decide"):
            await resource.decide("gw_rev_001", "approved")
        await http.aclose()

    # T6a: async reviews.retry() emits DeprecationWarning
    @pytest.mark.asyncio
    async def test_async_retry_emits_deprecation_warning(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "pending"})

        from gatewerk.async_client import AsyncReviewsResource
        transport = httpx.MockTransport(handler)
        http = httpx.AsyncClient(
            transport=transport,
            base_url="http://test:3100",
            headers={"Authorization": "Bearer gw_key_test", "Content-Type": "application/json"},
        )
        resource = AsyncReviewsResource(http, 0)
        with pytest.warns(DeprecationWarning, match="reviews.retry"):
            await resource.retry("gw_rev_001")
        await http.aclose()

    # T7a: async reviews.cancel_request() emits DeprecationWarning
    @pytest.mark.asyncio
    async def test_async_cancel_request_emits_deprecation_warning(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "pending"})

        from gatewerk.async_client import AsyncReviewsResource
        transport = httpx.MockTransport(handler)
        http = httpx.AsyncClient(
            transport=transport,
            base_url="http://test:3100",
            headers={"Authorization": "Bearer gw_key_test", "Content-Type": "application/json"},
        )
        resource = AsyncReviewsResource(http, 0)
        with pytest.warns(DeprecationWarning, match="reviews.cancel_request"):
            await resource.cancel_request("gw_rev_001")
        await http.aclose()

    # T8: async action() path
    @pytest.mark.asyncio
    async def test_async_action_posts_correct_url(self):
        captured = {}

        def handler(request: httpx.Request):
            captured["url"] = str(request.url)
            captured["body"] = json.loads(request.content)
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "decided"})

        from gatewerk.async_client import AsyncReviewsResource
        from gatewerk._base import AsyncBaseResource

        transport = httpx.MockTransport(handler)
        http = httpx.AsyncClient(
            transport=transport,
            base_url="http://test:3100",
            headers={"Authorization": "Bearer gw_key_test", "Content-Type": "application/json"},
        )
        resource = AsyncReviewsResource(http, 0)
        result = await resource.action("gw_rev_001", "reject")
        await http.aclose()

        assert captured["url"].endswith("/api/v1/reviews/gw_rev_001/action")
        assert captured["body"] == {"action_id": "reject"}
        assert isinstance(result, Review)
