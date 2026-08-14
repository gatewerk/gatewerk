"""Tests for the chains resource (sync + async).

Mirrors the test_reviews.py mock-handler pattern: each test installs an
httpx.MockTransport that asserts on the request shape and returns a
fixture response, then calls the resource and asserts on the typed
response. No network. No real backend.
"""

from __future__ import annotations

import json

import httpx
import pytest

from gatewerk import (
    AsyncGatewerkClient,
    ChainDefinition,
    ChainDefinitionStep,
    ChainRunObject,
)


# ---------------------------------------------------------------------------
# Sync client harness — duplicates _make_client_with_handler from test_client
# rather than cross-importing so the file is self-contained.
# ---------------------------------------------------------------------------


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
        headers={
            "Authorization": "Bearer gw_key_test",
            "Content-Type": "application/json",
        },
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


def _make_async_client(handler, max_retries=0):
    from gatewerk.async_client import (
        AsyncReviewsResource,
        AsyncFeedbackResource,
        AsyncTemplatesResource,
        AsyncWebhooksResource,
        AsyncAuditResource,
        AsyncStatsResource,
        AsyncChainsResource,
        AsyncNotesResource,
    )
    from gatewerk._base import AsyncBaseResource

    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(
        transport=transport,
        base_url="http://test:3100",
        headers={
            "Authorization": "Bearer gw_key_test",
            "Content-Type": "application/json",
        },
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


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _chain_run_response() -> dict:
    return {
        "object": "chain_run",
        "id": "gw_chr_001",
        "project_id": "gw_proj_001",
        "template_id": None,
        "name": "Refund chain",
        "mode": "sequential",
        "rejection_policy": "terminate",
        "status": "active",
        "metadata": None,
        "created_by": "agent:gw_key_abc",
        "created_at": "2026-05-03T10:00:00Z",
        "completed_at": None,
        "steps": [
            {
                "object": "chain_step",
                "id": "gw_chs_001",
                "chain_run_id": "gw_chr_001",
                "step_number": 1,
                "review_id": "gw_rev_001",
                "assignee_spec": {"kind": "role", "role": "admin"},
                "depends_on": None,
                "status": "active",
                "materialized_at": "2026-05-03T10:00:00Z",
                "rejection_policy": "abort",
                "rejection_branch_to": None,
            }
        ],
        "step_1_review_id": "gw_rev_001",
    }


# ---------------------------------------------------------------------------
# Sync tests
# ---------------------------------------------------------------------------


class TestChainsCreate:
    def test_create_with_dict_definition(self):
        """Bare dicts pass through unchanged — most ergonomic for ad-hoc uses."""
        captured: dict = {}

        def handler(request: httpx.Request):
            assert request.method == "POST"
            assert request.url.path == "/api/v1/chain-runs"
            captured["body"] = json.loads(request.content)
            return httpx.Response(201, json=_chain_run_response())

        gw = _make_client(handler)
        result = gw.chains.create(
            definition={
                "version": "1.0",
                "mode": "sequential",
                "steps": [
                    {
                        "id": "step_1",
                        "template": "refund_approval",
                        "assignee": {"kind": "role", "role": "admin"},
                    }
                ],
            },
            initial_payload={"amount": 250.0},
            callback_url="https://my-agent.com/webhook",
            metadata={"chain_kind": "refund"},
        )

        assert isinstance(result, ChainRunObject)
        assert result.id == "gw_chr_001"
        assert result.status == "active"
        assert result.step_1_review_id == "gw_rev_001"
        assert result.steps is not None
        assert result.steps[0].review_id == "gw_rev_001"

        body = captured["body"]
        assert body["definition"]["version"] == "1.0"
        assert body["initial_payload"] == {"amount": 250.0}
        assert body["callback_url"] == "https://my-agent.com/webhook"
        assert body["metadata"] == {"chain_kind": "refund"}

    def test_create_with_pydantic_definition(self):
        """ChainDefinition Pydantic models are serialized via model_dump."""
        captured: dict = {}

        def handler(request: httpx.Request):
            captured["body"] = json.loads(request.content)
            return httpx.Response(201, json=_chain_run_response())

        gw = _make_client(handler)
        defn = ChainDefinition(
            version="1.0",
            mode="sequential",
            steps=[
                ChainDefinitionStep(
                    id="step_1",
                    template="refund_approval",
                    assignee={"kind": "role", "role": "admin"},
                )
            ],
        )
        result = gw.chains.create(definition=defn, initial_payload={"amount": 1.0})

        assert isinstance(result, ChainRunObject)
        body = captured["body"]
        assert body["definition"]["mode"] == "sequential"
        # exclude_none should drop the optional fields we didn't set
        assert "callback_url" not in body
        assert "metadata" not in body

    def test_create_omits_optional_fields(self):
        captured: dict = {}

        def handler(request: httpx.Request):
            captured["body"] = json.loads(request.content)
            return httpx.Response(201, json=_chain_run_response())

        gw = _make_client(handler)
        gw.chains.create(definition={"version": "1.0", "mode": "sequential", "steps": []}, initial_payload={})
        body = captured["body"]
        assert "callback_url" not in body
        assert "metadata" not in body


class TestChainsGet:
    def test_get_returns_chain_run(self):
        def handler(request: httpx.Request):
            assert request.method == "GET"
            assert request.url.path == "/api/v1/chain-runs/gw_chr_001"
            return httpx.Response(200, json=_chain_run_response())

        gw = _make_client(handler)
        result = gw.chains.get("gw_chr_001")
        assert isinstance(result, ChainRunObject)
        assert result.id == "gw_chr_001"
        assert result.steps is not None
        assert len(result.steps) == 1


class TestChainsGetForReview:
    def test_get_for_review(self):
        body = _chain_run_response()
        body["current_step_number"] = 1

        def handler(request: httpx.Request):
            assert request.method == "GET"
            assert request.url.path == "/api/v1/reviews/gw_rev_001/chain"
            return httpx.Response(200, json=body)

        gw = _make_client(handler)
        result = gw.chains.get_for_review("gw_rev_001")
        assert isinstance(result, ChainRunObject)
        assert result.current_step_number == 1


# ---------------------------------------------------------------------------
# Async tests
# ---------------------------------------------------------------------------


class TestAsyncChains:
    @pytest.mark.asyncio
    async def test_create(self):
        def handler(request: httpx.Request):
            assert request.method == "POST"
            return httpx.Response(201, json=_chain_run_response())

        gw = _make_async_client(handler)
        result = await gw.chains.create(
            definition={"version": "1.0", "mode": "sequential", "steps": []},
            initial_payload={"amount": 1.0},
        )
        assert isinstance(result, ChainRunObject)
        assert result.id == "gw_chr_001"

    @pytest.mark.asyncio
    async def test_get(self):
        def handler(request: httpx.Request):
            return httpx.Response(200, json=_chain_run_response())

        gw = _make_async_client(handler)
        result = await gw.chains.get("gw_chr_001")
        assert result.id == "gw_chr_001"

    @pytest.mark.asyncio
    async def test_get_for_review(self):
        body = _chain_run_response()
        body["current_step_number"] = 1

        def handler(request: httpx.Request):
            assert request.url.path == "/api/v1/reviews/gw_rev_001/chain"
            return httpx.Response(200, json=body)

        gw = _make_async_client(handler)
        result = await gw.chains.get_for_review("gw_rev_001")
        assert result.current_step_number == 1
