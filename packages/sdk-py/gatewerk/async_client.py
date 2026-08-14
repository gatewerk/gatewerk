"""Async client for the Gatewerk Python SDK."""

from __future__ import annotations

import os
import warnings
from typing import Any, AsyncIterator, Optional

import httpx

from ._base import AsyncBaseResource, DEFAULT_MAX_RETRIES
from .resources.reviews import _LEGACY_SUNSET
from ._version import __version__
from .resources.webhooks import verify_signature
from .types import (
    Review,
    ReviewList,
    ReviewVersion,
    Template,
    TemplateList,
    TemplateStats,
    FeedbackList,
    AuditList,
    WebhookDeliveryList,
    KeyInfo,
    ChainDefinition,
    ChainRunObject,
    Note,
    NoteAttachment,
    NoteList,
    NoteTagsList,
)


# ---------------------------------------------------------------------------
# Async Resources
# ---------------------------------------------------------------------------


class AsyncReviewsResource(AsyncBaseResource):

    async def create(
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
        data = await self._request("POST", "/api/v1/reviews", json=body, timeout=timeout)
        return Review.model_validate(data)

    async def get(self, review_id: str, *, timeout: Optional[float] = None) -> Review:
        data = await self._request("GET", f"/api/v1/reviews/{review_id}", timeout=timeout)
        return Review.model_validate(data)

    async def list(
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
        data = await self._request("GET", "/api/v1/reviews", params=params, timeout=timeout)
        return ReviewList.model_validate(data)

    async def decide(
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
        data = await self._request("POST", f"/api/v1/reviews/{review_id}/decide", json=body, timeout=timeout)
        return Review.model_validate(data)

    async def action(
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
        data = await self._request("POST", f"/api/v1/reviews/{review_id}/action", json=body, timeout=timeout)
        return Review.model_validate(data)

    async def retry(
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
        data = await self._request("POST", f"/api/v1/reviews/{review_id}/retry", json=body, timeout=timeout)
        return Review.model_validate(data)

    async def update(self, review_id: str, payload: dict[str, Any], version: int, *, timeout: Optional[float] = None) -> Review:
        data = await self._request("PUT", f"/api/v1/reviews/{review_id}", json={"payload": payload, "version": version}, timeout=timeout)
        return Review.model_validate(data)

    async def cancel_request(self, review_id: str, *, timeout: Optional[float] = None) -> Review:
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
        data = await self._request("POST", f"/api/v1/reviews/{review_id}/cancel-request", timeout=timeout)
        return Review.model_validate(data)

    async def versions(self, review_id: str, *, timeout: Optional[float] = None) -> list[ReviewVersion]:
        data = await self._request("GET", f"/api/v1/reviews/{review_id}/versions", timeout=timeout)
        if isinstance(data, list):
            return [ReviewVersion.model_validate(v) for v in data]
        items = data.get("items", data.get("versions", []))
        return [ReviewVersion.model_validate(v) for v in items]

    async def create_token(self, review_id: str, *, timeout: Optional[float] = None) -> dict[str, Any]:
        return await self._request("POST", f"/api/v1/reviews/{review_id}/token", timeout=timeout)

    async def list_auto_paginate(
        self,
        *,
        status: Optional[str] = None,
        priority: Optional[str] = None,
        template: Optional[str] = None,
        assignee: Optional[str] = None,
        batch_size: int = 50,
    ) -> AsyncIterator[Review]:
        offset = 0
        while True:
            page = await self.list(
                status=status, priority=priority, template=template,
                assignee=assignee, limit=batch_size, offset=offset,
            )
            for item in page.items:
                yield item
            if not page.has_more:
                break
            offset += batch_size


class AsyncFeedbackResource(AsyncBaseResource):

    async def query(
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
        data = await self._request("GET", "/api/v1/feedback", params=params, timeout=timeout)
        return FeedbackList.model_validate(data)


class AsyncTemplatesResource(AsyncBaseResource):

    async def list(self, *, timeout: Optional[float] = None) -> TemplateList:
        data = await self._request("GET", "/api/v1/templates", timeout=timeout)
        return TemplateList.model_validate(data)

    async def get(self, template_id: str, *, timeout: Optional[float] = None) -> Template:
        data = await self._request("GET", f"/api/v1/templates/{template_id}", timeout=timeout)
        return Template.model_validate(data)

    async def create(
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
        data = await self._request("POST", "/api/v1/templates", json=body, timeout=timeout)
        return Template.model_validate(data)

    async def update(self, template_id: str, *, timeout: Optional[float] = None, **fields: Any) -> Template:
        data = await self._request("PUT", f"/api/v1/templates/{template_id}", json=fields, timeout=timeout)
        return Template.model_validate(data)

    async def delete(self, template_id: str, *, timeout: Optional[float] = None) -> dict[str, Any]:
        return await self._request("DELETE", f"/api/v1/templates/{template_id}", timeout=timeout)

    async def stats(self, template_id: str, *, timeout: Optional[float] = None) -> TemplateStats:
        data = await self._request("GET", f"/api/v1/templates/{template_id}/stats", timeout=timeout)
        return TemplateStats.model_validate(data)


class AsyncWebhooksResource(AsyncBaseResource):

    def verify(
        self,
        raw_body: str,
        signature_header: str,
        secret: str,
    ) -> dict[str, Any]:
        """Verify a webhook signature. Sync — pure crypto, no network."""
        return verify_signature(raw_body, signature_header, secret)

    async def deliveries(
        self,
        *,
        review_id: Optional[str] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> WebhookDeliveryList:
        params: dict[str, Any] = {}
        if review_id is not None:
            params["review_id"] = review_id
        if limit is not None:
            params["limit"] = limit
        if offset is not None:
            params["offset"] = offset
        data = await self._request("GET", "/api/v1/webhooks/deliveries", params=params, timeout=timeout)
        return WebhookDeliveryList.model_validate(data)


class AsyncAuditResource(AsyncBaseResource):

    async def query(
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
        data = await self._request("GET", "/api/v1/audit", params=params, timeout=timeout)
        return AuditList.model_validate(data)


class AsyncStatsResource(AsyncBaseResource):

    async def get(self, *, timeout: Optional[float] = None) -> dict[str, Any]:
        return await self._request("GET", "/api/v1/stats", timeout=timeout)


class AsyncChainsResource(AsyncBaseResource):
    """Async chains resource — see ``resources.chains.ChainsResource``."""

    async def create(
        self,
        definition: Any,
        initial_payload: dict[str, Any],
        *,
        callback_url: Optional[str] = None,
        metadata: Optional[dict[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> ChainRunObject:
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
        data = await self._request("POST", "/api/v1/chain-runs", json=body, timeout=timeout)
        return ChainRunObject.model_validate(data)

    async def get(self, run_id: str, *, timeout: Optional[float] = None) -> ChainRunObject:
        data = await self._request("GET", f"/api/v1/chain-runs/{run_id}", timeout=timeout)
        return ChainRunObject.model_validate(data)

    async def get_for_review(
        self, review_id: str, *, timeout: Optional[float] = None
    ) -> ChainRunObject:
        data = await self._request(
            "GET", f"/api/v1/reviews/{review_id}/chain", timeout=timeout
        )
        return ChainRunObject.model_validate(data)


class AsyncNotesResource(AsyncBaseResource):
    """Async notes resource — see ``resources.notes.NotesResource``."""

    async def create(
        self,
        body: str,
        *,
        tags: Optional[list[str]] = None,
        is_shared: Optional[bool] = None,
        attachments: Optional[list[dict[str, Any]]] = None,
        project_id: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Note:
        payload: dict[str, Any] = {"body": body}
        if tags is not None:
            payload["tags"] = tags
        if is_shared is not None:
            payload["is_shared"] = is_shared
        if attachments is not None:
            payload["attachments"] = attachments
        if project_id is not None:
            payload["project_id"] = project_id
        data = await self._request("POST", "/api/v1/notes", json=payload, timeout=timeout)
        return Note.model_validate(data)

    async def get(self, note_id: str, *, timeout: Optional[float] = None) -> Note:
        data = await self._request("GET", f"/api/v1/notes/{note_id}", timeout=timeout)
        return Note.model_validate(data)

    async def list(
        self,
        *,
        project_id: str,
        author_id: Optional[str] = None,
        is_shared: Optional[bool] = None,
        tags: Optional[list[str]] = None,
        attached_to_kind: Optional[str] = None,
        attached_to_id: Optional[str] = None,
        has_attachments: Optional[bool] = None,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
        timeout: Optional[float] = None,
    ) -> NoteList:
        params: list[tuple[str, str]] = [("project_id", project_id)]
        if author_id is not None:
            params.append(("author_id", author_id))
        if is_shared is not None:
            params.append(("is_shared", "true" if is_shared else "false"))
        if tags:
            for tag in tags:
                params.append(("tags", tag))
        if attached_to_kind is not None:
            params.append(("attached_to_kind", attached_to_kind))
        if attached_to_id is not None:
            params.append(("attached_to_id", attached_to_id))
        if has_attachments is not None:
            params.append(("has_attachments", "true" if has_attachments else "false"))
        if cursor is not None:
            params.append(("cursor", cursor))
        if limit is not None:
            params.append(("limit", str(limit)))
        data = await self._request("GET", "/api/v1/notes", params=params, timeout=timeout)
        return NoteList.model_validate(data)

    async def list_auto_paginate(
        self,
        *,
        project_id: str,
        author_id: Optional[str] = None,
        is_shared: Optional[bool] = None,
        tags: Optional[list[str]] = None,
        attached_to_kind: Optional[str] = None,
        attached_to_id: Optional[str] = None,
        has_attachments: Optional[bool] = None,
        batch_size: int = 50,
    ) -> AsyncIterator[Note]:
        seen_ids: set[str] = set()
        while True:
            page = await self.list(
                project_id=project_id,
                author_id=author_id,
                is_shared=is_shared,
                tags=tags,
                attached_to_kind=attached_to_kind,
                attached_to_id=attached_to_id,
                has_attachments=has_attachments,
                limit=batch_size,
            )
            new_items = [n for n in page.items if n.id not in seen_ids]
            if not new_items:
                break
            for item in new_items:
                seen_ids.add(item.id)
                yield item
            if not page.has_more:
                break

    async def update(
        self,
        note_id: str,
        updated_at: str,
        *,
        body: Optional[str] = None,
        tags: Optional[list[str]] = None,
        is_shared: Optional[bool] = None,
        timeout: Optional[float] = None,
    ) -> Note:
        payload: dict[str, Any] = {"updated_at": updated_at}
        if body is not None:
            payload["body"] = body
        if tags is not None:
            payload["tags"] = tags
        if is_shared is not None:
            payload["is_shared"] = is_shared
        data = await self._request(
            "PATCH", f"/api/v1/notes/{note_id}", json=payload, timeout=timeout
        )
        return Note.model_validate(data)

    async def delete(self, note_id: str, *, timeout: Optional[float] = None) -> None:
        await self._request("DELETE", f"/api/v1/notes/{note_id}", timeout=timeout)
        return None

    async def pin(
        self,
        note_id: str,
        target_kind: str,
        target_id: str,
        *,
        timeout: Optional[float] = None,
    ) -> NoteAttachment:
        body = {"target_kind": target_kind, "target_id": target_id}
        data = await self._request(
            "POST", f"/api/v1/notes/{note_id}/attachments", json=body, timeout=timeout
        )
        return NoteAttachment.model_validate(data)

    async def unpin(
        self,
        note_id: str,
        attachment_id: str,
        *,
        timeout: Optional[float] = None,
    ) -> None:
        await self._request(
            "DELETE",
            f"/api/v1/notes/{note_id}/attachments/{attachment_id}",
            timeout=timeout,
        )
        return None

    async def tags(
        self, *, project_id: str, timeout: Optional[float] = None
    ) -> NoteTagsList:
        data = await self._request(
            "GET",
            "/api/v1/notes/tags",
            params={"project_id": project_id},
            timeout=timeout,
        )
        return NoteTagsList.model_validate(data)


# ---------------------------------------------------------------------------
# Async Client
# ---------------------------------------------------------------------------


class AsyncGatewerkClient:
    """Async resource-based client for the Gatewerk API.

    Thread safety: AsyncGatewerkClient must NOT be shared across threads.
    It is designed for a single asyncio event loop.

    Usage::

        async with create_async_client(api_key="gw_key_...") as gw:
            review = await gw.reviews.create(...)
    """

    def __init__(
        self,
        api_key: str,
        url: str,
        *,
        max_retries: int = DEFAULT_MAX_RETRIES,
        timeout: float = 30.0,
        http_client: Optional[httpx.AsyncClient] = None,
        proxy: Optional[str] = None,
        verify_ssl: bool = True,
    ) -> None:
        if http_client is not None:
            self._http = http_client
            self._owns_http = False
        else:
            client_kwargs: dict = {
                "base_url": url.rstrip("/"),
                "headers": {
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "X-Gatewerk-Origin": "py-sdk",
                    "X-Gatewerk-Version": __version__,
                },
                "timeout": timeout,
            }
            if proxy is not None:
                client_kwargs["proxy"] = proxy
            if not verify_ssl:
                client_kwargs["verify"] = False
            self._http = httpx.AsyncClient(**client_kwargs)
            self._owns_http = True

        self._base = AsyncBaseResource(self._http, max_retries)
        self.reviews = AsyncReviewsResource(self._http, max_retries)
        self.feedback = AsyncFeedbackResource(self._http, max_retries)
        self.templates = AsyncTemplatesResource(self._http, max_retries)
        self.webhooks = AsyncWebhooksResource(self._http, max_retries)
        self.audit = AsyncAuditResource(self._http, max_retries)
        self.stats = AsyncStatsResource(self._http, max_retries)
        self.chains = AsyncChainsResource(self._http, max_retries)
        self.notes = AsyncNotesResource(self._http, max_retries)

    async def key_info(self, *, timeout: Optional[float] = None) -> KeyInfo:
        """Introspect the current API key's scopes and metadata."""
        data = await self._base._request("GET", "/api/v1/auth/key-info", timeout=timeout)
        return KeyInfo.model_validate(data)

    async def close(self) -> None:
        """Close the underlying HTTP connection pool (if owned by this client)."""
        if self._owns_http:
            await self._http.aclose()

    async def __aenter__(self) -> AsyncGatewerkClient:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()


def create_async_client(
    api_key: Optional[str] = None,
    url: Optional[str] = None,
    *,
    max_retries: int = DEFAULT_MAX_RETRIES,
    timeout: float = 30.0,
    http_client: Optional[httpx.AsyncClient] = None,
    proxy: Optional[str] = None,
    verify_ssl: bool = True,
) -> AsyncGatewerkClient:
    """Create an async Gatewerk client.

    Args:
        api_key: API key. Falls back to GATEWERK_API_KEY env var.
        url: API URL. Falls back to GATEWERK_URL env var, then http://localhost:3100.
        max_retries: Max retries on 429/5xx errors (default 2). Set 0 to disable.
        timeout: Default request timeout in seconds (default 30).
        http_client: Custom httpx.AsyncClient (for proxies, custom TLS, etc.).
            If provided, you are responsible for configuring base_url and auth headers.
        proxy: Proxy URL (e.g. "http://proxy:8080"). Ignored if http_client is set.
        verify_ssl: Verify TLS certificates (default True). Ignored if http_client is set.
    """
    resolved_key = api_key or os.environ.get("GATEWERK_API_KEY")
    resolved_url = url or os.environ.get("GATEWERK_URL", "http://localhost:3100")

    if not resolved_key:
        raise ValueError(
            "API key is required. Pass api_key or set GATEWERK_API_KEY env var."
        )

    return AsyncGatewerkClient(
        api_key=resolved_key,
        url=resolved_url,
        max_retries=max_retries,
        timeout=timeout,
        http_client=http_client,
        proxy=proxy,
        verify_ssl=verify_ssl,
    )
