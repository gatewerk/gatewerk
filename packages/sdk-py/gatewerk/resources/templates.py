"""Templates resource for the Gatewerk Python SDK."""

from __future__ import annotations

from typing import Any, Optional

from .._base import BaseResource
from ..types import Template, TemplateList, TemplateStats


class TemplatesResource(BaseResource):

    def list(self, *, timeout: Optional[float] = None) -> TemplateList:
        data = self._request("GET", "/api/v1/templates", timeout=timeout)
        return TemplateList.model_validate(data)

    def get(self, template_id: str, *, timeout: Optional[float] = None) -> Template:
        data = self._request("GET", f"/api/v1/templates/{template_id}", timeout=timeout)
        return Template.model_validate(data)

    def create(
        self,
        name: str,
        slug: str,
        *,
        description: Optional[str] = None,
        fields: Optional[list[dict[str, Any]]] = None,
        actions: Optional[list[dict[str, Any]]] = None,
        timeout: Optional[float] = None,
    ) -> Template:
        body: dict[str, Any] = {"name": name, "slug": slug}
        if description is not None:
            body["description"] = description
        if fields is not None:
            body["fields"] = fields
        if actions is not None:
            body["actions"] = actions

        data = self._request("POST", "/api/v1/templates", json=body, timeout=timeout)
        return Template.model_validate(data)

    def update(self, template_id: str, *, timeout: Optional[float] = None, **fields: Any) -> Template:
        data = self._request("PUT", f"/api/v1/templates/{template_id}", json=fields, timeout=timeout)
        return Template.model_validate(data)

    def delete(self, template_id: str, *, timeout: Optional[float] = None) -> dict[str, Any]:
        return self._request("DELETE", f"/api/v1/templates/{template_id}", timeout=timeout)

    def stats(self, template_id: str, *, timeout: Optional[float] = None) -> TemplateStats:
        """Get statistics for a specific template."""
        data = self._request("GET", f"/api/v1/templates/{template_id}/stats", timeout=timeout)
        return TemplateStats.model_validate(data)
