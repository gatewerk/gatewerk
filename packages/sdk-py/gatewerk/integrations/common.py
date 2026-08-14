"""Framework-agnostic primitives shared by Gatewerk integration adapters.

The :class:`Decision` dataclass and the polling helpers
(:func:`await_decision`, :func:`await_decision_async`) sit here because they
do not depend on any specific agent framework — every adapter (LangGraph,
CrewAI, future ones) needs the same shape of decision and the same
poll-until-terminal loop.

Adapter modules re-export the primitives they expose to end users so
imports like ``from gatewerk.integrations.langgraph import Decision`` and
``from gatewerk.integrations.crewai import await_decision`` keep working
even though the implementation lives here.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Optional, TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from ..async_client import AsyncGatewerkClient
    from ..client import GatewerkClient
    from ..types import Review


# ---------------------------------------------------------------------------
# Decision dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Decision:
    """The outcome of a Gatewerk review, surfaced back to the agent.

    All fields default to ``None`` (except ``review_id`` and ``status``) so
    the dataclass remains forward-compatible: future fields can be appended
    without breaking callers that build :class:`Decision` instances by
    keyword.

    Always construct with keyword arguments — the positional ordering of
    optional fields is not guaranteed across versions.

    Attributes:
        review_id: Gatewerk review identifier (e.g. ``"gw_rev_..."``).
        status: Review status string from the API. Typical values:
            ``"pending"``, ``"decided"``, ``"rejected"``, ``"expired"``,
            ``"changes_requested"``, ``"cancelled"``.
        decision: Reviewer's decision when ``status`` is terminal.
            One of ``"approved"``, ``"rejected"``, ``"changes_requested"``,
            or ``None`` if the review is still pending.
        approved_value: The payload the reviewer approved. Equal to
            ``edited_payload`` when the reviewer edited fields, otherwise
            equal to the original payload submitted to ``reviews.create``.
        edited_payload: The payload as edited by the reviewer, if any.
        feedback: Free-text feedback from the reviewer.
        reviewer: Identifier of the reviewer (email, user id, etc.).
        decided_at: ISO-8601 timestamp of the decision.
    """

    review_id: str
    status: str
    decision: Optional[str] = None
    approved_value: Optional[dict] = None
    edited_payload: Optional[dict] = None
    feedback: Optional[str] = None
    reviewer: Optional[str] = None
    decided_at: Optional[str] = None

    @property
    def approved(self) -> bool:
        """True if the reviewer approved the action."""
        return self.decision == "approved"

    @property
    def rejected(self) -> bool:
        """True if the reviewer rejected the action."""
        return self.decision == "rejected"

    @property
    def has_changes(self) -> bool:
        """True if the reviewer edited the payload or requested changes."""
        return self.decision == "changes_requested" or self.edited_payload is not None


# ---------------------------------------------------------------------------
# Framework-agnostic helpers
# ---------------------------------------------------------------------------


def decision_from_review(review: "Review") -> Decision:
    """Convert a :class:`gatewerk.types.Review` into a :class:`Decision`."""
    edited = getattr(review, "edited_payload", None)
    approved_value = edited if edited is not None else dict(review.payload or {})
    return Decision(
        review_id=review.id,
        status=review.status,
        decision=review.decision,
        approved_value=approved_value,
        edited_payload=edited,
        feedback=getattr(review, "feedback", None),
        reviewer=getattr(review, "decided_by", None),
        decided_at=getattr(review, "decided_at", None),
    )


# Canonical non-terminal review statuses. Single source of truth for the
# Python SDK's poll-until-terminal logic (mirrors NON_TERMINAL_REVIEW_STATUSES
# in packages/shared/src/enums.ts). A review in any of these is still awaiting
# reviewer/agent action, so the polling loop must KEEP waiting. Everything else
# (decided, expired, archived) is terminal.
# Mirrors NON_TERMINAL_REVIEW_STATUSES in packages/shared/src/enums.ts.
_NON_TERMINAL_STATUSES = frozenset({"pending", "awaiting_iteration", "awaiting_external", "monitoring"})


def is_terminal(status: str) -> bool:
    """True when a review is fully resolved (no further reviewer/agent action).

    The non-terminal states are ``pending``, ``awaiting_iteration`` (the agent
    is expected to apply edits and re-submit, which re-enters the flow) and
    ``awaiting_external`` (waiting on an external-token reviewer). Treating any
    of these as terminal short-circuits the polling loop and returns a
    half-formed :class:`Decision`, stalling agents that wait for a final
    approve/reject. Terminal states are ``decided``, ``expired``, ``archived``.

    See ``packages/shared/src/enums.ts`` (NON_TERMINAL_REVIEW_STATUSES /
    TERMINAL_REVIEW_STATUSES) for the canonical cross-language definition.
    """
    return status not in _NON_TERMINAL_STATUSES


# ---------------------------------------------------------------------------
# Chain guard
# ---------------------------------------------------------------------------
#
# A chain (route of approvers) attaches every step to its own review row. A
# chain review reaching a terminal status only means ONE step's reviewer
# decided — later approvers may not have looked yet, so the underlying
# request is not authorized until the chain run itself resolves. Gate on the
# fetched review's `chain_run_id`, never on an SSE frame's payload: the
# server's resolveChainEventFields can leave a frame's chain fields absent
# even for a chain review, so the frame alone is not trustworthy.


def _resolve_chain_outcome(
    client: "GatewerkClient", review: "Review"
) -> Optional["Review"]:
    """The review a chain-attached wait should resolve to, or None to keep waiting.

    A plain review (``chain_run_id`` unset) resolves to itself. A chain review
    reaching a terminal status only means ONE step's reviewer decided, so:

    * run still active -> ``None``, keep waiting.
    * run completed    -> this review; the route authorized.
    * run rejected     -> the review of the step that rejected. Returning THIS
      review would hand back ``decision="approved"`` for a request the route
      refused, which is the intermediate-vs-final confusion wearing a hat.
    * run aborted      -> raise. An operator force-stopped the route; there is
      no decision to report, and inventing one is worse than failing.

    Caveat, documented rather than handled: under the ``continue`` rejection
    policy (held back at launch) a route can complete with a rejected step, and
    this returns that step's own review.
    """
    chain_run_id = getattr(review, "chain_run_id", None)
    if chain_run_id is None:
        return review

    chain = client.chains.get_for_review(review.id)
    if chain.status == "active":
        return None
    if chain.status == "completed":
        return review
    if chain.status == "rejected":
        refusing = _refusing_step_review_id(chain, review.id)
        return client.reviews.get(refusing) if refusing else review

    raise RuntimeError(
        f"Chain {chain.id} ended {chain.status!r} without a decision; "
        f"review {review.id} was not authorized"
    )


async def _resolve_chain_outcome_async(
    client: "AsyncGatewerkClient", review: "Review"
) -> Optional["Review"]:
    """Async variant of :func:`_resolve_chain_outcome`."""
    chain_run_id = getattr(review, "chain_run_id", None)
    if chain_run_id is None:
        return review

    chain = await client.chains.get_for_review(review.id)
    if chain.status == "active":
        return None
    if chain.status == "completed":
        return review
    if chain.status == "rejected":
        refusing = _refusing_step_review_id(chain, review.id)
        return await client.reviews.get(refusing) if refusing else review

    raise RuntimeError(
        f"Chain {chain.id} ended {chain.status!r} without a decision; "
        f"review {review.id} was not authorized"
    )


def _refusing_step_review_id(chain, own_review_id: str) -> Optional[str]:
    """The review id of the step whose decision stopped the route, if another."""
    for step in getattr(chain, "steps", None) or []:
        decision = getattr(step, "decision", None)
        review_id = getattr(step, "review_id", None)
        if decision in ("rejected", "expired") and review_id and review_id != own_review_id:
            return review_id
    return None


# ---------------------------------------------------------------------------
# Polling primitives
# ---------------------------------------------------------------------------


def await_decision(
    client: "GatewerkClient",
    review_id: str,
    *,
    poll_interval: float = 2.0,
    timeout: Optional[float] = None,
) -> Decision:
    """Block until a Gatewerk review reaches a terminal status.

    Useful when you don't want to use a framework-specific suspend/resume
    cycle (LangGraph's ``interrupt``, CrewAI's tool round-trip, etc.) —
    create the review yourself via ``client.reviews.create(...)``, then pass
    the returned ``review.id`` here.

    Args:
        client: A :class:`gatewerk.GatewerkClient` instance.
        review_id: The Gatewerk review identifier to wait on.
        poll_interval: Seconds between polls (default 2.0).
        timeout: Max seconds to wait. ``None`` (default) waits forever.

    Returns:
        :class:`Decision`: The final decision.

    Raises:
        TimeoutError: If ``timeout`` is set and elapses before the review
            leaves the ``pending`` state.
    """
    deadline = None if timeout is None else time.monotonic() + timeout
    while True:
        review = client.reviews.get(review_id)
        # A chain review reaching a terminal status is only ONE step's
        # decision, not the request's outcome — see _resolve_chain_outcome.
        # None means the route is still running, so keep polling exactly like
        # a non-terminal review.
        if is_terminal(review.status):
            outcome = _resolve_chain_outcome(client, review)
            if outcome is not None:
                return decision_from_review(outcome)
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError(
                f"Review {review_id} did not reach a terminal status within {timeout}s"
            )
        time.sleep(poll_interval)


async def await_decision_async(
    client: "AsyncGatewerkClient",
    review_id: str,
    *,
    poll_interval: float = 2.0,
    timeout: Optional[float] = None,
) -> Decision:
    """Async variant of :func:`await_decision`."""
    deadline = None if timeout is None else time.monotonic() + timeout
    while True:
        review = await client.reviews.get(review_id)
        # See the sync variant's comment: a chain review's terminal status is
        # only ONE step's decision, not the request's outcome.
        if is_terminal(review.status):
            outcome = await _resolve_chain_outcome_async(client, review)
            if outcome is not None:
                return decision_from_review(outcome)
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError(
                f"Review {review_id} did not reach a terminal status within {timeout}s"
            )
        await asyncio.sleep(poll_interval)


# ---------------------------------------------------------------------------
# SSE primitives
# ---------------------------------------------------------------------------

_SSE_TERMINAL_TYPES = frozenset({"review.decided", "review.expired", "review.vetoed", "review.confirmed"})

# Fallback cadence for the chain guard in the SSE helpers below, which have
# no caller-supplied poll_interval in scope (only timeout). await_decision /
# await_decision_async don't need an equivalent constant — they reuse their
# own poll_interval parameter.
_CHAIN_POLL_INTERVAL_SECONDS = 1.0


def _consume_sse_line(line: str, data_parts: list[str]) -> Optional[dict]:
    """Process one SSE line, accumulating multi-line ``data:`` fields.

    Consecutive ``data:`` lines are buffered into *data_parts* (mutated in
    place). A blank line terminates the frame: the buffered parts are joined
    and JSON-parsed. Returns the parsed payload on frame completion, else
    ``None`` (incomplete frame, comment/heartbeat, or invalid JSON).
    """
    if line.startswith("data:"):
        data_parts.append(line[len("data:"):].strip())
        return None
    # Non-data line. Only a blank line (with buffered data) closes the frame;
    # comment/heartbeat lines (``:``) and other fields don't.
    if line.strip() != "" or not data_parts:
        return None
    raw = "".join(data_parts)
    data_parts.clear()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _is_terminal_sse_payload(payload: object, review_id: str) -> bool:
    return (
        isinstance(payload, dict)
        and payload.get("review_id") == review_id
        and payload.get("type") in _SSE_TERMINAL_TYPES
    )


def await_decision_sse(
    client: "GatewerkClient",
    review_id: str,
    *,
    timeout: Optional[float] = None,
) -> Decision:
    """Block until a Gatewerk review reaches a terminal status via SSE push.

    More efficient than :func:`await_decision` for low-latency workflows:
    instead of polling the REST API, this opens the ``/events/stream`` SSE
    endpoint and waits for a ``review.decided`` or ``review.expired`` frame
    targeted at *review_id*.  The final authoritative review object is fetched
    once after the terminal frame arrives.

    Args:
        client: A :class:`gatewerk.GatewerkClient` instance.
        review_id: The Gatewerk review identifier to wait on.
        timeout: Max seconds to wait. ``None`` (default) waits until the
            server closes the stream.

    Returns:
        :class:`Decision`: Built from the authoritative review fetched after
        the terminal SSE frame is received.

    Raises:
        TimeoutError: If ``timeout`` elapses before a terminal frame arrives.
        RuntimeError: If the stream closes before a terminal frame arrives.
        httpx.HTTPStatusError: On non-2xx ticket or stream responses.
    """
    # 1. Obtain a short-lived streaming ticket
    ticket_resp = client._http.post("/api/v1/events/ticket")
    ticket_resp.raise_for_status()
    ticket: str = ticket_resp.json()["ticket"]

    deadline = None if timeout is None else time.monotonic() + timeout
    found_terminal = False
    data_parts: list[str] = []

    # 2. Open SSE stream and scan for a terminal frame matching review_id.
    # Pass an explicit per-read timeout so the caller's `timeout` actually
    # bounds the wait — otherwise .stream() inherits the client's ~30s default
    # and raises httpx.ReadTimeout regardless of `timeout`. None preserves
    # "wait forever" semantics. We also re-raise any httpx timeout as the
    # documented TimeoutError.
    stream_timeout = httpx.Timeout(None) if timeout is None else httpx.Timeout(timeout)
    try:
        with client._http.stream(
            "GET",
            "/api/v1/events/stream",
            params={"ticket": ticket},
            timeout=stream_timeout,
        ) as r:
            r.raise_for_status()
            for line in r.iter_lines():
                if deadline is not None and time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"Review {review_id} did not reach a terminal status within {timeout}s"
                    )
                payload = _consume_sse_line(line, data_parts)
                if payload is None:
                    continue
                if _is_terminal_sse_payload(payload, review_id):
                    found_terminal = True
                    break
    except httpx.TimeoutException as exc:
        raise TimeoutError(
            f"Review {review_id} did not reach a terminal status within {timeout}s"
        ) from exc

    if not found_terminal:
        raise RuntimeError(
            f"SSE stream closed before review {review_id} reached a terminal state"
        )

    # 3. Fetch authoritative review state and return Decision
    review = client.reviews.get(review_id)

    # Chain guard: the terminal frame only proves THIS review decided. If it
    # belongs to a chain, no further SSE frame will ever target this
    # review_id again (it has already reached a terminal status), so poll
    # the chain endpoint instead of re-opening the stream.
    outcome = _resolve_chain_outcome(client, review)
    while outcome is None:
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError(
                f"Review {review_id} did not reach a terminal status within {timeout}s"
            )
        time.sleep(_CHAIN_POLL_INTERVAL_SECONDS)
        outcome = _resolve_chain_outcome(client, review)

    return decision_from_review(outcome)


async def await_decision_sse_async(
    client: "AsyncGatewerkClient",
    review_id: str,
    *,
    timeout: Optional[float] = None,
) -> Decision:
    """Async variant of :func:`await_decision_sse`."""
    # 1. Obtain a short-lived streaming ticket
    ticket_resp = await client._http.post("/api/v1/events/ticket")
    ticket_resp.raise_for_status()
    ticket: str = ticket_resp.json()["ticket"]

    deadline = None if timeout is None else time.monotonic() + timeout
    found_terminal = False
    data_parts: list[str] = []

    # 2. Open SSE stream and scan for a terminal frame matching review_id.
    # Explicit per-read timeout bounds the wait (see sync variant); httpx
    # timeouts are re-raised as the documented TimeoutError.
    stream_timeout = httpx.Timeout(None) if timeout is None else httpx.Timeout(timeout)
    try:
        async with client._http.stream(
            "GET",
            "/api/v1/events/stream",
            params={"ticket": ticket},
            timeout=stream_timeout,
        ) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if deadline is not None and time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"Review {review_id} did not reach a terminal status within {timeout}s"
                    )
                payload = _consume_sse_line(line, data_parts)
                if payload is None:
                    continue
                if _is_terminal_sse_payload(payload, review_id):
                    found_terminal = True
                    break
    except httpx.TimeoutException as exc:
        raise TimeoutError(
            f"Review {review_id} did not reach a terminal status within {timeout}s"
        ) from exc

    if not found_terminal:
        raise RuntimeError(
            f"SSE stream closed before review {review_id} reached a terminal state"
        )

    # 3. Fetch authoritative review state and return Decision
    review = await client.reviews.get(review_id)

    # Chain guard: see the sync variant's comment.
    outcome = await _resolve_chain_outcome_async(client, review)
    while outcome is None:
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError(
                f"Review {review_id} did not reach a terminal status within {timeout}s"
            )
        await asyncio.sleep(_CHAIN_POLL_INTERVAL_SECONDS)
        outcome = await _resolve_chain_outcome_async(client, review)

    return decision_from_review(outcome)
