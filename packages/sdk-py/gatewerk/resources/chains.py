"""Chains resource for the Gatewerk Python SDK.

Mirrors the chain-runs REST surface mounted by apps/api/src/routes/chains.ts:

    POST /api/v1/chain-runs           — create + start a chain run
    GET  /api/v1/chain-runs/:id       — chain run + steps
    GET  /api/v1/reviews/:id/chain    — chain context for a review

The wire shapes (ChainDefinition, ChainRunObject, ChainStepObject) live in
``gatewerk.types`` — they restate
``packages/shared/src/api/schemas/chains.ts`` Zod schemas as Pydantic
models with ``extra="allow"`` for forward-compat. The SDK can't import
``@gatewerk/shared`` at runtime, so any drift between this file and the
backend Zod schema is a typing-quality bug; the wire format is what the
backend Zod emits.
"""

from __future__ import annotations

from typing import Any, Optional, Union

from .._base import BaseResource
from ..types import ChainDefinition, ChainRunObject


class ChainsResource(BaseResource):

    def create(
        self,
        definition: Union[ChainDefinition, dict[str, Any]],
        initial_payload: dict[str, Any],
        *,
        callback_url: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> ChainRunObject:
        """Create + start a chain run.

        Args:
            definition: Chain definition (a :class:`ChainDefinition` or
                an equivalent dict). Defines the steps, mode, and rejection
                policy.
            initial_payload: Starting payload for the first step.
            callback_url: Optional webhook URL to call when chain status
                changes.
            metadata: Optional run-scoped metadata.

        Returns:
            :class:`ChainRunObject`: The created run with all materialized
            steps. ``step_1_review_id`` is populated for convenience.
        """
        body: dict[str, Any] = {
            "definition": (
                definition.model_dump(exclude_none=True)
                if isinstance(definition, ChainDefinition)
                else definition
            ),
            "initial_payload": initial_payload,
        }
        if callback_url is not None:
            body["callback_url"] = callback_url
        if metadata is not None:
            body["metadata"] = metadata

        data = self._request("POST", "/api/v1/chain-runs", json=body, timeout=timeout)
        return ChainRunObject.model_validate(data)

    def get(self, run_id: str, *, timeout: Optional[float] = None) -> ChainRunObject:
        """Fetch the full chain run + its steps."""
        data = self._request("GET", f"/api/v1/chain-runs/{run_id}", timeout=timeout)
        return ChainRunObject.model_validate(data)

    def get_for_review(
        self, review_id: str, *, timeout: Optional[float] = None
    ) -> ChainRunObject:
        """Fetch the chain context (run + steps + current_step_number) for a review.

        Useful when you have a review id and want to know whether it's part
        of a chain and which step it's at. Returns the full
        :class:`ChainRunObject` with ``current_step_number`` populated.
        """
        data = self._request(
            "GET", f"/api/v1/reviews/{review_id}/chain", timeout=timeout
        )
        return ChainRunObject.model_validate(data)
