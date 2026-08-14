/**
 * surface-tiers/axes — axis key types, derived from the live Zod schemas.
 *
 * `keyof z.infer<typeof Schema>` is what makes the tables exhaustive: add a key
 * to any request body in this package and every table keyed by that type fails
 * to typecheck until the new axis is classified.
 *
 * Types marked NOT TYPE-ENFORCED cannot be derived here because their schemas
 * live in apps/api, which packages/shared must not import. scripts/audit-surface.mjs
 * reads those from source instead.
 */

import type { z } from "zod";
import type {
  TemplateCreateBodySchema,
  TemplateUpdateBodySchema,
  TemplateActionConfigSchema,
  TemplateFieldSchema,
} from "../api/schemas/templates";
import type {
  ReviewCreateBodySchema,
  AssignmentLadderStepSchema,
  ReviewDecideBodySchema,
  ReviewVetoBodySchema,
  ReviewRetryBodySchema,
  ReviewActionBodySchema,
  ReviewUpdateVersionBodySchema,
  ReviewDraftBodySchema,
  ReviewBulkIdsBodySchema,
  ReviewNoteBodySchema,
  ReviewAssignBodySchema,
  ReviewSnoozeBodySchema,
} from "../api/schemas/reviews";
import type {
  CreateNoteBodySchema,
  PatchNoteBodySchema,
  CreateNoteAttachmentInput,
} from "../api/schemas/notes";
import type {
  TeamInviteBodySchema,
  TeamUpdateBodySchema,
} from "../api/schemas/notifications";
import type {
  ChainDefinitionSchema,
  ChainDefinitionStepSchema,
  AssigneeSpecSchema,
  ChainRunCreateBodySchema,
} from "../api/schemas/chains";
import type {
  WebhookCreateBodySchema,
  WebhookUpdateBodySchema,
} from "../api/schemas/webhooks";
import type {
  ApiKeyCreateBodySchema,
  ApiKeyUpdateBodySchema,
} from "../api/schemas/api-keys";
import type { ProjectUpdateBodySchema } from "../api/schemas/projects";
import type { NotificationPrefsSchema } from "../api/schemas/notification-prefs";


/** `keyof` distributed across a union, so discriminated unions yield every variant's keys. */
export type KeysOfUnion<T> = T extends unknown ? keyof T : never;

export type TemplateAxis =
  | keyof z.infer<typeof TemplateCreateBodySchema>
  | keyof z.infer<typeof TemplateUpdateBodySchema>
  // NOT TYPE-ENFORCED: neither appears on a create/update body. `status` moves
  // through dedicated no-body routes (POST /:id/pause, POST /:id/resume) and
  // `draft_config` is the whole body of the draft endpoints rather than a key
  // within one. Both are still operator-reachable, so both are still axes.
  | "status"
  | "draft_config";

export type ActionAxis = keyof z.infer<typeof TemplateActionConfigSchema>;

export type FieldAxis = keyof z.infer<typeof TemplateFieldSchema>;

export type ReviewAxis =
  | keyof z.infer<typeof ReviewCreateBodySchema>
  | `timeout.${keyof NonNullable<z.infer<typeof ReviewCreateBodySchema>["timeout"]>}`
  | `assignment_ladder.${keyof z.infer<typeof AssignmentLadderStepSchema>}`
  // The rest of the review write surface. Several of these bodies carry real
  // behaviour axes (snooze, assign+hold, claim force), so covering only the
  // create body would have left the biggest subsystem half-declared.
  | `decide.${keyof z.infer<typeof ReviewDecideBodySchema>}`
  | `veto.${keyof z.infer<typeof ReviewVetoBodySchema>}`
  | `retry.${keyof z.infer<typeof ReviewRetryBodySchema>}`
  | `action.${keyof z.infer<typeof ReviewActionBodySchema>}`
  | `update.${keyof z.infer<typeof ReviewUpdateVersionBodySchema>}`
  | `draft.${keyof z.infer<typeof ReviewDraftBodySchema>}`
  | `bulk.${keyof z.infer<typeof ReviewBulkIdsBodySchema>}`
  | `note.${keyof z.infer<typeof ReviewNoteBodySchema>}`
  | `assign.${keyof z.infer<typeof ReviewAssignBodySchema>}`
  | `snooze.${keyof z.infer<typeof ReviewSnoozeBodySchema>}`
  // NOT TYPE-ENFORCED: a query param, not a body key. `?force=true` on the
  // claim route changes the semantics of the write and needs reviews:assign.
  | "claim.force";

export type ChainRunAxis = keyof z.infer<typeof ChainRunCreateBodySchema>;

export type NoteAxis =
  | `create.${keyof z.infer<typeof CreateNoteBodySchema>}`
  | `patch.${keyof z.infer<typeof PatchNoteBodySchema>}`
  | `attachment.${keyof z.infer<typeof CreateNoteAttachmentInput>}`;

export type TeamAxis =
  | `invite.${keyof z.infer<typeof TeamInviteBodySchema>}`
  | `member.${keyof z.infer<typeof TeamUpdateBodySchema>}`;

/**
 * The external recipient's own write surface. NOT TYPE-ENFORCED for the same
 * reason as {@link TokenAxis}: the schemas are inline and module-private in
 * `apps/api/src/routes/token-reviews-recipient-actions.ts`.
 */
export type RecipientAxis = "decline.decline_reason" | "raise_questions.question_text";

/**
 * Per-user account preferences.
 *
 * NOT TYPE-ENFORCED AND NOT GATE-VERIFIABLE, uniquely: `login_notifications`
 * has no Zod schema anywhere. It is hand-validated with a `typeof` check at
 * `apps/api/src/routes/account.ts:528-536`, while its sibling key in the very
 * same request body (`notifications`) IS Zod-parsed. That asymmetry is the
 * finding — a key with no schema is invisible to every schema-driven check in
 * this repo, including this one. Declared here so it is at least visible to a
 * human reading the ratification list.
 */
export type AccountAxis = "login_notifications";

export type ChainAxis =
  | keyof z.infer<typeof ChainDefinitionSchema>
  | `step.${keyof z.infer<typeof ChainDefinitionStepSchema>}`
  | `step.assignee.${KeysOfUnion<z.infer<typeof AssigneeSpecSchema>>}`;

export type WebhookAxis =
  | keyof z.infer<typeof WebhookCreateBodySchema>
  | keyof z.infer<typeof WebhookUpdateBodySchema>;

export type ApiKeyAxis =
  | keyof z.infer<typeof ApiKeyCreateBodySchema>
  | keyof z.infer<typeof ApiKeyUpdateBodySchema>;

export type ProjectAxis = keyof z.infer<typeof ProjectUpdateBodySchema>;

export type NotificationAxis =
  | keyof z.infer<typeof NotificationPrefsSchema>
  | `quiet_hours.${keyof NonNullable<z.infer<typeof NotificationPrefsSchema>["quiet_hours"]>}`
  | `digest.${keyof z.infer<typeof NotificationPrefsSchema>["digest"]}`;

/**
 * Token minting. NOT TYPE-ENFORCED: the enforced schema is module-private in
 * `apps/api/src/routes/reviews/tokens.ts` and `packages/shared` must not import
 * from `apps/api`. `scripts/audit-surface.mjs` parses that file and fails if
 * this key set drifts from it. Do not "fix" this by duplicating the schema
 * into shared — there is already one stale duplicate
 * (`ReviewTokenBodySchema` in `api/schemas/reviews.ts`), and it is exactly why
 * all three SDKs 422 on every link they try to mint.
 */
export type TokenAxis =
  | "purpose"
  | "recipient_label"
  | "note"
  | "auth_level"
  | "auth_email"
  | "auth_user_id"
  | "expiryHours"
  | "preview"
  | "extend.hours"
  | "revoke.reason";

