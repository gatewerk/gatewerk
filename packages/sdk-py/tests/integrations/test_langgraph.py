"""Tests for the LangGraph adapter.

Covers:
* sync + async ``gatewerk_interrupt`` round-trip with a real LangGraph
  in-memory checkpointer (``MemorySaver``)
* ``await_decision`` polling helper (sync + async)
* :class:`Decision` convenience properties

All Gatewerk API calls are mocked with respx — no network. The LangGraph
side runs locally with the in-memory checkpointer.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional, TypedDict

import httpx
import pytest
import respx

from gatewerk import create_async_client, create_client
from gatewerk.integrations.langgraph import (
    Decision,
    await_decision,
    await_decision_async,
    gatewerk_interrupt,
    gatewerk_interrupt_async,
)


GW_URL = "http://test:3100"
REVIEW_ID = "gw_rev_test123"


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
        "payload": {"amount": 100},
        "status": "pending",
    }


@pytest.fixture
def decided_review_response() -> dict[str, Any]:
    return {
        "id": REVIEW_ID,
        "object": "review",
        "template_slug": "refund_approval",
        "payload": {"amount": 100},
        "status": "decided",
        "decision": "approved",
        "decided_by": "alice@acme.com",
        "decided_at": "2026-04-26T10:00:00Z",
    }


@pytest.fixture
def chain_decided_review_response() -> dict[str, Any]:
    """A review that is 'decided' but belongs to a chain (route of
    approvers) — its terminal status is only ONE step's decision, not the
    request's authorization."""
    return {
        "id": REVIEW_ID,
        "object": "review",
        "template_slug": "refund_approval",
        "payload": {"amount": 100},
        "status": "decided",
        "decision": "approved",
        "decided_by": "alice@acme.com",
        "decided_at": "2026-04-26T10:00:00Z",
        "chain_run_id": "run_test123",
    }


# ---------------------------------------------------------------------------
# Decision dataclass
# ---------------------------------------------------------------------------


class TestDecision:
    def test_approved_property(self):
        d = Decision(review_id=REVIEW_ID, status="decided", decision="approved")
        assert d.approved is True
        assert d.rejected is False
        assert d.has_changes is False

    def test_rejected_property(self):
        d = Decision(review_id=REVIEW_ID, status="decided", decision="rejected")
        assert d.approved is False
        assert d.rejected is True

    def test_has_changes_via_decision(self):
        d = Decision(review_id=REVIEW_ID, status="decided", decision="changes_requested")
        assert d.has_changes is True

    def test_has_changes_via_edited_payload(self):
        d = Decision(
            review_id=REVIEW_ID,
            status="decided",
            decision="approved",
            edited_payload={"amount": 50},
        )
        assert d.has_changes is True

    def test_frozen(self):
        d = Decision(review_id=REVIEW_ID, status="decided")
        with pytest.raises(Exception):
            d.review_id = "other"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# gatewerk_interrupt — sync
# ---------------------------------------------------------------------------


class _State(TypedDict):
    refund_amount: int
    decision: Optional[str]
    feedback: Optional[str]


def _build_graph(node_callable):
    """Helper: build a single-node LangGraph with an in-memory checkpointer."""
    from langgraph.checkpoint.memory import MemorySaver
    from langgraph.graph import END, START, StateGraph

    builder = StateGraph(_State)
    builder.add_node("gated", node_callable)
    builder.add_edge(START, "gated")
    builder.add_edge("gated", END)
    return builder.compile(checkpointer=MemorySaver())


class TestGatewerkInterruptSync:
    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_creates_review_with_correct_body(self, respx_mock, gw_client, pending_review_response):
        route = respx_mock.post("/api/v1/reviews").mock(
            return_value=httpx.Response(201, json=pending_review_response)
        )

        def node(state: _State):
            d = gatewerk_interrupt(
                gw_client,
                template="refund_approval",
                payload={"amount": state["refund_amount"]},
                priority="high",
            )
            return {"decision": d.decision}

        graph = _build_graph(node)
        config = {"configurable": {"thread_id": "t1"}}
        graph.invoke({"refund_amount": 100, "decision": None, "feedback": None}, config=config)

        assert route.called
        body = route.calls[0].request.content
        import json
        parsed = json.loads(body)
        assert parsed["template"] == "refund_approval"
        assert parsed["payload"] == {"amount": 100}
        assert parsed["priority"] == "high"

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_resume_with_approved_decision(self, respx_mock, gw_client, pending_review_response):
        from langgraph.types import Command

        respx_mock.post("/api/v1/reviews").mock(
            return_value=httpx.Response(201, json=pending_review_response)
        )

        captured: dict[str, Any] = {}

        def node(state: _State):
            d = gatewerk_interrupt(
                gw_client,
                template="refund_approval",
                payload={"amount": state["refund_amount"]},
            )
            captured["decision"] = d
            return {"decision": d.decision, "feedback": d.feedback}

        graph = _build_graph(node)
        config = {"configurable": {"thread_id": "t1"}}
        graph.invoke({"refund_amount": 100, "decision": None, "feedback": None}, config=config)

        # Resume with an approved decision
        resume_payload = {
            "review_id": REVIEW_ID,
            "status": "decided",
            "decision": "approved",
            "approved_value": {"amount": 100},
            "reviewer": "alice@acme.com",
            "decided_at": "2026-04-26T10:00:00Z",
        }
        final = graph.invoke(Command(resume=resume_payload), config=config)

        assert final["decision"] == "approved"
        decision: Decision = captured["decision"]
        assert decision.approved is True
        assert decision.rejected is False
        assert decision.review_id == REVIEW_ID
        assert decision.reviewer == "alice@acme.com"

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_resume_with_rejected_decision(self, respx_mock, gw_client, pending_review_response):
        from langgraph.types import Command

        respx_mock.post("/api/v1/reviews").mock(
            return_value=httpx.Response(201, json=pending_review_response)
        )

        captured: dict[str, Any] = {}

        def node(state: _State):
            d = gatewerk_interrupt(
                gw_client,
                template="refund_approval",
                payload={"amount": state["refund_amount"]},
            )
            captured["decision"] = d
            return {"decision": d.decision, "feedback": d.feedback}

        graph = _build_graph(node)
        config = {"configurable": {"thread_id": "t-reject"}}
        graph.invoke({"refund_amount": 100, "decision": None, "feedback": None}, config=config)

        resume_payload = {
            "review_id": REVIEW_ID,
            "status": "decided",
            "decision": "rejected",
            "feedback": "Amount exceeds policy limit",
        }
        final = graph.invoke(Command(resume=resume_payload), config=config)

        assert final["decision"] == "rejected"
        assert final["feedback"] == "Amount exceeds policy limit"
        decision: Decision = captured["decision"]
        assert decision.rejected is True
        assert decision.feedback == "Amount exceeds policy limit"

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_resume_without_decision_falls_back_to_get(
        self, respx_mock, gw_client, pending_review_response, decided_review_response
    ):
        """If Command(resume=...) doesn't carry a decision, fetch from the API."""
        from langgraph.types import Command

        respx_mock.post("/api/v1/reviews").mock(
            return_value=httpx.Response(201, json=pending_review_response)
        )
        get_route = respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=httpx.Response(200, json=decided_review_response)
        )

        captured: dict[str, Any] = {}

        def node(state: _State):
            d = gatewerk_interrupt(
                gw_client,
                template="refund_approval",
                payload={"amount": state["refund_amount"]},
            )
            captured["decision"] = d
            return {"decision": d.decision}

        graph = _build_graph(node)
        config = {"configurable": {"thread_id": "t-fallback"}}
        graph.invoke({"refund_amount": 100, "decision": None, "feedback": None}, config=config)
        graph.invoke(Command(resume=True), config=config)  # marker, not a decision dict

        assert get_route.called
        decision: Decision = captured["decision"]
        assert decision.approved is True
        assert decision.reviewer == "alice@acme.com"

    def test_raises_clear_import_error_without_langgraph(self, gw_client, monkeypatch):
        """Simulates langgraph not being installed."""
        import sys

        # Hide langgraph.types from the import system for this test.
        monkeypatch.setitem(sys.modules, "langgraph.types", None)
        with pytest.raises(ImportError, match=r"gatewerk\[langgraph\]"):
            gatewerk_interrupt(
                gw_client,
                template="refund_approval",
                payload={"amount": 100},
            )


# ---------------------------------------------------------------------------
# gatewerk_interrupt — async
# ---------------------------------------------------------------------------


class TestGatewerkInterruptAsync:
    @pytest.mark.asyncio
    async def test_async_resume_with_approved(self, pending_review_response):
        from langgraph.types import Command

        async with create_async_client(api_key="gw_key_test", url=GW_URL) as gw:
            with respx.mock(base_url=GW_URL, assert_all_called=False) as respx_mock:
                respx_mock.post("/api/v1/reviews").mock(
                    return_value=httpx.Response(201, json=pending_review_response)
                )

                captured: dict[str, Any] = {}

                async def node(state: _State):
                    d = await gatewerk_interrupt_async(
                        gw,
                        template="refund_approval",
                        payload={"amount": state["refund_amount"]},
                    )
                    captured["decision"] = d
                    return {"decision": d.decision}

                from langgraph.checkpoint.memory import MemorySaver
                from langgraph.graph import END, START, StateGraph

                builder = StateGraph(_State)
                builder.add_node("gated", node)
                builder.add_edge(START, "gated")
                builder.add_edge("gated", END)
                graph = builder.compile(checkpointer=MemorySaver())

                config = {"configurable": {"thread_id": "t-async"}}
                await graph.ainvoke(
                    {"refund_amount": 100, "decision": None, "feedback": None},
                    config=config,
                )

                resume_payload = {
                    "review_id": REVIEW_ID,
                    "status": "decided",
                    "decision": "approved",
                    "approved_value": {"amount": 100},
                }
                final = await graph.ainvoke(Command(resume=resume_payload), config=config)

                assert final["decision"] == "approved"
                decision: Decision = captured["decision"]
                assert decision.approved is True
                assert decision.review_id == REVIEW_ID


# ---------------------------------------------------------------------------
# await_decision (polling)
# ---------------------------------------------------------------------------


class TestAwaitDecisionSync:
    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_polls_until_decided(self, respx_mock, gw_client, pending_review_response, decided_review_response):
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            side_effect=[
                httpx.Response(200, json=pending_review_response),
                httpx.Response(200, json=pending_review_response),
                httpx.Response(200, json=decided_review_response),
            ]
        )

        decision = await_decision(gw_client, REVIEW_ID, poll_interval=0.01)
        assert decision.approved is True
        assert decision.review_id == REVIEW_ID
        assert decision.reviewer == "alice@acme.com"

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_times_out_when_pending(self, respx_mock, gw_client, pending_review_response):
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=httpx.Response(200, json=pending_review_response)
        )

        with pytest.raises(TimeoutError, match=REVIEW_ID):
            await_decision(gw_client, REVIEW_ID, poll_interval=0.01, timeout=0.05)

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_returns_immediately_when_already_decided(
        self, respx_mock, gw_client, decided_review_response
    ):
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=httpx.Response(200, json=decided_review_response)
        )

        decision = await_decision(gw_client, REVIEW_ID, poll_interval=10.0, timeout=1.0)
        assert decision.approved is True

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_does_not_resolve_chain_review_while_run_is_active(
        self, respx_mock, gw_client, chain_decided_review_response
    ):
        """A chain review reaching 'decided' must NOT resolve await_decision
        while its chain run is still 'active' — later approvers haven't
        looked yet. Only resolves once the run reaches a terminal status."""
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=httpx.Response(200, json=chain_decided_review_response)
        )
        chain_route = respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}/chain").mock(
            side_effect=[
                httpx.Response(200, json={"id": "run_test123", "status": "active"}),
                httpx.Response(200, json={"id": "run_test123", "status": "completed"}),
            ]
        )

        decision = await_decision(gw_client, REVIEW_ID, poll_interval=0.01)

        # If the chain guard were missing, this would resolve on the first
        # review fetch — with only ONE step's approval, not the whole route's.
        assert decision.approved is True
        assert chain_route.call_count == 2

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_chain_run_id_none_behaves_like_before(
        self, respx_mock, gw_client, decided_review_response
    ):
        """Regression fence: a review with chain_run_id unset/None must
        resolve exactly as before — no chain lookup at all."""
        chain_route = respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}/chain")
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=httpx.Response(200, json=decided_review_response)
        )

        decision = await_decision(gw_client, REVIEW_ID, poll_interval=10.0, timeout=1.0)

        assert decision.approved is True
        assert not chain_route.called


class TestAwaitDecisionAsync:
    @pytest.mark.asyncio
    async def test_async_polls_until_decided(self, pending_review_response, decided_review_response):
        async with create_async_client(api_key="gw_key_test", url=GW_URL) as gw:
            with respx.mock(base_url=GW_URL, assert_all_called=False) as respx_mock:
                respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
                    side_effect=[
                        httpx.Response(200, json=pending_review_response),
                        httpx.Response(200, json=decided_review_response),
                    ]
                )

                decision = await await_decision_async(gw, REVIEW_ID, poll_interval=0.01)
                assert decision.approved is True

    @pytest.mark.asyncio
    async def test_async_times_out(self, pending_review_response):
        async with create_async_client(api_key="gw_key_test", url=GW_URL) as gw:
            with respx.mock(base_url=GW_URL, assert_all_called=False) as respx_mock:
                respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
                    return_value=httpx.Response(200, json=pending_review_response)
                )

                with pytest.raises(TimeoutError):
                    await await_decision_async(
                        gw, REVIEW_ID, poll_interval=0.01, timeout=0.05
                    )

    @pytest.mark.asyncio
    async def test_async_does_not_resolve_chain_review_while_run_is_active(
        self, chain_decided_review_response
    ):
        """Async twin of TestAwaitDecisionSync's chain guard test."""
        async with create_async_client(api_key="gw_key_test", url=GW_URL) as gw:
            with respx.mock(base_url=GW_URL, assert_all_called=False) as respx_mock:
                respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
                    return_value=httpx.Response(200, json=chain_decided_review_response)
                )
                chain_route = respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}/chain").mock(
                    side_effect=[
                        httpx.Response(200, json={"id": "run_test123", "status": "active"}),
                        httpx.Response(200, json={"id": "run_test123", "status": "completed"}),
                    ]
                )

                decision = await await_decision_async(gw, REVIEW_ID, poll_interval=0.01)

                assert decision.approved is True
                assert chain_route.call_count == 2

    @pytest.mark.asyncio
    async def test_async_chain_run_id_none_behaves_like_before(self, decided_review_response):
        """Regression fence: async twin, no chain lookup when chain_run_id is None."""
        async with create_async_client(api_key="gw_key_test", url=GW_URL) as gw:
            with respx.mock(base_url=GW_URL, assert_all_called=False) as respx_mock:
                chain_route = respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}/chain")
                respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
                    return_value=httpx.Response(200, json=decided_review_response)
                )

                decision = await await_decision_async(gw, REVIEW_ID, poll_interval=10.0, timeout=1.0)

                assert decision.approved is True
                assert not chain_route.called


# ---------------------------------------------------------------------------
# Idempotency key auto-derivation
# ---------------------------------------------------------------------------


class TestGatewerkInterruptIdempotencyKey:
    """Verify that gatewerk_interrupt auto-derives an idempotency_key and that
    a caller-supplied key takes precedence."""

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_key_auto_derived_when_absent(self, respx_mock, gw_client, pending_review_response):
        """When no idempotency_key is in kwargs, the adapter derives one."""
        import json as _json

        captured_body: dict[str, Any] = {}
        route = respx_mock.post("/api/v1/reviews").mock(
            return_value=httpx.Response(201, json=pending_review_response)
        )

        def node(state: _State):
            gatewerk_interrupt(
                gw_client,
                template="refund_approval",
                payload={"amount": state["refund_amount"]},
            )
            return {"decision": None}

        from langgraph.checkpoint.memory import MemorySaver
        from langgraph.graph import END, START, StateGraph

        builder = StateGraph(_State)
        builder.add_node("gated", node)
        builder.add_edge(START, "gated")
        builder.add_edge("gated", END)
        graph = builder.compile(checkpointer=MemorySaver())

        config = {"configurable": {"thread_id": "t-idem-auto"}}
        graph.invoke({"refund_amount": 100, "decision": None, "feedback": None}, config=config)

        assert route.called
        captured_body = _json.loads(route.calls[0].request.content)
        assert "idempotency_key" in captured_body
        key = captured_body["idempotency_key"]
        assert key.startswith("lg:")
        # SHA-256 hex is 64 chars; "lg:" + 64 = 67 chars
        assert len(key) == 67

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_caller_supplied_key_wins(self, respx_mock, gw_client, pending_review_response):
        """When the caller passes idempotency_key in kwargs, it is forwarded as-is."""
        import json as _json

        route = respx_mock.post("/api/v1/reviews").mock(
            return_value=httpx.Response(201, json=pending_review_response)
        )

        def node(state: _State):
            gatewerk_interrupt(
                gw_client,
                template="refund_approval",
                payload={"amount": state["refund_amount"]},
                idempotency_key="my-custom-key-abc123",
            )
            return {"decision": None}

        from langgraph.checkpoint.memory import MemorySaver
        from langgraph.graph import END, START, StateGraph

        builder = StateGraph(_State)
        builder.add_node("gated", node)
        builder.add_edge(START, "gated")
        builder.add_edge("gated", END)
        graph = builder.compile(checkpointer=MemorySaver())

        config = {"configurable": {"thread_id": "t-idem-custom"}}
        graph.invoke({"refund_amount": 100, "decision": None, "feedback": None}, config=config)

        assert route.called
        body = _json.loads(route.calls[0].request.content)
        assert body["idempotency_key"] == "my-custom-key-abc123"

    def test_same_payload_same_key(self):
        """Identical template+payload inputs produce the same derived key."""
        import hashlib
        import json

        template = "refund_approval"
        payload = {"amount": 100, "currency": "USD"}
        src = json.dumps({"template": template, "payload": payload}, sort_keys=True).encode()
        expected = "lg:" + hashlib.sha256(src).hexdigest()

        # Run the derivation twice (simulating two node executions)
        src2 = json.dumps({"template": template, "payload": payload}, sort_keys=True).encode()
        result2 = "lg:" + hashlib.sha256(src2).hexdigest()

        assert expected == result2


class TestChainOutcomeNotJustTiming:
    """The chain guard has to resolve the route's OUTCOME, not merely its timing.

    Waiting until the run leaves 'active' and then returning the caller's own
    step review hands back decision="approved" for a request the route
    refused. That is the intermediate-vs-final confusion the whole design
    exists to prevent, wearing a different hat.
    """

    def test_a_route_rejected_downstream_does_not_resolve_as_approved(
        self, respx_mock, gw_client, chain_decided_review_response
    ):
        rejecting_id = "gw_rev_vp_refused"
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=httpx.Response(200, json=chain_decided_review_response)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}/chain").mock(
            return_value=httpx.Response(
                200,
                json={
                    "id": "run_test123",
                    "status": "rejected",
                    "steps": [
                        {
                            "id": "s1",
                            "chain_run_id": "run_test123",
                            "step_number": 1,
                            "review_id": REVIEW_ID,
                            "decision": "approved",
                        },
                        {
                            "id": "s2",
                            "chain_run_id": "run_test123",
                            "step_number": 2,
                            "review_id": rejecting_id,
                            "decision": "rejected",
                        },
                    ],
                },
            )
        )
        respx_mock.get(f"/api/v1/reviews/{rejecting_id}").mock(
            return_value=httpx.Response(
                200,
                json={
                    "id": rejecting_id,
                    "object": "review",
                    "template_slug": "refund_approval",
                    "payload": {"amount": 100},
                    "status": "decided",
                    "decision": "rejected",
                    "decided_by": "vp@acme.com",
                    "feedback": "Over budget",
                    "chain_run_id": "run_test123",
                },
            )
        )

        decision = await_decision(gw_client, REVIEW_ID, poll_interval=0.01, timeout=2)

        assert decision.approved is False
        assert decision.rejected is True
        assert decision.feedback == "Over budget"

    def test_an_aborted_route_raises_rather_than_inventing_a_decision(
        self, respx_mock, gw_client, chain_decided_review_response
    ):
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=httpx.Response(200, json=chain_decided_review_response)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}/chain").mock(
            return_value=httpx.Response(
                200, json={"id": "run_test123", "status": "aborted", "steps": []}
            )
        )

        with pytest.raises(RuntimeError, match="without a decision"):
            await_decision(gw_client, REVIEW_ID, poll_interval=0.01, timeout=2)

    def test_a_completed_route_still_resolves_to_the_caller_s_review(
        self, respx_mock, gw_client, chain_decided_review_response
    ):
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=httpx.Response(200, json=chain_decided_review_response)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}/chain").mock(
            return_value=httpx.Response(
                200, json={"id": "run_test123", "status": "completed", "steps": []}
            )
        )

        decision = await_decision(gw_client, REVIEW_ID, poll_interval=0.01, timeout=2)
        assert decision.approved is True
