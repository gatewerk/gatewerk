"""Pydantic models for Gatewerk API responses."""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------


class TemplateField(BaseModel):
    model_config = ConfigDict(extra="allow")

    name: str
    label: str
    type: str
    editable: bool = False
    options: Optional[list[str]] = None


class TemplateAction(BaseModel):
    model_config = ConfigDict(extra="allow")

    value: str
    label: str


class Template(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    object: str = "template"
    name: str
    slug: Optional[str] = None
    description: Optional[str] = None
    fields: list[TemplateField] = []
    actions: list[Any] = []
    status: str = "active"
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class TemplateList(BaseModel):
    model_config = ConfigDict(extra="allow")

    items: list[Template] = []
    total: int = 0
    has_more: bool = False


class TemplateStats(BaseModel):
    model_config = ConfigDict(extra="allow")

    template_id: Optional[str] = None
    total_reviews: int = 0
    pending: int = 0
    decided: int = 0
    approval_rate: Optional[float] = None
    avg_decision_time: Optional[float] = None


# ---------------------------------------------------------------------------
# Reviews
# ---------------------------------------------------------------------------


class Review(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    object: str = "review"
    project_id: Optional[str] = None
    template_id: Optional[str] = None
    template_slug: Optional[str] = None
    payload: dict[str, Any] = {}
    status: str = "pending"
    priority: str = "normal"
    actions: list[Any] = []
    decision: Optional[str] = None
    action_value: Optional[str] = None
    action_label: Optional[str] = None
    auto_approved: Optional[bool] = None
    feedback: Optional[str] = None
    edited_payload: Optional[dict[str, Any]] = None
    decided_by: Optional[str] = None
    decided_at: Optional[str] = None
    callback_url: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None
    current_version: int = 1
    iteration_count: Optional[int] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    template: Optional[Template] = None
    # The chain run this review belongs to, or None when it belongs to none.
    # Mirrors `chain_run_id` in packages/shared/src/api/schemas/reviews.ts.
    chain_run_id: Optional[str] = None


class ReviewList(BaseModel):
    model_config = ConfigDict(extra="allow")

    items: list[Review] = []
    total: int = 0
    has_more: bool = False


class ReviewVersion(BaseModel):
    model_config = ConfigDict(extra="allow")

    version: int = 1
    payload: dict[str, Any] = {}
    created_at: Optional[str] = None
    created_by: Optional[str] = None


# ---------------------------------------------------------------------------
# Feedback
# ---------------------------------------------------------------------------


class FeedbackEntry(BaseModel):
    model_config = ConfigDict(extra="allow")

    review_id: Optional[str] = None
    template_slug: Optional[str] = None
    decision: Optional[str] = None
    feedback: Optional[str] = None
    original_payload: Optional[dict[str, Any]] = None
    edited_payload: Optional[dict[str, Any]] = None
    decided_at: Optional[str] = None


class FeedbackList(BaseModel):
    model_config = ConfigDict(extra="allow")

    items: list[FeedbackEntry] = []
    total: int = 0
    has_more: bool = False


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------


class AuditEntry(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: Optional[str] = None
    action: Optional[str] = None
    resource_type: Optional[str] = None
    resource_id: Optional[str] = None
    actor: Optional[str] = None
    details: Optional[dict[str, Any]] = None
    created_at: Optional[str] = None


class AuditList(BaseModel):
    model_config = ConfigDict(extra="allow")

    items: list[AuditEntry] = []
    total: int = 0
    has_more: bool = False


# ---------------------------------------------------------------------------
# Webhooks
# ---------------------------------------------------------------------------


class WebhookDelivery(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: Optional[str] = None
    review_id: Optional[str] = None
    url: Optional[str] = None
    status_code: Optional[int] = None
    success: bool = False
    attempt: int = 1
    error: Optional[str] = None
    created_at: Optional[str] = None


class WebhookDeliveryList(BaseModel):
    model_config = ConfigDict(extra="allow")

    items: list[WebhookDelivery] = []
    total: int = 0
    has_more: bool = False


# ---------------------------------------------------------------------------
# Auth / Key Info
# ---------------------------------------------------------------------------


class KeyInfo(BaseModel):
    model_config = ConfigDict(extra="allow")

    prefix: Optional[str] = None
    scopes: list[str] = []
    name: Optional[str] = None
    created_at: Optional[str] = None


# ---------------------------------------------------------------------------
# Chains (Wave 2 Phase A coverage)
# ---------------------------------------------------------------------------
#
# Mirrors @gatewerk/shared's ChainDefinition / ChainRun / ChainStep types.
# The SDK can't import @gatewerk/shared at runtime, so we re-state the wire
# shapes here as Pydantic models. Backend Zod schemas in
# packages/shared/src/api/schemas/chains.ts are the source of truth — any
# drift here is a typing-quality bug, not a wire-format change. Every model
# uses ``extra="allow"`` so unknown forward-compatible fields pass through.


ChainStepRejectionPolicy = Literal["abort", "continue", "branch"]
ChainRejectionPolicy = Literal["terminate", "back_one", "restart"]
ChainMode = Literal["sequential", "parallel", "mixed"]
ChainStepStatus = Literal[
    "pending", "active", "approved", "rejected", "expired", "skipped", "superseded"
]
ChainRunStatus = Literal["active", "completed", "rejected", "aborted"]


class ChainAssigneeUser(BaseModel):
    model_config = ConfigDict(extra="allow")

    kind: Literal["user"] = "user"
    email: Optional[str] = None
    user_id: Optional[str] = None


class ChainAssigneeRole(BaseModel):
    model_config = ConfigDict(extra="allow")

    kind: Literal["role"] = "role"
    role: Literal["admin", "reviewer"]


class ChainAssigneeExternalToken(BaseModel):
    model_config = ConfigDict(extra="allow")

    kind: Literal["external_token"] = "external_token"
    expires_in_seconds: Optional[int] = None
    grace_period_seconds: Optional[int] = None
    note: Optional[str] = None


class ChainDefinitionStep(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    name: Optional[str] = None
    description: Optional[str] = None
    template: str
    # Untyped dict on the wire (one of three discriminated shapes); callers
    # building Pydantic instances directly may pass any of the three model
    # classes above and Pydantic will serialize them.
    assignee: dict[str, Any]
    timeout_seconds: Optional[int] = None
    priority: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None
    depends_on: Optional[list[str]] = None
    rejection_policy: Optional[str] = None
    rejection_branch_to: Optional[int] = None


class ChainDefinition(BaseModel):
    model_config = ConfigDict(extra="allow")

    version: Literal["1.0"] = "1.0"
    name: Optional[str] = None
    description: Optional[str] = None
    mode: str = "sequential"
    rejection_policy: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None
    steps: list[ChainDefinitionStep] = []


class ChainStepObject(BaseModel):
    model_config = ConfigDict(extra="allow")

    object: Optional[str] = "chain_step"
    id: str
    chain_run_id: str
    step_number: int
    review_id: Optional[str] = None
    assignee_spec: dict[str, Any] = {}
    depends_on: Optional[list[str]] = None
    status: str = "pending"
    materialized_at: Optional[str] = None
    rejection_policy: Optional[str] = None
    rejection_branch_to: Optional[int] = None
    # C1 relay: this step's own decision, present once its review is terminal.
    # Mirrors ChainStepObjectSchema in packages/shared/src/api/schemas/chains.ts.
    decision: Optional[str] = None
    decided_by: Optional[str] = None
    decided_at: Optional[str] = None
    feedback: Optional[str] = None
    guidance: Optional[str] = None


class ChainRunObject(BaseModel):
    model_config = ConfigDict(extra="allow")

    object: Optional[str] = "chain_run"
    id: str
    project_id: Optional[str] = None
    template_id: Optional[str] = None
    name: Optional[str] = None
    mode: str = "sequential"
    rejection_policy: str = "terminate"
    status: str = "active"
    metadata: Optional[dict[str, Any]] = None
    created_by: Optional[str] = None
    created_at: Optional[str] = None
    completed_at: Optional[str] = None
    steps: Optional[list[ChainStepObject]] = None
    # Only present on POST response (envelope convenience pointer at
    # routes/chains.ts) — the first step's review id, so callers don't
    # need to scan steps[].
    step_1_review_id: Optional[str] = None
    # Only present on GET /reviews/:id/chain — the calling review's step
    # pointer within the run.
    current_step_number: Optional[int] = None


# ---------------------------------------------------------------------------
# Notes (Wave 2 Phase A coverage)
# ---------------------------------------------------------------------------
#
# Mirrors packages/shared/src/api/schemas/notes.ts. Backend handlers live at
# apps/api/src/routes/notes/{read,write,attachments,tags}.ts. The body
# is redacted to "" by redactPrivateBody when a private note surfaces to a
# subject who isn't the author — that's a server-side decision; the type
# stays ``str`` (never None).


NoteTargetKind = Literal["review", "template", "chain_run"]


class NoteAttachment(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    target_kind: str
    target_id: str
    attached_by: Optional[str] = None
    attached_at: Optional[str] = None
    note_id: Optional[str] = None


class Note(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str
    project_id: Optional[str] = None
    author_id: Optional[str] = None
    author_display_fallback: Optional[str] = None
    body: str = ""
    tags: list[str] = []
    is_shared: bool = False
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    deleted_at: Optional[str] = None
    attachments: list[NoteAttachment] = []


class NoteList(BaseModel):
    model_config = ConfigDict(extra="allow")

    items: list[Note] = []
    total: int = 0
    has_more: bool = False


class NoteTagsList(BaseModel):
    model_config = ConfigDict(extra="allow")

    items: list[str] = []
