"""Tests for the resource-based client."""

from __future__ import annotations

import os
from unittest.mock import patch

import httpx
import pytest

from gatewerk import (
    create_client,
    GatewerkError,
    InvalidRequestError,
    NotFoundError,
    AuthenticationError,
    ConflictError,
    ResponseInfo,
    Review,
    ReviewList,
    FeedbackList,
    TemplateList,
    Template,
    TemplateStats,
    AuditList,
    WebhookDeliveryList,
    KeyInfo,
)


# -- Helpers -----------------------------------------------------------------


def _make_client_with_handler(handler, max_retries=0):
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


# -- create_client -----------------------------------------------------------


class TestCreateClient:
    def test_creates_with_explicit_config(self):
        gw = create_client(api_key="gw_key_test", url="http://localhost:3100")
        assert gw.reviews is not None
        assert gw.audit is not None
        assert gw.stats is not None
        assert gw.chains is not None
        assert gw.notes is not None
        gw.close()

    def test_falls_back_to_env_vars(self):
        with patch.dict(os.environ, {"GATEWERK_API_KEY": "gw_key_env", "GATEWERK_URL": "http://localhost:3100"}):
            gw = create_client()
            assert gw.reviews is not None
            gw.close()

    def test_raises_without_api_key(self):
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ValueError, match="API key is required"):
                create_client()

    def test_context_manager(self):
        with create_client(api_key="gw_key_test", url="http://localhost:3100") as gw:
            assert gw.reviews is not None

    def test_custom_retries_and_timeout(self):
        gw = create_client(api_key="gw_key_test", url="http://localhost:3100", max_retries=5, timeout=60.0)
        assert gw.reviews._max_retries == 5
        gw.close()

    def test_custom_http_client(self):
        transport = httpx.MockTransport(lambda r: httpx.Response(200, json={"ok": True}))
        custom = httpx.Client(transport=transport, base_url="http://custom:9999",
                              headers={"Authorization": "Bearer custom_key"})
        gw = create_client(api_key="ignored", url="ignored", http_client=custom)
        assert gw._owns_http is False
        gw.close()  # Should NOT close the custom client
        # Custom client should still work
        resp = custom.get("/health")
        assert resp.status_code == 200
        custom.close()

    def test_proxy_param(self):
        # Just verify it doesn't crash — actual proxy routing is httpx's job
        gw = create_client(api_key="gw_key_test", url="http://localhost:3100", proxy="http://proxy:8080")
        assert gw._owns_http is True
        gw.close()

    def test_verify_ssl_false(self):
        gw = create_client(api_key="gw_key_test", url="http://localhost:3100", verify_ssl=False)
        assert gw._owns_http is True
        gw.close()


# -- Reviews -----------------------------------------------------------------


class TestReviewsResource:
    def test_create_returns_review(self):
        def handler(request: httpx.Request):
            return httpx.Response(201, json={
                "id": "gw_rev_001", "object": "review", "status": "pending",
                "payload": {"service": "api"}, "priority": "high",
            })

        gw = _make_client_with_handler(handler)
        result = gw.reviews.create("deploy", {"service": "api"}, callback_url="https://example.com/webhook", priority="high")
        assert isinstance(result, Review)
        assert result.id == "gw_rev_001"

    def test_create_without_callback_url(self):
        def handler(request: httpx.Request):
            import json
            body = json.loads(request.content)
            assert "callback_url" not in body
            return httpx.Response(201, json={"id": "gw_rev_002", "object": "review", "status": "pending"})

        gw = _make_client_with_handler(handler)
        result = gw.reviews.create("deploy", {"service": "api"})
        assert result.id == "gw_rev_002"

    def test_create_raises_on_400(self):
        def handler(request: httpx.Request):
            return httpx.Response(400, json={
                "error": {"code": "template_not_found", "message": "Template not found", "param": "template"},
            })

        gw = _make_client_with_handler(handler)
        with pytest.raises(InvalidRequestError) as exc_info:
            gw.reviews.create("bad", {}, callback_url="https://example.com")
        assert exc_info.value.param == "template"
        assert exc_info.value.request_id is not None  # Request ID attached

    def test_get_returns_review(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "decided"})

        gw = _make_client_with_handler(handler)
        result = gw.reviews.get("gw_rev_001")
        assert isinstance(result, Review)

    def test_get_raises_not_found_with_raw_body(self):
        def handler(request: httpx.Request):
            return httpx.Response(404, json={
                "error": {"code": "review_not_found", "message": "Review not found"},
            })

        gw = _make_client_with_handler(handler)
        with pytest.raises(NotFoundError) as exc_info:
            gw.reviews.get("gw_rev_nonexistent")
        assert exc_info.value.raw_body is not None
        assert "Review not found" in exc_info.value.raw_body

    def test_list_returns_review_list(self):
        def handler(request: httpx.Request):
            assert "status=pending" in str(request.url)
            return httpx.Response(200, json={
                "items": [{"id": "gw_rev_001", "object": "review", "status": "pending"}],
                "total": 1, "has_more": False,
            })

        gw = _make_client_with_handler(handler)
        result = gw.reviews.list(status="pending")
        assert isinstance(result, ReviewList)
        assert len(result.items) == 1

    def test_decide(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={
                "id": "gw_rev_001", "object": "review", "status": "decided", "decision": "approved",
            })

        gw = _make_client_with_handler(handler)
        result = gw.reviews.decide("gw_rev_001", "approved", feedback="Looks good")
        assert result.decision == "approved"

    def test_decide_with_version_and_action(self):
        def handler(request: httpx.Request):
            import json
            body = json.loads(request.content)
            assert body["version"] == 2
            assert body["action_value"] == "send"
            return httpx.Response(200, json={
                "id": "gw_rev_001", "object": "review", "status": "decided", "decision": "approved",
            })

        gw = _make_client_with_handler(handler)
        gw.reviews.decide("gw_rev_001", "approved", version=2, action_value="send", action_label="Send Email")

    def test_retry(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "pending", "current_version": 2})

        gw = _make_client_with_handler(handler)
        result = gw.reviews.retry("gw_rev_001", feedback="Too formal")
        assert result.current_version == 2

    def test_update(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "pending", "current_version": 2})

        gw = _make_client_with_handler(handler)
        result = gw.reviews.update("gw_rev_001", {"service": "api-v2"}, version=2)
        assert result.current_version == 2

    def test_cancel_request(self):
        def handler(request: httpx.Request):
            assert "/cancel-request" in str(request.url)
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review", "status": "pending"})

        gw = _make_client_with_handler(handler)
        result = gw.reviews.cancel_request("gw_rev_001")
        assert result.status == "pending"

    def test_versions(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json=[
                {"version": 1, "payload": {"v": 1}},
                {"version": 2, "payload": {"v": 2}},
            ])

        gw = _make_client_with_handler(handler)
        result = gw.reviews.versions("gw_rev_001")
        assert len(result) == 2

    def test_create_token(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"token": "abc123", "url": "https://app.gatewerk.com/r/abc123"})

        gw = _make_client_with_handler(handler)
        result = gw.reviews.create_token("gw_rev_001")
        assert result["token"] == "abc123"

    def test_list_auto_paginate(self):
        call_count = 0

        def handler(request: httpx.Request):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return httpx.Response(200, json={
                    "items": [{"id": "gw_rev_001", "object": "review"}],
                    "total": 2, "has_more": True,
                })
            return httpx.Response(200, json={
                "items": [{"id": "gw_rev_002", "object": "review"}],
                "total": 2, "has_more": False,
            })

        gw = _make_client_with_handler(handler)
        reviews = list(gw.reviews.list_auto_paginate(batch_size=1))
        assert len(reviews) == 2

    def test_authentication_error(self):
        def handler(request: httpx.Request):
            return httpx.Response(401, json={
                "error": {"code": "invalid_key", "message": "Invalid API key"},
            })

        gw = _make_client_with_handler(handler)
        with pytest.raises(AuthenticationError):
            gw.reviews.get("gw_rev_001")

    def test_conflict_error(self):
        def handler(request: httpx.Request):
            return httpx.Response(409, json={
                "error": {"code": "already_decided", "message": "Review already decided"},
            })

        gw = _make_client_with_handler(handler)
        with pytest.raises(ConflictError):
            gw.reviews.decide("gw_rev_001", "approved")


# -- Feedback ----------------------------------------------------------------


class TestFeedbackResource:
    def test_query(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={
                "items": [{"review_id": "gw_rev_001", "decision": "approved"}],
                "total": 1, "has_more": False,
            })

        gw = _make_client_with_handler(handler)
        result = gw.feedback.query(template="deploy")
        assert isinstance(result, FeedbackList)
        assert result.items[0].decision == "approved"


# -- Templates ---------------------------------------------------------------


class TestTemplatesResource:
    def test_list(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={
                "items": [{"id": "gw_tpl_001", "name": "Email Review", "slug": "email-review"}],
                "total": 1, "has_more": False,
            })

        gw = _make_client_with_handler(handler)
        result = gw.templates.list()
        assert isinstance(result, TemplateList)

    def test_get(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_tpl_001", "name": "Email Review", "slug": "email-review"})

        gw = _make_client_with_handler(handler)
        result = gw.templates.get("gw_tpl_001")
        assert isinstance(result, Template)

    def test_create(self):
        def handler(request: httpx.Request):
            return httpx.Response(201, json={"id": "gw_tpl_002", "name": "New", "slug": "new"})

        gw = _make_client_with_handler(handler)
        result = gw.templates.create("New", "new")
        assert result.id == "gw_tpl_002"

    def test_update(self):
        def handler(request: httpx.Request):
            import json
            body = json.loads(request.content)
            assert body["name"] == "Updated"
            return httpx.Response(200, json={"id": "gw_tpl_001", "name": "Updated", "slug": "email-review"})

        gw = _make_client_with_handler(handler)
        result = gw.templates.update("gw_tpl_001", name="Updated")
        assert result.name == "Updated"

    def test_delete(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"deleted": True})

        gw = _make_client_with_handler(handler)
        result = gw.templates.delete("gw_tpl_001")
        assert result["deleted"] is True

    def test_stats(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={
                "template_id": "gw_tpl_001", "total_reviews": 100, "approval_rate": 0.75,
            })

        gw = _make_client_with_handler(handler)
        result = gw.templates.stats("gw_tpl_001")
        assert isinstance(result, TemplateStats)
        assert result.approval_rate == 0.75


# -- Webhooks ----------------------------------------------------------------


class TestWebhookDeliveries:
    def test_deliveries(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={
                "items": [{"id": "del_001", "review_id": "gw_rev_001", "success": True}],
                "total": 1, "has_more": False,
            })

        gw = _make_client_with_handler(handler)
        result = gw.webhooks.deliveries(review_id="gw_rev_001")
        assert isinstance(result, WebhookDeliveryList)
        assert result.items[0].success is True


# -- Key Info ----------------------------------------------------------------


class TestKeyInfo:
    def test_key_info(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"prefix": "gw_key_abc", "scopes": ["reviews:create"]})

        gw = _make_client_with_handler(handler)
        result = gw.key_info()
        assert isinstance(result, KeyInfo)
        assert "reviews:create" in result.scopes


# -- Audit / Stats -----------------------------------------------------------


class TestAuditResource:
    def test_query(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={
                "items": [{"id": "gw_aud_001", "action": "review.decided"}],
                "total": 1, "has_more": False,
            })

        gw = _make_client_with_handler(handler)
        result = gw.audit.query(action="review.decided")
        assert isinstance(result, AuditList)


class TestStatsResource:
    def test_get(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"total_reviews": 42})

        gw = _make_client_with_handler(handler)
        assert gw.stats.get()["total_reviews"] == 42


# -- Response metadata -------------------------------------------------------


class TestResponseMetadata:
    def test_last_response_populated(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json={"id": "gw_rev_001", "object": "review"},
                                  headers={"x-request-id": "srv-req-123", "x-ratelimit-remaining": "99"})

        gw = _make_client_with_handler(handler)
        gw.reviews.get("gw_rev_001")

        info = gw.reviews.last_response
        assert isinstance(info, ResponseInfo)
        assert info.status_code == 200
        assert info.request_id is not None  # Client-side UUID
        assert info.server_request_id == "srv-req-123"
        assert info.rate_limit_remaining == 99

    def test_request_id_on_exception(self):
        def handler(request: httpx.Request):
            return httpx.Response(404, json={"error": {"message": "Not found"}})

        gw = _make_client_with_handler(handler)
        with pytest.raises(GatewerkError) as exc_info:
            gw.reviews.get("gw_rev_nonexistent")
        assert exc_info.value.request_id is not None  # UUID attached

    def test_raw_body_on_exception(self):
        def handler(request: httpx.Request):
            return httpx.Response(502, text="Bad Gateway")

        gw = _make_client_with_handler(handler)
        with pytest.raises(GatewerkError) as exc_info:
            gw.reviews.get("gw_rev_001")
        assert exc_info.value.raw_body == "Bad Gateway"


# -- Error fallback ----------------------------------------------------------


class TestErrorHandling:
    def test_unknown_error_raises_gatewerk_error(self):
        def handler(request: httpx.Request):
            return httpx.Response(500, json={"error": {"message": "Internal server error"}})

        gw = _make_client_with_handler(handler)
        with pytest.raises(GatewerkError):
            gw.reviews.get("gw_rev_001")

    def test_non_json_error_body(self):
        def handler(request: httpx.Request):
            return httpx.Response(502, text="Bad Gateway")

        gw = _make_client_with_handler(handler)
        with pytest.raises(GatewerkError):
            gw.reviews.get("gw_rev_001")
