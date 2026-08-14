"""Feedback resource for the Gatewerk Python SDK."""

from __future__ import annotations

from typing import Any, Optional

from .._base import BaseResource
from ..types import FeedbackList


class FeedbackResource(BaseResource):

    def query(
        self,
        *,
        template: Optional[str] = None,
        outcome: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> FeedbackList:
        params: dict[str, Any] = {}
        if template is not None:
            params["template"] = template
        if outcome is not None:
            params["outcome"] = outcome
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset

        data = self._request("GET", "/api/v1/feedback", params=params, timeout=timeout)
        return FeedbackList.model_validate(data)
