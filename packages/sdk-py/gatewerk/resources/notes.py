"""Notes resource for the Gatewerk Python SDK.

Mirrors the notes layer mounted by apps/api/src/routes/notes/:

    POST   /api/v1/notes                              — create
    GET    /api/v1/notes                              — list (cursor + filters)
    GET    /api/v1/notes/:id                          — get one
    PATCH  /api/v1/notes/:id                          — update
    DELETE /api/v1/notes/:id                          — delete (204)
    POST   /api/v1/notes/:id/attachments              — pin (attach)
    DELETE /api/v1/notes/:id/attachments/:attId       — unpin (204)
    GET    /api/v1/notes/tags                         — distinct tags

Type shapes mirror packages/shared/src/api/schemas/notes.ts. Error codes
the backend emits (relevant for catching ``ConflictError`` /
``ForbiddenError`` etc. raised by ``_base``):

    note_not_found, target_not_found, attachment_not_found,
    cross_project_forbidden, not_author, not_authorized,
    api_key_cannot_create_private, stale_updated_at (PATCH 409),
    attachment_cap, target_attachment_cap, missing_project_id.
"""

from __future__ import annotations

from typing import Any, Iterator, Optional

from .._base import BaseResource
from ..types import Note, NoteAttachment, NoteList, NoteTagsList


class NotesResource(BaseResource):

    def create(
        self,
        body: str,
        *,
        tags: Optional[list[str]] = None,
        is_shared: Optional[bool] = None,
        attachments: Optional[list[dict[str, Any]]] = None,
        project_id: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Note:
        """Create a note.

        Args:
            body: Note body text.
            tags: Optional list of free-text tags.
            is_shared: Optional. ``True`` makes the note visible to all
                project members. ``False`` keeps it private to the author.
                api_key callers must omit (or pass True) — the backend
                rejects api-key-authored private notes with
                ``api_key_cannot_create_private``.
            attachments: Optional initial attachments. Each item:
                ``{"target_kind": "review"|"template"|"chain_run",
                "target_id": "..."}``.
            project_id: Required for session callers; api_key callers may
                omit (server resolves from the key).
        """
        payload: dict[str, Any] = {"body": body}
        if tags is not None:
            payload["tags"] = tags
        if is_shared is not None:
            payload["is_shared"] = is_shared
        if attachments is not None:
            payload["attachments"] = attachments
        if project_id is not None:
            payload["project_id"] = project_id

        data = self._request("POST", "/api/v1/notes", json=payload, timeout=timeout)
        return Note.model_validate(data)

    def get(self, note_id: str, *, timeout: Optional[float] = None) -> Note:
        data = self._request("GET", f"/api/v1/notes/{note_id}", timeout=timeout)
        return Note.model_validate(data)

    def list(
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
        """List notes visible to the caller within a project.

        ``project_id`` is required. For api_key callers the value must
        match the key's project (mismatch yields 403
        ``cross_project_forbidden``); session callers' value is ignored
        and the OSS first-project default is used.
        """
        params: list[tuple[str, str]] = [("project_id", project_id)]
        if author_id is not None:
            params.append(("author_id", author_id))
        if is_shared is not None:
            params.append(("is_shared", "true" if is_shared else "false"))
        if tags:
            # Express parses repeated `?tags=a&tags=b` as an array — backend
            # ListNotesQuerySchema also accepts a single string and wraps to
            # array. Use repeated keys to match the SDK-TS shape.
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

        data = self._request("GET", "/api/v1/notes", params=params, timeout=timeout)
        return NoteList.model_validate(data)

    def list_auto_paginate(
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
    ) -> Iterator[Note]:
        """Iterate through all matching notes, automatically handling pagination.

        Backend uses a ``has_more``/cursor-style envelope but the current
        implementation in routes/notes/read.ts paginates by limit alone
        (no cursor token round-trip). Until cursors land we offset by
        re-issuing with growing skips via the request — but read.ts doesn't
        accept offset, so we walk the result set in batches keyed only by
        ``has_more`` and stop when it goes false. This is good enough for
        small result sets; large pull-throughs should use a server-side
        cursor once the backend exposes one.
        """
        seen_ids: set[str] = set()
        while True:
            page = self.list(
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

    def update(
        self,
        note_id: str,
        updated_at: str,
        *,
        body: Optional[str] = None,
        tags: Optional[list[str]] = None,
        is_shared: Optional[bool] = None,
        timeout: Optional[float] = None,
    ) -> Note:
        """Update a note.

        Args:
            note_id: Target note id.
            updated_at: Optimistic concurrency guard — must match the row's
                current ``updated_at`` exactly. Mismatch yields 409
                ``stale_updated_at``; refetch and retry.
            body: New body text.
            tags: Replace the tag list.
            is_shared: Toggle visibility.
        """
        payload: dict[str, Any] = {"updated_at": updated_at}
        if body is not None:
            payload["body"] = body
        if tags is not None:
            payload["tags"] = tags
        if is_shared is not None:
            payload["is_shared"] = is_shared

        data = self._request(
            "PATCH", f"/api/v1/notes/{note_id}", json=payload, timeout=timeout
        )
        return Note.model_validate(data)

    def delete(self, note_id: str, *, timeout: Optional[float] = None) -> None:
        """Soft-delete a note. Backend returns 204; this returns ``None``."""
        self._request("DELETE", f"/api/v1/notes/{note_id}", timeout=timeout)
        return None

    def pin(
        self,
        note_id: str,
        target_kind: str,
        target_id: str,
        *,
        timeout: Optional[float] = None,
    ) -> NoteAttachment:
        """Pin a note to a (target_kind, target_id) — review/template/chain_run."""
        body = {"target_kind": target_kind, "target_id": target_id}
        data = self._request(
            "POST",
            f"/api/v1/notes/{note_id}/attachments",
            json=body,
            timeout=timeout,
        )
        return NoteAttachment.model_validate(data)

    def unpin(
        self,
        note_id: str,
        attachment_id: str,
        *,
        timeout: Optional[float] = None,
    ) -> None:
        """Remove a single pin by attachment id. Backend returns 204."""
        self._request(
            "DELETE",
            f"/api/v1/notes/{note_id}/attachments/{attachment_id}",
            timeout=timeout,
        )
        return None

    def tags(self, *, project_id: str, timeout: Optional[float] = None) -> NoteTagsList:
        """List distinct tags visible to the caller within ``project_id``."""
        data = self._request(
            "GET",
            "/api/v1/notes/tags",
            params={"project_id": project_id},
            timeout=timeout,
        )
        return NoteTagsList.model_validate(data)
