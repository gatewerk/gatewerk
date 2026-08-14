"""CrewAI integration for Gatewerk.

Install with ``pip install gatewerk[crewai]``.

Public API::

    from gatewerk.integrations.crewai import (
        GatewerkApprovalTool,
        await_decision,
        await_decision_async,
        Decision,
    )

The most common pattern is to construct a tool once and pass it to your
agent::

    gw = create_client(api_key="gw_key_...")
    approval_tool = GatewerkApprovalTool(gw, template="refund_approval")
    Agent(role="...", goal="...", tools=[approval_tool])
"""

from ..common import Decision, await_decision, await_decision_async
from ._tool import GatewerkApprovalTool, make_step_callback

__all__ = [
    "Decision",
    "GatewerkApprovalTool",
    "await_decision",
    "await_decision_async",
    "make_step_callback",
]
