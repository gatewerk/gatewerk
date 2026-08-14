"""Tests for the notes resource (sync + async).

Mirrors the test_reviews.py mock-handler pattern: each test installs an
httpx.MockTransport that asserts on the request shape and returns a
fixture response. No network. No real backend.
"""

from __future__ import annotations

import json

import httpx
import pytest

from gatewerk import (
    AsyncGatewerkClient,
    ConflictError,
    Note,
    NoteAttachment,
    NoteList,
    NoteTagsList,
)


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------


def _make_client(handler, max_retries=0):
    from gatewerk.client import GatewerkClient
    from gatewerk._base import BaseResource
    from gatewerk.resources.reviews import ReviewsResource
    from gatewerk.resources.feedback import FeedbackResource
    from gatewerk.resources.templates import TemplatesResource
    from gatewerk.resources.webhooks import WebhooksResource
    from gatewerk.resources.audit import AuditResource
    from gatewerk.resources.stats import StatsResource
    from gatewerk.resources.chains import ChainsResource
    from gatewerk.resources.notes import NotesResource

    transport = httpx.MockTransport(handler)
    http = httpx.Client(
        transport=transport,
        base_url="http://test:3100",
        headers={
            "Authorization": "Bearer gw_key_test",
            "Content-Type": "application/json",
        },
    )

    client = GatewerkClient.__new__(GatewerkClient)
    client._http = http
    client._owns_http = True
    client._base = BaseResource(http, max_retries)
    client.reviews = ReviewsResource(http, max_retries)
    client.feedback = FeedbackResource(http, max_retries)
    client.templates = TemplatesResource(http, max_retries)
    client.webhooks = WebhooksResource(http, max_retries)
    client.audit = AuditResource(http, max_retries)
    client.stats = StatsResource(http, max_retries)
    client.chains = ChainsResource(http, max_retries)
    client.notes = NotesResource(http, max_retries)
    return client


def _make_async_client(handler, max_retries=0):
    from gatewerk.async_client import (
        AsyncReviewsResource,
        AsyncFeedbackResource,
        AsyncTemplatesResource,
        AsyncWebhooksResource,
        AsyncAuditResource,
        AsyncStatsResource,
        AsyncChainsResource,
        AsyncNotesResource,
    )
    from gatewerk._base import AsyncBaseResource

    transport = httpx.MockTransport(handler)
    http = httpx.AsyncClient(
        transport=transport,
        base_url="http://test:3100",
        headers={
            "Authorization": "Bearer gw_key_test",
            "Content-Type": "application/json",
        },
    )

    client = AsyncGatewerkClient.__new__(AsyncGatewerkClient)
    client._http = http
    client._owns_http = True
    client._base = AsyncBaseResource(http, max_retries)
    client.reviews = AsyncReviewsResource(http, max_retries)
    client.feedback = AsyncFeedbackResource(http, max_retries)
    client.templates = AsyncTemplatesResource(http, max_retries)
    client.webhooks = AsyncWebhooksResource(http, max_retries)
    client.audit = AsyncAuditResource(http, max_retries)
    client.stats = AsyncStatsResource(http, max_retries)
    client.chains = AsyncChainsResource(http, max_retries)
    client.notes = AsyncNotesResource(http, max_retries)
    return client


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _note_response() -> dict:
    return {
        "id": "gw_nte_001",
        "project_id": "gw_proj_001",
        "author_id": "gw_usr_001",
        "author_display_fallback": "alice@example.com",
        "body": "spec lookup needed",
        "tags": ["research"],
        "is_shared": True,
        "created_at": "2026-05-03T10:00:00Z",
        "updated_at": "2026-05-03T10:00:00Z",
        "attachments": [
            {
                "id": "gw_att_001",
                "note_id": "gw_nte_001",
                "target_kind": "review",
                "target_id": "gw_rev_001",
                "attached_by": "gw_usr_001",
                "attached_at": "2026-05-03T10:00:00Z",
            }
        ],
    }


# ---------------------------------------------------------------------------
# Sync tests
# ---------------------------------------------------------------------------


class TestNotesCreate:
    def test_create_minimal(self):
        captured: dict = {}

        def handler(request: httpx.Request):
            assert request.method == "POST"
            assert request.url.path == "/api/v1/notes"
            captured["body"] = json.loads(request.content)
            return httpx.Response(201, json=_note_response())

        gw = _make_client(handler)
        result = gw.notes.create("spec lookup needed", project_id="gw_proj_001")
        assert isinstance(result, Note)
        assert result.id == "gw_nte_001"
        assert result.tags == ["research"]
        body = captured["body"]
        assert body["body"] == "spec lookup needed"
        assert body["project_id"] == "gw_proj_001"

    def test_create_with_tags_and_attachments(self):
        captured: dict = {}

        def handler(request: httpx.Request):
            captured["body"] = json.loads(request.content)
            return httpx.Response(201, json=_note_response())

        gw = _make_client(handler)
        gw.notes.create(
            "investigate",
            tags=["urgent", "ops"],
            is_shared=True,
            attachments=[{"target_kind": "review", "target_id": "gw_rev_001"}],
            project_id="gw_proj_001",
        )
        body = captured["body"]
        assert body["tags"] == ["urgent", "ops"]
        assert body["is_shared"] is True
        assert body["attachments"][0]["target_kind"] == "review"


class TestNotesGet:
    def test_get(self):
        def handler(request: httpx.Request):
            assert request.method == "GET"
            assert request.url.path == "/api/v1/notes/gw_nte_001"
            return httpx.Response(200, json=_note_response())

        gw = _make_client(handler)
        result = gw.notes.get("gw_nte_001")
        assert isinstance(result, Note)
        assert result.id == "gw_nte_001"


class TestNotesList:
    def test_list_with_required_project_id(self):
        captured: dict = {}

        def handler(request: httpx.Request):
            assert request.url.path == "/api/v1/notes"
            captured["query"] = dict(request.url.params.multi_items())
            captured["raw_query"] = request.url.query.decode()
            return httpx.Response(
                200,
                json={
                    "items": [_note_response()],
                    "total": 1,
                    "has_more": False,
                },
            )

        gw = _make_client(handler)
        result = gw.notes.list(project_id="gw_proj_001")
        assert isinstance(result, NoteList)
        assert len(result.items) == 1
        assert captured["query"]["project_id"] == "gw_proj_001"

    def test_list_repeats_tags_param(self):
        """Multi-value `tags` param must be `?tags=a&tags=b` per backend Zod."""
        captured: dict = {}

        def handler(request: httpx.Request):
            captured["raw_query"] = request.url.query.decode()
            return httpx.Response(
                200, json={"items": [], "total": 0, "has_more": False}
            )

        gw = _make_client(handler)
        gw.notes.list(project_id="gw_proj_001", tags=["alpha", "beta"])
        # Both repeated keys must appear; order is preserved.
        assert "tags=alpha" in captured["raw_query"]
        assert "tags=beta" in captured["raw_query"]

    def test_list_serializes_booleans_as_lowercase_strings(self):
        captured: dict = {}

        def handler(request: httpx.Request):
            captured["raw_query"] = request.url.query.decode()
            return httpx.Response(
                200, json={"items": [], "total": 0, "has_more": False}
            )

        gw = _make_client(handler)
        gw.notes.list(
            project_id="gw_proj_001",
            is_shared=False,
            has_attachments=True,
        )
        assert "is_shared=false" in captured["raw_query"]
        assert "has_attachments=true" in captured["raw_query"]

    def test_list_auto_paginate(self):
        call_count = 0

        def handler(request: httpx.Request):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                first = _note_response()
                first["id"] = "gw_nte_001"
                return httpx.Response(
                    200,
                    json={"items": [first], "total": 2, "has_more": True},
                )
            second = _note_response()
            second["id"] = "gw_nte_002"
            return httpx.Response(
                200,
                json={"items": [second], "total": 2, "has_more": False},
            )

        gw = _make_client(handler)
        notes = list(gw.notes.list_auto_paginate(project_id="gw_proj_001", batch_size=1))
        assert len(notes) == 2
        assert {n.id for n in notes} == {"gw_nte_001", "gw_nte_002"}


class TestNotesUpdate:
    def test_update_sends_updated_at_guard(self):
        captured: dict = {}

        def handler(request: httpx.Request):
            assert request.method == "PATCH"
            assert request.url.path == "/api/v1/notes/gw_nte_001"
            captured["body"] = json.loads(request.content)
            updated = _note_response()
            updated["body"] = "edited"
            return httpx.Response(200, json=updated)

        gw = _make_client(handler)
        result = gw.notes.update(
            "gw_nte_001",
            updated_at="2026-05-03T10:00:00Z",
            body="edited",
            tags=["edited"],
        )
        assert result.body == "edited"
        body = captured["body"]
        assert body["updated_at"] == "2026-05-03T10:00:00Z"
        assert body["body"] == "edited"

    def test_update_409_stale_raises_conflict(self):
        def handler(request: httpx.Request):
            return httpx.Response(
                409,
                json={
                    "error": {
                        "code": "stale_updated_at",
                        "message": "Note was modified by another writer",
                    }
                },
            )

        gw = _make_client(handler)
        with pytest.raises(ConflictError) as exc_info:
            gw.notes.update("gw_nte_001", updated_at="stale", body="x")
        assert exc_info.value.code == "stale_updated_at"


class TestNotesDelete:
    def test_delete_returns_none_on_204(self):
        def handler(request: httpx.Request):
            assert request.method == "DELETE"
            return httpx.Response(204)

        gw = _make_client(handler)
        result = gw.notes.delete("gw_nte_001")
        assert result is None


class TestNotesAttachments:
    def test_pin(self):
        captured: dict = {}

        def handler(request: httpx.Request):
            assert request.method == "POST"
            assert request.url.path == "/api/v1/notes/gw_nte_001/attachments"
            captured["body"] = json.loads(request.content)
            return httpx.Response(
                201,
                json={
                    "id": "gw_att_002",
                    "note_id": "gw_nte_001",
                    "target_kind": "template",
                    "target_id": "gw_tpl_001",
                    "attached_by": "gw_usr_001",
                    "attached_at": "2026-05-03T10:00:00Z",
                },
            )

        gw = _make_client(handler)
        att = gw.notes.pin("gw_nte_001", target_kind="template", target_id="gw_tpl_001")
        assert isinstance(att, NoteAttachment)
        assert att.target_kind == "template"
        assert captured["body"] == {
            "target_kind": "template",
            "target_id": "gw_tpl_001",
        }

    def test_unpin_returns_none_on_204(self):
        def handler(request: httpx.Request):
            assert request.method == "DELETE"
            assert request.url.path == "/api/v1/notes/gw_nte_001/attachments/gw_att_001"
            return httpx.Response(204)

        gw = _make_client(handler)
        result = gw.notes.unpin("gw_nte_001", "gw_att_001")
        assert result is None


class TestNotesTags:
    def test_tags(self):
        def handler(request: httpx.Request):
            assert request.url.path == "/api/v1/notes/tags"
            assert dict(request.url.params)["project_id"] == "gw_proj_001"
            return httpx.Response(200, json={"items": ["alpha", "beta", "gamma"]})

        gw = _make_client(handler)
        result = gw.notes.tags(project_id="gw_proj_001")
        assert isinstance(result, NoteTagsList)
        assert result.items == ["alpha", "beta", "gamma"]


# ---------------------------------------------------------------------------
# Async tests — same coverage, lighter touch.
# ---------------------------------------------------------------------------


class TestAsyncNotes:
    @pytest.mark.asyncio
    async def test_create(self):
        def handler(request: httpx.Request):
            return httpx.Response(201, json=_note_response())

        gw = _make_async_client(handler)
        result = await gw.notes.create("spec", project_id="gw_proj_001")
        assert isinstance(result, Note)

    @pytest.mark.asyncio
    async def test_list_repeats_tags(self):
        captured: dict = {}

        def handler(request: httpx.Request):
            captured["raw_query"] = request.url.query.decode()
            return httpx.Response(
                200, json={"items": [], "total": 0, "has_more": False}
            )

        gw = _make_async_client(handler)
        await gw.notes.list(project_id="gw_proj_001", tags=["x", "y"])
        assert "tags=x" in captured["raw_query"]
        assert "tags=y" in captured["raw_query"]

    @pytest.mark.asyncio
    async def test_pin_unpin(self):
        seq: list[str] = []

        def handler(request: httpx.Request):
            if request.method == "POST":
                seq.append("pin")
                return httpx.Response(
                    201,
                    json={
                        "id": "gw_att_002",
                        "note_id": "gw_nte_001",
                        "target_kind": "review",
                        "target_id": "gw_rev_001",
                        "attached_by": None,
                        "attached_at": "2026-05-03T10:00:00Z",
                    },
                )
            if request.method == "DELETE":
                seq.append("unpin")
                return httpx.Response(204)
            raise AssertionError("unexpected method")

        gw = _make_async_client(handler)
        att = await gw.notes.pin("gw_nte_001", "review", "gw_rev_001")
        assert att.id == "gw_att_002"
        result = await gw.notes.unpin("gw_nte_001", "gw_att_002")
        assert result is None
        assert seq == ["pin", "unpin"]

    @pytest.mark.asyncio
    async def test_list_auto_paginate(self):
        call_count = 0

        def handler(request: httpx.Request):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                n = _note_response()
                n["id"] = "gw_nte_a"
                return httpx.Response(
                    200, json={"items": [n], "total": 2, "has_more": True}
                )
            n = _note_response()
            n["id"] = "gw_nte_b"
            return httpx.Response(
                200, json={"items": [n], "total": 2, "has_more": False}
            )

        gw = _make_async_client(handler)
        ids = []
        async for note in gw.notes.list_auto_paginate(
            project_id="gw_proj_001", batch_size=1
        ):
            ids.append(note.id)
        assert ids == ["gw_nte_a", "gw_nte_b"]
