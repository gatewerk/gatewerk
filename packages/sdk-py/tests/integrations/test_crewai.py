"""Tests for the CrewAI adapter.

Covers:
* :func:`GatewerkApprovalTool` end-to-end: review creation, polling,
  and the string returned to the agent for each terminal status.
* Argument-key handling (``default_payload_key`` and the open-schema
  variant).
* Timeout behaviour.
* Tool metadata visible to the CrewAI registry (name, description,
  args_schema).
* :func:`await_decision` polling helper (mirror of the LangGraph tests
  to confirm the shared ``common`` module wiring still works).

All Gatewerk API calls are mocked with respx — no network. The CrewAI
side instantiates the tool and invokes ``_run`` directly; we don't run a
real LLM-driven Crew because the tool's contract with CrewAI is purely
its name/description/args_schema/_run quartet.
"""

from __future__ import annotations

import json
import sys
from typing import Any

import httpx
import pytest
import respx

from gatewerk import create_client
from gatewerk.integrations.crewai import (
    Decision,
    GatewerkApprovalTool,
    await_decision,
)


GW_URL = "http://test:3100"
REVIEW_ID = "gw_rev_crewai_test"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def gw_client():
    client = create_client(api_key="gw_key_test", url=GW_URL)
    yield client
    client.close()


@pytest.fixture
def pending_review_response() -> dict[str, Any]:
    return {
        "id": REVIEW_ID,
        "object": "review",
        "template_slug": "refund_approval",
        "payload": {"amount": 250},
        "status": "pending",
    }


@pytest.fixture
def approved_review_response() -> dict[str, Any]:
    return {
        "id": REVIEW_ID,
        "object": "review",
        "template_slug": "refund_approval",
        "payload": {"amount": 250},
        "status": "decided",
        "decision": "approved",
        "decided_by": "alice@acme.com",
        "decided_at": "2026-04-26T10:00:00Z",
        "feedback": "Looks fine",
    }


@pytest.fixture
def rejected_review_response() -> dict[str, Any]:
    return {
        "id": REVIEW_ID,
        "object": "review",
        "template_slug": "refund_approval",
        "payload": {"amount": 250},
        "status": "decided",
        "decision": "rejected",
        "decided_by": "alice@acme.com",
        "decided_at": "2026-04-26T10:00:00Z",
        "feedback": "Amount exceeds policy limit",
    }


@pytest.fixture
def changes_requested_review_response() -> dict[str, Any]:
    return {
        "id": REVIEW_ID,
        "object": "review",
        "template_slug": "refund_approval",
        "payload": {"amount": 250},
        "edited_payload": {"amount": 100},
        "status": "decided",
        "decision": "changes_requested",
        "decided_by": "alice@acme.com",
        "decided_at": "2026-04-26T10:00:00Z",
        "feedback": "Cap at $100",
    }


# ---------------------------------------------------------------------------
# Tool metadata — what CrewAI's tool registry sees
# ---------------------------------------------------------------------------


class TestToolMetadata:
    def test_default_name_and_description(self, gw_client):
        tool = GatewerkApprovalTool(gw_client, template="refund_approval")
        assert tool.name == "gatewerk_approval"
        # CrewAI wraps the raw description for the LLM. Read the raw default
        # off the pydantic field so we can assert against our own copy.
        raw = type(tool).model_fields["description"].default
        assert "human approval" in raw.lower()
        assert "APPROVED" in raw
        assert "REJECTED" in raw
        assert "CHANGES_REQUESTED" in raw

    def test_overrides_apply(self, gw_client):
        tool = GatewerkApprovalTool(
            gw_client,
            template="refund_approval",
            name="ask_human",
            description="Ask Alice before refunding.",
        )
        assert tool.name == "ask_human"
        raw = type(tool).model_fields["description"].default
        assert raw == "Ask Alice before refunding."

    def test_default_args_schema_has_payload_field(self, gw_client):
        tool = GatewerkApprovalTool(gw_client, template="refund_approval")
        schema = tool.args_schema
        assert schema.__name__ == "GatewerkApprovalArgs"
        assert list(schema.model_fields.keys()) == ["payload"]

    def test_custom_payload_key(self, gw_client):
        tool = GatewerkApprovalTool(
            gw_client,
            template="refund_approval",
            default_payload_key="action",
        )
        assert list(tool.args_schema.model_fields.keys()) == ["action"]

    def test_open_schema_when_payload_key_is_none(self, gw_client):
        tool = GatewerkApprovalTool(
            gw_client,
            template="refund_approval",
            default_payload_key=None,
        )
        # Open schema accepts arbitrary fields (extra="allow"), no declared fields.
        assert tool.args_schema.model_config.get("extra") == "allow"

    def test_is_crewai_basetool_instance(self, gw_client):
        from crewai.tools import BaseTool

        tool = GatewerkApprovalTool(gw_client, template="refund_approval")
        assert isinstance(tool, BaseTool)


# ---------------------------------------------------------------------------
# _run — round-trips through the Gatewerk API
# ---------------------------------------------------------------------------


class TestRunRoundTrip:
    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_creates_review_with_correct_body(
        self, respx_mock, gw_client, pending_review_response, approved_review_response
    ):
        post_route = respx_mock.post("/api/v1/reviews").mock(
            return_value=httpx.Response(201, json=pending_review_response)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=httpx.Response(200, json=approved_review_response)
        )

        tool = GatewerkApprovalTool(
            gw_client,
            template="refund_approval",
            review_kwargs={"priority": "high"},
            poll_interval=0.01,
        )
        tool._run(payload={"amount": 250, "customer_id": "cust_42"})

        assert post_route.called
        body = json.loads(post_route.calls[0].request.content)
        assert body["template"] == "refund_approval"
        assert body["payload"] == {"amount": 250, "customer_id": "cust_42"}
        assert body["priority"] == "high"

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_returns_approved_string(
        self, respx_mock, gw_client, pending_review_response, approved_review_response
    ):
        respx_mock.post("/api/v1/reviews").mock(
            return_value=httpx.Response(201, json=pending_review_response)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            side_effect=[
                httpx.Response(200, json=pending_review_response),
                httpx.Response(200, json=approved_review_response),
            ]
        )

        tool = GatewerkApprovalTool(
            gw_client, template="refund_approval", poll_interval=0.01
        )
        result = tool._run(payload={"amount": 250})

        assert result.startswith("APPROVED")
        assert "Looks fine" in result

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_returns_rejected_string(
        self, respx_mock, gw_client, pending_review_response, rejected_review_response
    ):
        respx_mock.post("/api/v1/reviews").mock(
            return_value=httpx.Response(201, json=pending_review_response)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=httpx.Response(200, json=rejected_review_response)
        )

        tool = GatewerkApprovalTool(
            gw_client, template="refund_approval", poll_interval=0.01
        )
        result = tool._run(payload={"amount": 250})

        assert result.startswith("REJECTED")
        assert "Amount exceeds policy limit" in result

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_returns_changes_requested_with_feedback_and_edits(
        self,
        respx_mock,
        gw_client,
        pending_review_response,
        changes_requested_review_response,
    ):
        respx_mock.post("/api/v1/reviews").mock(
            return_value=httpx.Response(201, json=pending_review_response)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=httpx.Response(200, json=changes_requested_review_response)
        )

        tool = GatewerkApprovalTool(
            gw_client, template="refund_approval", poll_interval=0.01
        )
        result = tool._run(payload={"amount": 250})

        assert result.startswith("CHANGES_REQUESTED")
        assert "Cap at $100" in result
        assert "edited_payload" in result
        assert "100" in result

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_raises_timeout_if_review_stays_pending(
        self, respx_mock, gw_client, pending_review_response
    ):
        respx_mock.post("/api/v1/reviews").mock(
            return_value=httpx.Response(201, json=pending_review_response)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=httpx.Response(200, json=pending_review_response)
        )

        tool = GatewerkApprovalTool(
            gw_client,
            template="refund_approval",
            poll_interval=0.01,
            await_timeout=0.05,
        )
        with pytest.raises(TimeoutError, match=REVIEW_ID):
            tool._run(payload={"amount": 250})

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_open_schema_passes_kwargs_as_payload(
        self, respx_mock, gw_client, pending_review_response, approved_review_response
    ):
        post_route = respx_mock.post("/api/v1/reviews").mock(
            return_value=httpx.Response(201, json=pending_review_response)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=httpx.Response(200, json=approved_review_response)
        )

        tool = GatewerkApprovalTool(
            gw_client,
            template="refund_approval",
            default_payload_key=None,
            poll_interval=0.01,
        )
        tool._run(amount=250, customer_id="cust_42")

        body = json.loads(post_route.calls[0].request.content)
        assert body["payload"] == {"amount": 250, "customer_id": "cust_42"}


# ---------------------------------------------------------------------------
# Lazy import — CrewAI not installed
# ---------------------------------------------------------------------------


class TestLazyImport:
    def test_raises_clear_import_error_without_crewai(self, gw_client, monkeypatch):
        """Simulate ``crewai`` not being installed."""
        monkeypatch.setitem(sys.modules, "crewai", None)
        monkeypatch.setitem(sys.modules, "crewai.tools", None)
        with pytest.raises(ImportError, match=r"gatewerk\[crewai\]"):
            GatewerkApprovalTool(gw_client, template="refund_approval")


# ---------------------------------------------------------------------------
# await_decision — mirror of M14 test, confirms common-module wiring
# ---------------------------------------------------------------------------


class TestAwaitDecisionViaCrewaiNamespace:
    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_polls_until_decided(
        self, respx_mock, gw_client, pending_review_response, approved_review_response
    ):
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            side_effect=[
                httpx.Response(200, json=pending_review_response),
                httpx.Response(200, json=pending_review_response),
                httpx.Response(200, json=approved_review_response),
            ]
        )

        decision = await_decision(gw_client, REVIEW_ID, poll_interval=0.01)
        assert isinstance(decision, Decision)
        assert decision.approved is True
        assert decision.review_id == REVIEW_ID

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_times_out_when_pending(
        self, respx_mock, gw_client, pending_review_response
    ):
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=httpx.Response(200, json=pending_review_response)
        )

        with pytest.raises(TimeoutError, match=REVIEW_ID):
            await_decision(gw_client, REVIEW_ID, poll_interval=0.01, timeout=0.05)
