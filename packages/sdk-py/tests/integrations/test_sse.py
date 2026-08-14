"""Tests for the SSE-based decision helpers.

Both sync (``await_decision_sse``) and async (``await_decision_sse_async``)
variants are covered.  All network calls are mocked with respx — no real
connections are opened, so every test completes in milliseconds.

Key SSE parsing rules verified here:
* ``review.decided`` for the target review_id → terminal (resolves)
* ``review.expired`` for the target review_id → terminal (resolves)
* ``review.decided`` for a DIFFERENT review_id → ignored
* ``review.retried`` for the target review_id → NOT terminal (kept waiting)
* Heartbeat / comment lines (``:``) → skipped
* Stream closes without terminal frame → RuntimeError
"""

from __future__ import annotations

import httpx
import pytest
import respx

from gatewerk import create_async_client, create_client
from gatewerk.integrations.common import (
    Decision,
    await_decision_sse,
    await_decision_sse_async,
)

GW_URL = "http://test:3100"
REVIEW_ID = "gw_rev_sse_001"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def gw_client():
    client = create_client(api_key="gw_key_test", url=GW_URL)
    yield client
    client.close()


def _ticket_response(ticket: str = "tk_test123") -> httpx.Response:
    return httpx.Response(200, json={"ticket": ticket, "expires_in": 60})


def _review_response(
    review_id: str = REVIEW_ID,
    status: str = "decided",
    decision: str = "approved",
    chain_run_id: str | None = None,
) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": review_id,
            "object": "review",
            "template_slug": "deploy",
            "payload": {"service": "api"},
            "status": status,
            "decision": decision,
            "chain_run_id": chain_run_id,
        },
    )


def _sse_body(*frames: str) -> str:
    """Build an SSE body string from a sequence of frames.

    Each frame should end with ``\\n\\n`` (SSE frame boundary).
    ``iter_lines()`` on the resulting httpx.Response will yield the
    individual lines including empty separator lines.
    """
    return "".join(frames)


# ---------------------------------------------------------------------------
# Sync: await_decision_sse
# ---------------------------------------------------------------------------


class TestAwaitDecisionSseSync:
    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_resolves_on_review_decided(self, respx_mock, gw_client):
        """Terminal ``review.decided`` frame → fetches review and returns Decision."""
        sse_body = _sse_body(
            f'data: {{"type":"open"}}\n\n',
            f'data: {{"type":"review.decided","review_id":"{REVIEW_ID}","decision":"approved"}}\n\n',
        )
        respx_mock.post("/api/v1/events/ticket").mock(return_value=_ticket_response())
        respx_mock.get("/api/v1/events/stream").mock(
            return_value=httpx.Response(200, text=sse_body)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=_review_response()
        )

        decision = await_decision_sse(gw_client, REVIEW_ID)

        assert isinstance(decision, Decision)
        assert decision.review_id == REVIEW_ID
        assert decision.approved is True

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_resolves_on_review_expired(self, respx_mock, gw_client):
        """``review.expired`` is also terminal and must resolve the helper."""
        sse_body = _sse_body(
            f'data: {{"type":"review.expired","review_id":"{REVIEW_ID}"}}\n\n',
        )
        respx_mock.post("/api/v1/events/ticket").mock(return_value=_ticket_response())
        respx_mock.get("/api/v1/events/stream").mock(
            return_value=httpx.Response(200, text=sse_body)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=_review_response(status="expired", decision="rejected")
        )

        decision = await_decision_sse(gw_client, REVIEW_ID)
        assert decision.status == "expired"

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_ignores_different_review_id_and_review_retried(self, respx_mock, gw_client):
        """Frames for other reviews or non-terminal types must not trigger early resolution."""
        sse_body = _sse_body(
            # decided for a DIFFERENT review — must be ignored
            'data: {"type":"review.decided","review_id":"rev_OTHER"}\n\n',
            # review.retried is NOT terminal — must be ignored even for our review
            f'data: {{"type":"review.retried","review_id":"{REVIEW_ID}"}}\n\n',
            # correct terminal frame for our review
            f'data: {{"type":"review.decided","review_id":"{REVIEW_ID}","decision":"approved"}}\n\n',
        )
        respx_mock.post("/api/v1/events/ticket").mock(return_value=_ticket_response())
        respx_mock.get("/api/v1/events/stream").mock(
            return_value=httpx.Response(200, text=sse_body)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=_review_response()
        )

        decision = await_decision_sse(gw_client, REVIEW_ID)
        # If retried or other-review frames were treated as terminal, we'd get the wrong review.
        assert decision.review_id == REVIEW_ID
        assert decision.approved is True

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_ignores_heartbeat_comment_lines(self, respx_mock, gw_client):
        """SSE heartbeat lines (``:``) must be skipped without error."""
        sse_body = (
            ":\n\n"  # heartbeat comment line
            f'data: {{"type":"review.decided","review_id":"{REVIEW_ID}"}}\n\n'
        )
        respx_mock.post("/api/v1/events/ticket").mock(return_value=_ticket_response())
        respx_mock.get("/api/v1/events/stream").mock(
            return_value=httpx.Response(200, text=sse_body)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=_review_response()
        )

        decision = await_decision_sse(gw_client, REVIEW_ID)
        assert decision.approved is True

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_raises_runtime_error_when_stream_closes_early(self, respx_mock, gw_client):
        """RuntimeError when stream ends without a terminal frame for the target review."""
        sse_body = 'data: {"type":"open"}\n\n'  # only the open frame — no terminal
        respx_mock.post("/api/v1/events/ticket").mock(return_value=_ticket_response())
        respx_mock.get("/api/v1/events/stream").mock(
            return_value=httpx.Response(200, text=sse_body)
        )

        with pytest.raises(RuntimeError, match=REVIEW_ID):
            await_decision_sse(gw_client, REVIEW_ID)

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_raises_timeout_error_when_stream_blocks(self, respx_mock, gw_client):
        """A blocked/silent stream that hits the httpx read timeout must surface
        as the documented ``TimeoutError`` (not a raw ``httpx.ReadTimeout``),
        and must honor the caller's ``timeout`` rather than the client default.

        ``httpx.ReadTimeout`` models exactly a stream that stays open without
        delivering a terminal frame until the deadline elapses. The test
        finishes in ms — no real stream is opened.
        """
        respx_mock.post("/api/v1/events/ticket").mock(return_value=_ticket_response())
        respx_mock.get("/api/v1/events/stream").mock(
            side_effect=httpx.ReadTimeout("read timed out")
        )

        with pytest.raises(TimeoutError, match=REVIEW_ID):
            await_decision_sse(gw_client, REVIEW_ID, timeout=0.05)

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_raises_timeout_error_when_deadline_crosses_between_frames(
        self, respx_mock, gw_client
    ):
        """Wall-clock deadline is checked between frames: a stream that keeps
        delivering non-terminal frames past ``timeout`` raises ``TimeoutError``."""
        sse_body = "".join(
            f'data: {{"type":"review.retried","review_id":"{REVIEW_ID}","n":{i}}}\n\n'
            for i in range(50)
        )
        respx_mock.post("/api/v1/events/ticket").mock(return_value=_ticket_response())
        respx_mock.get("/api/v1/events/stream").mock(
            return_value=httpx.Response(200, text=sse_body)
        )

        # Near-zero timeout: the deadline is already crossed by the time the
        # first non-terminal frame is processed, so the loop raises TimeoutError.
        with pytest.raises(TimeoutError, match=REVIEW_ID):
            await_decision_sse(gw_client, REVIEW_ID, timeout=1e-6)

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_ticket_url_includes_base_url_and_auth(self, respx_mock, gw_client):
        """Ticket POST must carry the Authorization header."""
        sse_body = f'data: {{"type":"review.decided","review_id":"{REVIEW_ID}"}}\n\n'
        ticket_route = respx_mock.post("/api/v1/events/ticket").mock(
            return_value=_ticket_response("tk_verify")
        )
        respx_mock.get("/api/v1/events/stream").mock(
            return_value=httpx.Response(200, text=sse_body)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=_review_response()
        )

        await_decision_sse(gw_client, REVIEW_ID)

        assert ticket_route.called
        auth = ticket_route.calls[0].request.headers.get("authorization", "")
        assert auth.startswith("Bearer ")

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_does_not_resolve_chain_review_while_run_is_active(self, respx_mock, gw_client):
        """A chain (route of approvers) review reaching a terminal SSE frame
        only proves ONE step's reviewer decided. Must NOT resolve while the
        chain run is 'active'; resolves once the run reaches a terminal
        status. Gated on the fetched review's chain_run_id, not the frame."""
        sse_body = f'data: {{"type":"review.decided","review_id":"{REVIEW_ID}","decision":"approved"}}\n\n'
        respx_mock.post("/api/v1/events/ticket").mock(return_value=_ticket_response())
        respx_mock.get("/api/v1/events/stream").mock(
            return_value=httpx.Response(200, text=sse_body)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=_review_response(chain_run_id="run_test123")
        )
        chain_route = respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}/chain").mock(
            side_effect=[
                httpx.Response(200, json={"id": "run_test123", "status": "active"}),
                httpx.Response(200, json={"id": "run_test123", "status": "completed"}),
            ]
        )

        decision = await_decision_sse(gw_client, REVIEW_ID)

        # If the chain guard were missing, this would resolve on the terminal
        # frame alone — with only ONE step's approval, not the whole route's.
        assert decision.approved is True
        assert chain_route.call_count == 2

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_chain_run_id_none_behaves_like_before(self, respx_mock, gw_client):
        """Regression fence: a review with chain_run_id None resolves exactly
        as before — no chain lookup at all."""
        sse_body = f'data: {{"type":"review.decided","review_id":"{REVIEW_ID}"}}\n\n'
        respx_mock.post("/api/v1/events/ticket").mock(return_value=_ticket_response())
        respx_mock.get("/api/v1/events/stream").mock(
            return_value=httpx.Response(200, text=sse_body)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=_review_response(chain_run_id=None)
        )
        chain_route = respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}/chain")

        decision = await_decision_sse(gw_client, REVIEW_ID)

        assert decision.approved is True
        assert not chain_route.called

    @respx.mock(base_url=GW_URL, assert_all_called=False)
    def test_stream_url_includes_ticket_param(self, respx_mock, gw_client):
        """The SSE GET must pass the ticket as a query parameter."""
        sse_body = f'data: {{"type":"review.decided","review_id":"{REVIEW_ID}"}}\n\n'
        respx_mock.post("/api/v1/events/ticket").mock(
            return_value=_ticket_response("tk_check_param")
        )
        stream_route = respx_mock.get("/api/v1/events/stream").mock(
            return_value=httpx.Response(200, text=sse_body)
        )
        respx_mock.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
            return_value=_review_response()
        )

        await_decision_sse(gw_client, REVIEW_ID)

        assert stream_route.called
        url = str(stream_route.calls[0].request.url)
        assert "ticket=tk_check_param" in url


# ---------------------------------------------------------------------------
# Async: await_decision_sse_async
# ---------------------------------------------------------------------------


class TestAwaitDecisionSseAsync:
    @pytest.mark.asyncio
    async def test_async_resolves_on_review_decided(self):
        sse_body = _sse_body(
            f'data: {{"type":"review.decided","review_id":"{REVIEW_ID}","decision":"approved"}}\n\n',
        )
        async with create_async_client(api_key="gw_key_test", url=GW_URL) as gw:
            with respx.mock(base_url=GW_URL, assert_all_called=False) as m:
                m.post("/api/v1/events/ticket").mock(return_value=_ticket_response())
                m.get("/api/v1/events/stream").mock(
                    return_value=httpx.Response(200, text=sse_body)
                )
                m.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
                    return_value=_review_response()
                )

                decision = await await_decision_sse_async(gw, REVIEW_ID)

        assert isinstance(decision, Decision)
        assert decision.approved is True

    @pytest.mark.asyncio
    async def test_async_ignores_non_terminal_and_other_review_frames(self):
        sse_body = _sse_body(
            # Other review decided — ignored
            'data: {"type":"review.decided","review_id":"rev_DIFFERENT"}\n\n',
            # review.retried for our review — NOT terminal
            f'data: {{"type":"review.retried","review_id":"{REVIEW_ID}"}}\n\n',
            # Correct terminal frame
            f'data: {{"type":"review.decided","review_id":"{REVIEW_ID}"}}\n\n',
        )
        async with create_async_client(api_key="gw_key_test", url=GW_URL) as gw:
            with respx.mock(base_url=GW_URL, assert_all_called=False) as m:
                m.post("/api/v1/events/ticket").mock(return_value=_ticket_response())
                m.get("/api/v1/events/stream").mock(
                    return_value=httpx.Response(200, text=sse_body)
                )
                m.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
                    return_value=_review_response()
                )

                decision = await await_decision_sse_async(gw, REVIEW_ID)

        assert decision.review_id == REVIEW_ID

    @pytest.mark.asyncio
    async def test_async_raises_when_stream_closes_early(self):
        sse_body = 'data: {"type":"open"}\n\n'
        async with create_async_client(api_key="gw_key_test", url=GW_URL) as gw:
            with respx.mock(base_url=GW_URL, assert_all_called=False) as m:
                m.post("/api/v1/events/ticket").mock(return_value=_ticket_response())
                m.get("/api/v1/events/stream").mock(
                    return_value=httpx.Response(200, text=sse_body)
                )

                with pytest.raises(RuntimeError, match=REVIEW_ID):
                    await await_decision_sse_async(gw, REVIEW_ID)

    @pytest.mark.asyncio
    async def test_async_raises_timeout_error_when_stream_blocks(self):
        """Async blocked stream → httpx.ReadTimeout re-raised as TimeoutError."""
        async with create_async_client(api_key="gw_key_test", url=GW_URL) as gw:
            with respx.mock(base_url=GW_URL, assert_all_called=False) as m:
                m.post("/api/v1/events/ticket").mock(return_value=_ticket_response())
                m.get("/api/v1/events/stream").mock(
                    side_effect=httpx.ReadTimeout("read timed out")
                )

                with pytest.raises(TimeoutError, match=REVIEW_ID):
                    await await_decision_sse_async(gw, REVIEW_ID, timeout=0.05)

    @pytest.mark.asyncio
    async def test_async_does_not_resolve_chain_review_while_run_is_active(self):
        """Async twin of the sync chain guard test above."""
        sse_body = f'data: {{"type":"review.decided","review_id":"{REVIEW_ID}","decision":"approved"}}\n\n'
        async with create_async_client(api_key="gw_key_test", url=GW_URL) as gw:
            with respx.mock(base_url=GW_URL, assert_all_called=False) as m:
                m.post("/api/v1/events/ticket").mock(return_value=_ticket_response())
                m.get("/api/v1/events/stream").mock(
                    return_value=httpx.Response(200, text=sse_body)
                )
                m.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
                    return_value=_review_response(chain_run_id="run_test123")
                )
                chain_route = m.get(f"/api/v1/reviews/{REVIEW_ID}/chain").mock(
                    side_effect=[
                        httpx.Response(200, json={"id": "run_test123", "status": "active"}),
                        httpx.Response(200, json={"id": "run_test123", "status": "completed"}),
                    ]
                )

                decision = await await_decision_sse_async(gw, REVIEW_ID)

        assert decision.approved is True
        assert chain_route.call_count == 2

    @pytest.mark.asyncio
    async def test_async_chain_run_id_none_behaves_like_before(self):
        """Regression fence: async twin, no chain lookup when chain_run_id is None."""
        sse_body = f'data: {{"type":"review.decided","review_id":"{REVIEW_ID}"}}\n\n'
        async with create_async_client(api_key="gw_key_test", url=GW_URL) as gw:
            with respx.mock(base_url=GW_URL, assert_all_called=False) as m:
                m.post("/api/v1/events/ticket").mock(return_value=_ticket_response())
                m.get("/api/v1/events/stream").mock(
                    return_value=httpx.Response(200, text=sse_body)
                )
                m.get(f"/api/v1/reviews/{REVIEW_ID}").mock(
                    return_value=_review_response(chain_run_id=None)
                )
                chain_route = m.get(f"/api/v1/reviews/{REVIEW_ID}/chain")

                decision = await await_decision_sse_async(gw, REVIEW_ID)

        assert decision.approved is True
        assert not chain_route.called
