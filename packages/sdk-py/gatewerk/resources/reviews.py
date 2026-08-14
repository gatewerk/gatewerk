"""Reviews resource for the Gatewerk Python SDK."""

from __future__ import annotations

import warnings
from typing import Any, Iterator, Optional

from .._base import BaseResource
from ..types import Review, ReviewList, ReviewVersion

_LEGACY_SUNSET = "2026-12-01"


class ReviewsResource(BaseResource):

    def create(
        self,
        template: str,
        payload: dict[str, Any],
        *,
        callback_url: Optional[str] = None,
        priority: Optional[str] = None,
        actions: Optional[list[str]] = None,
        confidence: Optional[float] = None,
        irreversibility: Optional[str] = None,
        assignee: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        timeout: Optional[float] = None,
        idempotency_key: Optional[str] = None,
    ) -> Review:
        body: dict[str, Any] = {"template": template, "payload": payload}
        if callback_url is not None:
            body["callback_url"] = callback_url
        if priority is not None:
            body["priority"] = priority
        if actions is not None:
            body["actions"] = actions
        if confidence is not None:
            body["confidence"] = confidence
        if irreversibility is not None:
            body["irreversibility"] = irreversibility
        if assignee is not None:
            body["assignee"] = assignee
        if metadata is not None:
            body["metadata"] = metadata
        if idempotency_key is not None:
            body["idempotency_key"] = idempotency_key

        data = self._request("POST", "/api/v1/reviews", json=body, timeout=timeout)
        return Review.model_validate(data)

    def get(self, review_id: str, *, timeout: Optional[float] = None) -> Review:
        data = self._request("GET", f"/api/v1/reviews/{review_id}", timeout=timeout)
        return Review.model_validate(data)

    def list(
        self,
        *,
        status: Optional[str] = None,
        priority: Optional[str] = None,
        template: Optional[str] = None,
        assignee: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> ReviewList:
        params: dict[str, Any] = {}
        if status is not None:
            params["status"] = status
        if priority is not None:
            params["priority"] = priority
        if template is not None:
            params["template"] = template
        if assignee is not None:
            params["assignee"] = assignee
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset

        data = self._request("GET", "/api/v1/reviews", params=params, timeout=timeout)
        return ReviewList.model_validate(data)

    def decide(
        self,
        review_id: str,
        decision: str,
        *,
        feedback: Optional[str] = None,
        edited_payload: Optional[dict[str, Any]] = None,
        reviewer: Optional[str] = None,
        prompt_edit: Optional[str] = None,
        version: Optional[int] = None,
        action_value: Optional[str] = None,
        action_label: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Review:
        warnings.warn(
            "reviews.decide() is deprecated for session-authenticated callers; "
            "use reviews.action(review_id, action_id=...) instead. "
            "API-key (agent) callers should continue using reviews.decide() until "
            "the action endpoint supports api-key auth. "
            f"Removed in v2.0 (Sunset: {_LEGACY_SUNSET}). "
            "See https://docs.gatewerk.com/migration/configurable-actions",
            DeprecationWarning,
            stacklevel=2,
        )
        body: dict[str, Any] = {"decision": decision}
        if feedback is not None:
            body["feedback"] = feedback
        if edited_payload is not None:
            body["edited_payload"] = edited_payload
        if reviewer is not None:
            body["reviewer"] = reviewer
        if prompt_edit is not None:
            body["prompt_edit"] = prompt_edit
        if version is not None:
            body["version"] = version
        if action_value is not None:
            body["action_value"] = action_value
        if action_label is not None:
            body["action_label"] = action_label

        data = self._request("POST", f"/api/v1/reviews/{review_id}/decide", json=body, timeout=timeout)
        return Review.model_validate(data)

    def action(
        self,
        review_id: str,
        action_id: str,
        *,
        feedback: Optional[str] = None,
        edited_payload: Optional[dict[str, Any]] = None,
        version: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> Review:
        """Invoke a configurable action on a review.

        Requires session authentication today. Use decide() / retry() / cancel_request()
        for api-key (agent) callers until the action endpoint supports api-key auth.
        """
        body: dict[str, Any] = {"action_id": action_id}
        if feedback is not None:
            body["feedback"] = feedback
        if edited_payload is not None:
            body["edited_payload"] = edited_payload
        if version is not None:
            body["version"] = version

        data = self._request("POST", f"/api/v1/reviews/{review_id}/action", json=body, timeout=timeout)
        return Review.model_validate(data)

    def retry(
        self,
        review_id: str,
        *,
        feedback: Optional[str] = None,
        prompt_edit: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Review:
        warnings.warn(
            "reviews.retry() is deprecated for session-authenticated callers; "
            "use reviews.action(review_id, action_id=...) instead. "
            "API-key (agent) callers should continue using reviews.retry() until "
            "the action endpoint supports api-key auth. "
            f"Removed in v2.0 (Sunset: {_LEGACY_SUNSET}). "
            "See https://docs.gatewerk.com/migration/configurable-actions",
            DeprecationWarning,
            stacklevel=2,
        )
        body: dict[str, Any] = {}
        if feedback is not None:
            body["feedback"] = feedback
        if prompt_edit is not None:
            body["prompt_edit"] = prompt_edit

        data = self._request("POST", f"/api/v1/reviews/{review_id}/retry", json=body, timeout=timeout)
        return Review.model_validate(data)

    def update(
        self,
        review_id: str,
        payload: dict[str, Any],
        version: int,
        *,
        timeout: Optional[float] = None,
    ) -> Review:
        body = {"payload": payload, "version": version}
        data = self._request("PUT", f"/api/v1/reviews/{review_id}", json=body, timeout=timeout)
        return Review.model_validate(data)

    def cancel_request(self, review_id: str, *, timeout: Optional[float] = None) -> Review:
        """Revert a 'changes_requested' review back to pending."""
        warnings.warn(
            "reviews.cancel_request() is deprecated for session-authenticated callers; "
            "use reviews.action(review_id, action_id=...) instead. "
            "API-key (agent) callers should continue using reviews.cancel_request() until "
            "the action endpoint supports api-key auth. "
            f"Removed in v2.0 (Sunset: {_LEGACY_SUNSET}). "
            "See https://docs.gatewerk.com/migration/configurable-actions",
            DeprecationWarning,
            stacklevel=2,
        )
        data = self._request("POST", f"/api/v1/reviews/{review_id}/cancel-request", timeout=timeout)
        return Review.model_validate(data)

    def versions(self, review_id: str, *, timeout: Optional[float] = None) -> list[ReviewVersion]:
        """Get version history for a review."""
        data = self._request("GET", f"/api/v1/reviews/{review_id}/versions", timeout=timeout)
        if isinstance(data, list):
            return [ReviewVersion.model_validate(v) for v in data]
        items = data.get("items", data.get("versions", []))
        return [ReviewVersion.model_validate(v) for v in items]

    def create_token(self, review_id: str, *, timeout: Optional[float] = None) -> dict[str, Any]:
        """Generate a shareable review link token."""
        return self._request("POST", f"/api/v1/reviews/{review_id}/token", timeout=timeout)

    def list_auto_paginate(
        self,
        *,
        status: Optional[str] = None,
        priority: Optional[str] = None,
        template: Optional[str] = None,
        assignee: Optional[str] = None,
        batch_size: int = 50,
    ) -> Iterator[Review]:
        """Iterate through all reviews, automatically handling pagination."""
        offset = 0
        while True:
            page = self.list(
                status=status, priority=priority, template=template,
                assignee=assignee, limit=batch_size, offset=offset,
            )
            yield from page.items
            if not page.has_more:
                break
            offset += batch_size
