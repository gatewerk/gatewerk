"""Station — deprecated legacy client. Use create_client() instead."""

from __future__ import annotations

import time
import warnings
from typing import Any, Optional

import httpx

from .integrations.common import is_terminal


class Station:
    """Deprecated: Use create_client() instead.

    Legacy client for the Gatewerk human-review API.
    """

    def __init__(self, base_url: str, api_key: str) -> None:
        warnings.warn(
            "Station is deprecated. Use gatewerk.create_client() instead.",
            DeprecationWarning,
            stacklevel=2,
        )
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def review(
        self,
        template: str,
        payload: dict[str, Any],
        callback_url: str,
        oversight: Optional[str] = None,
        **kwargs: Any,
    ) -> dict:
        """Create a review gate.

        Args:
            oversight: ``"monitoring"`` for a non-blocking gate — the agent
                continues immediately while a human reviews asynchronously.
                ``"blocking"`` (default) halts the agent until a human decides.
                See HRP Monitoring Outcomes for the full outcome matrix. Note:
                the agent must NOT block on a monitoring review — use
                ``await_decision`` only on ``"blocking"`` reviews.
        """
        body: dict[str, Any] = {
            "template": template,
            "payload": payload,
            "callback_url": callback_url,
        }
        if oversight is not None:
            body["oversight"] = oversight
        body.update(kwargs)

        resp = httpx.post(
            f"{self.base_url}/api/v1/reviews",
            json=body,
            headers=self._headers(),
        )
        resp.raise_for_status()
        return resp.json()

    def review_and_wait(
        self,
        template: str,
        payload: dict[str, Any],
        callback_url: str,
        poll_interval: float = 1.0,
        timeout: float = 300.0,
        **kwargs: Any,
    ) -> dict:
        created = self.review(template, payload, callback_url, **kwargs)
        review_id = created["id"]
        deadline = time.monotonic() + timeout

        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    f"Review {review_id} still pending after {timeout}s"
                )

            time.sleep(poll_interval)

            resp = httpx.get(
                f"{self.base_url}/api/v1/reviews/{review_id}",
                headers=self._headers(),
            )
            resp.raise_for_status()
            data = resp.json()

            # Keep waiting while the review is non-terminal. `awaiting_iteration`
            # / `awaiting_external` are NOT done — returning on them hands back a
            # half-formed result. Single canonical check via is_terminal().
            if is_terminal(data.get("status", "")):
                return data

    def feedback(
        self,
        template: Optional[str] = None,
        outcome: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> dict:
        params: dict[str, Any] = {}
        if template is not None:
            params["template"] = template
        if outcome is not None:
            params["outcome"] = outcome
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset

        resp = httpx.get(
            f"{self.base_url}/api/v1/feedback",
            params=params,
            headers=self._headers(),
        )
        resp.raise_for_status()
        return resp.json()
