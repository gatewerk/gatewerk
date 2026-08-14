"""CrewAI adapter implementation.

Exposes :func:`GatewerkApprovalTool` — a factory that returns a CrewAI
``BaseTool`` instance bound to a :class:`gatewerk.GatewerkClient`. When an
agent invokes the tool, the call:

1. Creates a Gatewerk review via ``client.reviews.create()``.
2. Polls ``client.reviews.get()`` until the review reaches a terminal
   status (``decided``, ``rejected``, ``cancelled``, ``expired``, …).
3. Returns a short string the agent's LLM can reason about
   (``"APPROVED"``, ``"REJECTED"``, ``"CHANGES_REQUESTED: ..."``).

CrewAI is an optional dependency. Importing this module does not import
CrewAI; the import only happens the first time you call
:func:`GatewerkApprovalTool`.
"""

from __future__ import annotations

from typing import Any, Callable, Mapping, Optional, TYPE_CHECKING

from ..common import (
    Decision,
    await_decision,
    await_decision_async,
)

if TYPE_CHECKING:
    from ...client import GatewerkClient


__all__ = [
    "GatewerkApprovalTool",
    "await_decision",
    "await_decision_async",
    "Decision",
]


_CREWAI_IMPORT_ERROR = (
    "CrewAI is not installed. Install it with "
    "`pip install gatewerk[crewai]` to use this integration."
)


_DEFAULT_TOOL_NAME = "gatewerk_approval"
_DEFAULT_TOOL_DESCRIPTION = (
    "Submit a decision for human approval before proceeding. Use when an "
    "action is irreversible, sensitive, or low-confidence. Returns "
    "APPROVED, REJECTED, or CHANGES_REQUESTED."
)


def _import_crewai_basetool():
    """Lazy-import ``crewai.tools.BaseTool``.

    Raises:
        ImportError: With a message pointing at ``pip install gatewerk[crewai]``
            when CrewAI is not installed.
    """
    try:
        from crewai.tools import BaseTool  # type: ignore[import-not-found]
    except ImportError as exc:
        raise ImportError(_CREWAI_IMPORT_ERROR) from exc
    return BaseTool


def _format_decision(decision: Decision) -> str:
    """Render a :class:`Decision` as a short string for the agent's LLM.

    The output is intentionally compact and machine-stable: agents key off
    the leading verb (``APPROVED``/``REJECTED``/``CHANGES_REQUESTED``/
    ``CLOSED``) and may parse the trailing feedback as free text.
    """
    if decision.approved:
        head = "APPROVED"
    elif decision.rejected:
        head = "REJECTED"
    elif decision.decision == "changes_requested":
        head = "CHANGES_REQUESTED"
    else:
        head = f"CLOSED ({decision.status})"

    parts = [head]
    if decision.feedback:
        parts.append(f": {decision.feedback}")
    if decision.decision == "changes_requested" and decision.edited_payload is not None:
        parts.append(f" | edited_payload={decision.edited_payload}")
    return "".join(parts)


def _build_args_schema(default_payload_key: Optional[str]):
    """Build a Pydantic model that describes the tool's argument shape.

    When ``default_payload_key`` is set (the common case), the LLM sees a
    single named field of type ``dict`` — the agent populates it with the
    action's data. When ``default_payload_key`` is ``None``, the schema
    accepts arbitrary extra fields so the agent can pass top-level keys
    directly.
    """
    from pydantic import BaseModel, ConfigDict, Field, create_model

    if default_payload_key:
        return create_model(
            "GatewerkApprovalArgs",
            **{
                default_payload_key: (
                    dict,
                    Field(
                        default_factory=dict,
                        description=(
                            "Action data the human will review. Include all "
                            "fields a reviewer would need to make a decision."
                        ),
                    ),
                )
            },
        )

    class _OpenArgs(BaseModel):
        model_config = ConfigDict(extra="allow")

    _OpenArgs.__name__ = "GatewerkApprovalArgs"
    return _OpenArgs


def GatewerkApprovalTool(  # noqa: N802 — factory mirrors a class name on purpose.
    client: "GatewerkClient",
    *,
    template: str,
    default_payload_key: Optional[str] = "payload",
    await_timeout: Optional[float] = None,
    poll_interval: float = 2.0,
    name: Optional[str] = None,
    description: Optional[str] = None,
    review_kwargs: Optional[Mapping[str, Any]] = None,
):
    """Build a CrewAI ``BaseTool`` that pauses for Gatewerk human approval.

    Args:
        client: A sync :class:`gatewerk.GatewerkClient` instance. The tool
            uses the same client for both ``reviews.create`` and the polling
            loop, so retry/timeout settings flow through.
        template: The Gatewerk template slug for this review.
        default_payload_key: When set (default ``"payload"``), the tool
            extracts ``kwargs[default_payload_key]`` and submits it as the
            review payload. Set to ``None`` to instead pass all of the
            agent's tool arguments straight through as the payload.
        await_timeout: Max seconds to wait for the human decision before
            raising :class:`TimeoutError`. ``None`` (default) waits forever.
        poll_interval: Seconds between polls of ``reviews.get`` (default 2.0).
        name: Override the tool name surfaced to the LLM
            (default ``"gatewerk_approval"``).
        description: Override the tool description surfaced to the LLM.
        review_kwargs: Extra keyword args forwarded to
            ``client.reviews.create()`` on every invocation —
            ``priority``, ``assignee``, ``callback_url``, ``metadata``, etc.

    Returns:
        A CrewAI ``BaseTool`` instance. Pass it to ``Agent(tools=[...])``.

    Raises:
        ImportError: If CrewAI is not installed.

    Example::

        from crewai import Agent, Task, Crew
        from gatewerk import create_client
        from gatewerk.integrations.crewai import GatewerkApprovalTool

        gw = create_client(
            api_key=os.environ["GATEWERK_API_KEY"],
            url="https://api.gatewerk.com",
        )
        approval_tool = GatewerkApprovalTool(
            gw,
            template="refund_approval",
            review_kwargs={"priority": "high"},
        )

        refund_agent = Agent(
            role="Customer Support",
            goal="Process refund requests fairly",
            tools=[approval_tool],
        )

        task = Task(
            description="Customer requests a $500 refund. Decide whether to approve.",
            agent=refund_agent,
            expected_output="A clear decision with reasoning",
        )

        Crew(agents=[refund_agent], tasks=[task]).kickoff()
    """
    BaseTool = _import_crewai_basetool()

    tool_name = name or _DEFAULT_TOOL_NAME
    tool_description = description or _DEFAULT_TOOL_DESCRIPTION
    # Bind to a non-colliding name — `args_schema` is also the class-attr
    # name on BaseTool, and an annotated class assignment shadows the
    # enclosing-function lookup.
    schema_cls = _build_args_schema(default_payload_key)
    extra_kwargs: dict = dict(review_kwargs) if review_kwargs else {}

    # Capture the configuration in a closure so the dynamically-created
    # subclass doesn't have to fight Pydantic over storing arbitrary
    # objects (the GatewerkClient) on a model instance.
    def _resolve_payload(call_kwargs: Mapping[str, Any]) -> dict:
        if default_payload_key:
            value = call_kwargs.get(default_payload_key, {})
            if isinstance(value, Mapping):
                return dict(value)
            # The LLM sometimes serialises nested objects as strings;
            # wrap them so the review still records something useful.
            return {default_payload_key: value}
        return dict(call_kwargs)

    def _run_impl(**kwargs: Any) -> str:
        payload = _resolve_payload(kwargs)
        review = client.reviews.create(template, payload, **extra_kwargs)
        decision = await_decision(
            client,
            review.id,
            poll_interval=poll_interval,
            timeout=await_timeout,
        )
        return _format_decision(decision)

    class _GatewerkApprovalTool(BaseTool):
        name: str = tool_name
        description: str = tool_description
        args_schema: type = schema_cls

        def _run(self, **kwargs: Any) -> str:
            return _run_impl(**kwargs)

    return _GatewerkApprovalTool()


def make_step_callback(
    client: "GatewerkClient",
    *,
    template: str,
    get_payload: Callable[[Any], Optional[dict]],
    poll_interval: float = 2.0,
    timeout: Optional[float] = None,
):  # pragma: no cover — experimental, exercised via integration tests downstream.
    """Build a CrewAI ``step_callback`` that gates each step on Gatewerk.

    **Experimental.** CrewAI's ``step_callback`` signature varies between
    minor versions; the most reliable integration pattern is the
    :func:`GatewerkApprovalTool` (the agent decides when to ask). Use this
    callback only when you need an out-of-band gate that fires after every
    step regardless of the agent's plan.

    Args:
        client: A sync :class:`gatewerk.GatewerkClient` instance.
        template: The Gatewerk template slug to use for each review.
        get_payload: Called with the step output. Return a dict to gate that
            step (creates a review and blocks); return ``None`` to skip.
        poll_interval: Seconds between polls.
        timeout: Max seconds to wait per gated step.

    Returns:
        A callable suitable for ``Crew(step_callback=...)``.
    """

    def _callback(step_output: Any) -> None:
        payload = get_payload(step_output)
        if payload is None:
            return
        review = client.reviews.create(template, payload)
        decision = await_decision(
            client,
            review.id,
            poll_interval=poll_interval,
            timeout=timeout,
        )
        if decision.rejected:
            raise RuntimeError(
                f"Gatewerk reviewer rejected step {review.id}: "
                f"{decision.feedback or 'no feedback supplied'}"
            )

    return _callback
