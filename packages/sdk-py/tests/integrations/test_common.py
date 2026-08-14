"""Tests for the framework-agnostic primitives in integrations.common.

Notably ``is_terminal`` — a regression test backstop for the change in
this PR that excludes ``changes_requested`` from the terminal set, so the
polling helpers don't return a half-formed Decision while the agent is
expected to apply edits and retry.
"""

from __future__ import annotations

import pytest

from gatewerk.integrations.common import Decision, decision_from_review, is_terminal, _SSE_TERMINAL_TYPES
from gatewerk.types import Review


# ---------------------------------------------------------------------------
# is_terminal
# ---------------------------------------------------------------------------


class TestIsTerminal:
    @pytest.mark.parametrize(
        "status", ["pending", "awaiting_iteration", "awaiting_external"]
    )
    def test_non_terminal_states(self, status):
        """The three non-terminal statuses keep poll loops running.

        ``awaiting_iteration`` (agent expected to apply edits and re-submit)
        and ``awaiting_external`` (waiting on an external-token reviewer) are
        NOT done. Treating either as terminal would make await_decision return
        early with a half-formed ``Decision`` whose lifecycle hasn't resolved.
        Mirrors NON_TERMINAL_REVIEW_STATUSES in packages/shared/src/enums.ts.
        """
        assert is_terminal(status) is False

    @pytest.mark.parametrize(
        "status",
        ["decided", "expired", "archived", "rejected", "approved"],
    )
    def test_terminal_states(self, status):
        assert is_terminal(status) is True

    def test_unknown_status_treated_as_terminal(self):
        """Forward-compat: any unknown future status not in the
        non-terminal set is treated as terminal so polling doesn't hang."""
        assert is_terminal("some_future_status") is True

    def test_monitoring_status_is_non_terminal(self):
        """'monitoring' is the oversight-axis non-terminal status — the review
        continues while a human watches live; polling must not stop."""
        assert is_terminal("monitoring") is False
        assert is_terminal("decided") is True


# ---------------------------------------------------------------------------
# _SSE_TERMINAL_TYPES
# ---------------------------------------------------------------------------


class TestSseTerminalTypes:
    def test_monitoring_events_are_sse_terminal(self):
        """review.vetoed / review.confirmed are the SSE terminal events emitted
        when a monitoring review is resolved by a human via the dashboard.
        Without them, waitForDecisionSSE hangs until wall-clock timeout."""
        assert "review.vetoed" in _SSE_TERMINAL_TYPES
        assert "review.confirmed" in _SSE_TERMINAL_TYPES


# ---------------------------------------------------------------------------
# decision_from_review
# ---------------------------------------------------------------------------


class TestDecisionFromReview:
    def test_approved_decision_has_payload_as_approved_value(self):
        review = Review(
            id="gw_rev_001",
            status="decided",
            decision="approved",
            payload={"amount": 100},
        )
        d = decision_from_review(review)
        assert isinstance(d, Decision)
        assert d.review_id == "gw_rev_001"
        assert d.decision == "approved"
        assert d.approved_value == {"amount": 100}
        assert d.edited_payload is None
        assert d.approved is True
        assert d.rejected is False

    def test_edited_payload_takes_precedence_over_payload(self):
        review = Review(
            id="gw_rev_002",
            status="decided",
            decision="approved",
            payload={"amount": 100},
            edited_payload={"amount": 90},
        )
        d = decision_from_review(review)
        assert d.approved_value == {"amount": 90}
        assert d.edited_payload == {"amount": 90}
        assert d.has_changes is True

    def test_changes_requested_marks_has_changes(self):
        review = Review(
            id="gw_rev_003",
            status="changes_requested",
            decision="changes_requested",
            payload={"amount": 100},
            feedback="Too high",
        )
        d = decision_from_review(review)
        assert d.decision == "changes_requested"
        assert d.has_changes is True
        assert d.feedback == "Too high"
