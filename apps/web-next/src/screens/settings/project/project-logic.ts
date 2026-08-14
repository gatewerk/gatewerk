/**
 * Pure logic for the project settings pane: form seeding, dirty-check, and
 * update payload shaping. Split out so it is testable without a DOM render
 * harness (web-next has none, per Settings.test.tsx).
 *
 * `maskedHmacSecret` also lives here even though ProjectPane no longer
 * renders a signing secret row (that moved to the Webhooks pane) — it stays
 * exported for that pane to import rather than duplicating the mask format.
 */
import type { ProjectSettings } from "@gatewerk/web-core/api/projects";
import type { ProjectUpdateBody } from "@gatewerk/shared";

export interface ProjectForm {
  name: string;
  description: string;
}

/** Seeds the editable form from a loaded project. A null description reads as empty. */
export function projectToForm(project: ProjectSettings): ProjectForm {
  return { name: project.name, description: project.description ?? "" };
}

/** True once the form disagrees with the last loaded project, in either field. */
export function isProjectDirty(form: ProjectForm, project: ProjectSettings): boolean {
  return form.name !== project.name || form.description !== (project.description ?? "");
}

/**
 * An empty description is omitted, not sent as an explicit clear — the field
 * is optional on the wire, and this mirrors apps/web's ProjectPane, which
 * never gave clearing a description its own affordance.
 */
export function buildUpdatePayload(form: ProjectForm): ProjectUpdateBody {
  return { name: form.name, description: form.description || undefined };
}

/**
 * Masked signing secret: the real prefix plus a fixed run of bullets, so the
 * mask never leaks the secret's actual length. Matches apps/web's
 * WebhooksSection.tsx (24-bullet mask).
 */
export function maskedHmacSecret(prefix: string): string {
  return `${prefix}${"•".repeat(24)}`;
}
