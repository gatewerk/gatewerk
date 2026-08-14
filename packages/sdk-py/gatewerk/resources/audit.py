"""Audit resource for the Gatewerk Python SDK."""

from __future__ import annotations

from typing import Any, Optional

from .._base import BaseResource
from ..types import AuditList


class AuditResource(BaseResource):

    def query(
        self,
        *,
        action: Optional[str] = None,
        resource_type: Optional[str] = None,
        resource_id: Optional[str] = None,
        actor: Optional[str] = None,
        from_: Optional[str] = None,
        to_: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> AuditList:
        # Backend (apps/api/src/routes/audit.ts) reads `from`/`to` from
        # req.query. Python reserves `from` as a keyword so we expose
        # `from_`/`to_` and remap to the unsuffixed names on the wire.
        params: dict[str, Any] = {}
        if action is not None:
            params["action"] = action
        if resource_type is not None:
            params["resource_type"] = resource_type
        if resource_id is not None:
            params["resource_id"] = resource_id
        if actor is not None:
            params["actor"] = actor
        if from_ is not None:
            params["from"] = from_
        if to_ is not None:
            params["to"] = to_
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset

        data = self._request("GET", "/api/v1/audit", params=params, timeout=timeout)
        return AuditList.model_validate(data)
