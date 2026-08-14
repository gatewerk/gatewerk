"""LangGraph adapter implementation.

Provides primitives that pause a LangGraph agent for human review via the
Gatewerk dashboard:

* :func:`gatewerk_interrupt` / :func:`gatewerk_interrupt_async` — create a
  Gatewerk review and call LangGraph's ``interrupt()`` so the graph pauses.
  When the graph is resumed via ``Command(resume=...)``, the resume value is
  unpacked into a :class:`Decision`.
* :func:`await_decision` / :func:`await_decision_async` — polling helper for
  callers who want to block on a review without using LangGraph's
  interrupt-resume cycle. Both live in :mod:`gatewerk.integrations.common`
  and are re-exported here for backward compatibility.

LangGraph is an optional dependency. Importing this module does not import
LangGraph; the import only happens the first time you call one of the
``gatewerk_interrupt`` primitives. ``await_decision`` does not need
LangGraph at all.

Idempotency / duplicate-review fix
-----------------------------------
LangGraph's ``interrupt()`` re-executes the entire node when the graph is
resumed. Without idempotency, ``client.reviews.create(...)`` is called a
second time on resume, creating a duplicate review record. Both primitives
now auto-derive an ``idempotency_key`` from the template + payload so the
second call returns the existing review instead of inserting a new row.
Callers may supply their own key via ``idempotency_key=`` in ``**kwargs``;
the auto-derived key is only used when none is supplied.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping, Optional, TYPE_CHECKING

from ..common import (
    Decision,
    await_decision,
    await_decision_async,
    await_decision_sse,
    await_decision_sse_async,
    decision_from_review as _decision_from_review,
)

if TYPE_CHECKING:
    from ...async_client import AsyncGatewerkClient
    from ...client import GatewerkClient


__all__ = [
    "Decision",
    "await_decision",
    "await_decision_async",
    "await_decision_sse",
    "await_decision_sse_async",
    "gatewerk_interrupt",
    "gatewerk_interrupt_async",
]


_LANGGRAPH_IMPORT_ERROR = (
    "LangGraph is not installed. Install it with "
    "`pip install gatewerk[langgraph]` to use this integration."
)


# ---------------------------------------------------------------------------
# LangGraph-specific helpers
# ---------------------------------------------------------------------------


def _import_langgraph_interrupt():
    """Lazy-import ``langgraph.types.interrupt``.

    Raises:
        ImportError: With a message pointing at ``pip install gatewerk[langgraph]``
            when LangGraph is not installed.
    """
    try:
        from langgraph.types import interrupt  # type: ignore[import-not-found]
    except ImportError as exc:
        raise ImportError(_LANGGRAPH_IMPORT_ERROR) from exc
    return interrupt


def _build_interrupt_payload(
    review_id: str,
    template: str,
    payload: Mapping[str, Any],
) -> dict:
    """Shape the value surfaced via ``interrupt()`` to clients/UIs."""
    return {
        "review_id": review_id,
        "template": template,
        "payload": dict(payload),
    }


def _decision_from_resume(
    resume_value: Any,
    fallback_review_id: str,
) -> Optional[Decision]:
    """Build a :class:`Decision` from a ``Command(resume=...)`` value.

    Returns ``None`` if the resume value isn't enough to reconstruct a
    decision — caller should fetch the review from the API instead.
    """
    if isinstance(resume_value, Decision):
        return resume_value

    if isinstance(resume_value, Mapping):
        # Accept partial dicts as long as they carry a decision marker.
        if "decision" in resume_value or "status" in resume_value:
            return Decision(
                review_id=str(resume_value.get("review_id") or fallback_review_id),
                status=str(resume_value.get("status") or "decided"),
                decision=resume_value.get("decision"),
                approved_value=resume_value.get("approved_value"),
                edited_payload=resume_value.get("edited_payload"),
                feedback=resume_value.get("feedback"),
                reviewer=resume_value.get("reviewer"),
                decided_at=resume_value.get("decided_at"),
            )

    return None


# ---------------------------------------------------------------------------
# Sync primitive
# ---------------------------------------------------------------------------


def gatewerk_interrupt(
    client: "GatewerkClient",
    *,
    template: str,
    payload: dict,
    **kwargs: Any,
) -> Decision:
    """Pause LangGraph execution for human review via Gatewerk.

    Creates a Gatewerk review and calls LangGraph's ``interrupt()`` primitive.
    When the human approves/rejects via the Gatewerk dashboard, LangGraph
    resumes the graph with the decision available to the caller.

    Args:
        client: A :class:`gatewerk.GatewerkClient` instance (sync).
        template: The Gatewerk template slug for this review.
        payload: The data the human will review.
        **kwargs: Additional fields forwarded to ``client.reviews.create()`` —
            ``callback_url``, ``priority``, ``assignee``, ``metadata``, etc.

    Returns:
        :class:`Decision`: The reviewer's decision once LangGraph resumes.

    Raises:
        ImportError: If LangGraph is not installed.

    Example::

        from langgraph.graph import StateGraph, START, END
        from langgraph.checkpoint.memory import MemorySaver
        from gatewerk import create_client
        from gatewerk.integrations.langgraph import gatewerk_interrupt

        gw = create_client(api_key=os.environ["GATEWERK_API_KEY"])

        def gated_node(state):
            decision = gatewerk_interrupt(
                gw,
                template="refund_approval",
                payload={"amount": state["refund_amount"]},
            )
            if decision.approved:
                return {
                    "approved": True,
                    "value": decision.approved_value or state["refund_amount"],
                }
            return {"approved": False, "feedback": decision.feedback}
    """
    interrupt = _import_langgraph_interrupt()

    # Auto-derive an idempotency key from (template, payload) so that
    # LangGraph node re-executions on resume return the existing review
    # instead of inserting a duplicate. The caller may supply their own key
    # via kwargs; we only set the auto-derived key when none is present.
    # Caveat: payload must be JSON-serializable and replay-stable (no per-run
    # timestamps/UUIDs), and ONLY template+payload are hashed — two distinct
    # interrupts with identical template+payload but differing
    # priority/assignee/etc. collide to one key; pass an explicit
    # idempotency_key to disambiguate those.
    if "idempotency_key" not in kwargs:
        _key_src = json.dumps({"template": template, "payload": payload}, sort_keys=True).encode()
        kwargs = {**kwargs, "idempotency_key": "lg:" + hashlib.sha256(_key_src).hexdigest()}

    review = client.reviews.create(template, payload, **kwargs)
    interrupt_payload = _build_interrupt_payload(review.id, template, payload)

    # First call: raises GraphInterrupt (graph pauses).
    # On resume: returns the value passed to Command(resume=...).
    resume_value = interrupt(interrupt_payload)

    decision = _decision_from_resume(resume_value, fallback_review_id=review.id)
    if decision is not None:
        return decision

    # Resume value didn't carry a decision — fall back to fetching the review.
    fetched = client.reviews.get(review.id)
    return _decision_from_review(fetched)


# ---------------------------------------------------------------------------
# Async primitive
# ---------------------------------------------------------------------------


async def gatewerk_interrupt_async(
    client: "AsyncGatewerkClient",
    *,
    template: str,
    payload: dict,
    **kwargs: Any,
) -> Decision:
    """Async variant of :func:`gatewerk_interrupt`.

    Same semantics as the sync version, but uses
    :class:`gatewerk.AsyncGatewerkClient` for the review create call.

    The underlying LangGraph ``interrupt()`` call is itself synchronous —
    it raises ``GraphInterrupt`` on first invocation and returns the resume
    value on the next pass through the node. That works inside an async
    node because LangGraph drives the resume from the runtime, not from
    awaiting the function.
    """
    interrupt = _import_langgraph_interrupt()

    # Auto-derive idempotency key — same logic + caveats as the sync variant
    # above (JSON-serializable, replay-stable payload; only template+payload
    # are hashed). Pass an explicit idempotency_key to disambiguate collisions.
    if "idempotency_key" not in kwargs:
        _key_src = json.dumps({"template": template, "payload": payload}, sort_keys=True).encode()
        kwargs = {**kwargs, "idempotency_key": "lg:" + hashlib.sha256(_key_src).hexdigest()}

    review = await client.reviews.create(template, payload, **kwargs)
    interrupt_payload = _build_interrupt_payload(review.id, template, payload)

    resume_value = interrupt(interrupt_payload)

    decision = _decision_from_resume(resume_value, fallback_review_id=review.id)
    if decision is not None:
        return decision

    fetched = await client.reviews.get(review.id)
    return _decision_from_review(fetched)
