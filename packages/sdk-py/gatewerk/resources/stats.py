"""Stats resource for the Gatewerk Python SDK."""

from __future__ import annotations

from typing import Any, Optional

from .._base import BaseResource


class StatsResource(BaseResource):

    def get(self, *, timeout: Optional[float] = None) -> dict[str, Any]:
        return self._request("GET", "/api/v1/stats", timeout=timeout)
