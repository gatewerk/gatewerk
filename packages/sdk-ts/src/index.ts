export { createClient } from "./client.js";
export type { ClientConfig, GatewerkClient } from "./client.js";
export type { GatewerkApiError, Result } from "./errors.js";
export type {
  CreateReviewInput,
  DecideInput,
  ListFilters,
  UpdateVersionInput,
  ReviewDetail,
  ReviewTemplate,
  ReviewTemplateField,
  ReviewListResult,
  ReviewVersion,
  ReviewVersionsResult,
  ReviewToken,
} from "./resources/reviews.js";
export type { FeedbackFilters } from "./resources/feedback.js";
export type { AuditFilters } from "./resources/audit.js";
export type { CreateTemplateInput, UpdateTemplateInput } from "./resources/templates.js";
export type {
  ChainAssigneeSpec,
  ChainAssigneeUser,
  ChainAssigneeRole,
  ChainAssigneeExternalToken,
  ChainStepRejectionPolicy,
  ChainRejectionPolicy,
  ChainMode,
  ChainDefinition,
  ChainDefinitionStep,
  ChainCreateInput,
  ChainStepObject,
  ChainStepStatus,
  ChainRunObject,
  ChainRunStatus,
} from "./resources/chains.js";
export type {
  Note,
  NoteAttachment,
  NoteTargetKind,
  NoteListResult,
  NoteTagsResult,
  CreateNoteInput,
  CreateNoteAttachmentInput,
  PatchNoteInput,
  ListNotesFilters,
} from "./resources/notes.js";

// Backward compatibility (deprecated)
export { Station } from "./station.js";
export type { StationConfig, ReviewOptions, ReviewAndWaitOptions, FeedbackOptions } from "./station.js";
