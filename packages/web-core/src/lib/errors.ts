import { toast } from "sonner";
import { ApiError } from "../api/client/http";

export type ErrorKind =
  | "auth"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation"
  | "server"
  | "network"
  | "unknown";

export interface MappedError {
  kind: ErrorKind;
  status: number | "unknown";
  code?: string;
  title: string;
  message: string;
  requestId?: string;
  /** Optional follow-up action surfaced as a toast action button. Populated by per-mutation `onMappedError` hooks. */
  action?: { label: string; handler: () => void };
}

// Code-keyed overrides win over the generic status branch when set. Add a row
// here when a backend error code deserves more specific copy than the
// status-driven default. status + requestId from the ApiError are threaded
// through regardless of which branch produced the kind/title/message.
const CODE_MAP: Record<string, Pick<MappedError, "kind" | "title" | "message">> = {
  api_key_cannot_create_private: {
    kind: "validation",
    title: "Private notes by humans only",
    message: "API keys cannot create private notes. Set is_shared to true.",
  },
  missing_project_id: {
    kind: "validation",
    title: "Missing project",
    message: "Project ID is required.",
  },
  stale_updated_at: {
    kind: "conflict",
    title: "Note changed",
    message: "Someone else edited this note. Refresh and try again.",
  },
  not_author: {
    kind: "forbidden",
    title: "Not the author",
    message: "Only the author can edit or delete this note.",
  },
  note_not_found: {
    kind: "not_found",
    title: "Note not found",
    message: "This note doesn't exist or has been deleted.",
  },
  target_not_found: {
    kind: "not_found",
    title: "Target gone",
    message: "The artifact you tried to pin to no longer exists.",
  },
  target_cap: {
    kind: "conflict",
    title: "Target full",
    message: "This artifact already has the maximum number of notes.",
  },
  attachment_cap: {
    kind: "conflict",
    title: "Too many attachments",
    message: "Each note can be pinned to at most 10 artifacts.",
  },
  attachment_not_found: {
    kind: "not_found",
    title: "Attachment gone",
    message: "This pin no longer exists.",
  },
  not_authorized: {
    kind: "forbidden",
    title: "Not allowed",
    message: "You don't have permission to unpin this.",
  },
};

export function mapError(err: unknown): MappedError {
  if (err instanceof ApiError) {
    const { status, code, message, requestId } = err;
    if (code && CODE_MAP[code]) {
      const override = CODE_MAP[code];
      return {
        kind: override.kind,
        status,
        code,
        title: override.title,
        message: override.message,
        requestId,
      };
    }
    switch (status) {
      case 401:
        return {
          kind: "auth",
          status,
          code,
          title: "Signed out",
          message: "Please sign in again.",
          requestId,
        };
      case 403:
        return {
          kind: "forbidden",
          status,
          code,
          title: "Not allowed",
          message: message || "You don't have access to this action.",
          requestId,
        };
      case 404:
        return {
          kind: "not_found",
          status,
          code,
          title: "Not found",
          message: message || "The item no longer exists.",
          requestId,
        };
      case 409:
        return {
          kind: "conflict",
          status,
          code,
          title: "Conflict",
          message: message || "This was changed by someone else.",
          requestId,
        };
      case 422:
        return {
          kind: "validation",
          status,
          code,
          title: "Invalid input",
          message: message || "Please review the fields and try again.",
          requestId,
        };
      default:
        if (status >= 500) {
          const suffix = requestId ? ` (request: ${requestId})` : "";
          return {
            kind: "server",
            status,
            code,
            title: "Something went wrong",
            message: `${message || "Server error."}${suffix}`,
            requestId,
          };
        }
        return {
          kind: "unknown",
          status,
          code,
          title: "Request failed",
          message: message || "Please try again.",
          requestId,
        };
    }
  }

  if (err instanceof Error) {
    if (/network|failed to fetch|load failed/i.test(err.message)) {
      return {
        kind: "network",
        status: "unknown",
        title: "Network error",
        message: "Check your connection and try again.",
      };
    }
    return {
      kind: "unknown",
      status: "unknown",
      title: "Request failed",
      message: err.message,
    };
  }

  return {
    kind: "unknown",
    status: "unknown",
    title: "Request failed",
    message: "Unknown error",
  };
}

export function showMappedError(mapped: MappedError): void {
  const opts = mapped.action
    ? { action: { label: mapped.action.label, onClick: mapped.action.handler } }
    : undefined;

  switch (mapped.kind) {
    case "conflict":
    case "forbidden":
    case "not_found":
      toast.warning(mapped.message, opts);
      return;
    default:
      toast.error(mapped.message, opts);
  }
}
