import type { ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { gatewerkApiRequest } from './api';

/**
 * Dropdown sources for node parameters that were previously hand-typed strings.
 *
 * Only two of the four dropdowns the brief asked for are actually implementable
 * against today's API, and the reasons are worth recording so nobody re-litigates:
 *
 *   templates  ✅ GET /api/v1/templates (scope templates:read), enveloped list.
 *   actions    ✅ derived from the selected template — actions are a jsonb column
 *                 on `templates` (packages/db/src/schema/templates.ts:12), not a
 *                 resource, so there is no /actions endpoint to call.
 *   assignee   ❌ the only reviewer list is GET /api/v1/settings/team, and
 *                 apps/api/src/routes/settings/index.ts:29 applies sessionAuth at
 *                 the router level, so it is unreachable with an API key. An
 *                 assignee dropdown is not implementable without backend work.
 *   project    ❌ no list endpoint exists, and none is needed: API keys are
 *                 implicitly project-scoped
 *                 (apps/api/src/middleware/api-key-auth.ts:36).
 */

interface TemplateAction {
  id?: unknown;
  label?: unknown;
}

interface TemplateRow {
  slug?: unknown;
  name?: unknown;
  status?: unknown;
  actions?: unknown;
}

/** Unwrap `{ object: "list", items: [...] }` (packages/shared/src/envelope.ts:7-22). */
function listItems(response: unknown): Record<string, unknown>[] {
  if (Array.isArray(response)) return response as Record<string, unknown>[];
  const record = response as { items?: unknown } | null;
  if (record && Array.isArray(record.items)) return record.items as Record<string, unknown>[];
  return [];
}

/**
 * Template slugs for the "Template" dropdown.
 *
 * Inactive templates are still listed, but labelled, rather than hidden: a
 * workflow may legitimately reference one, and silently omitting it would make
 * the dropdown look like the template had been deleted.
 */
export async function getTemplates(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const response = await gatewerkApiRequest.call(this, 'GET', '/api/v1/templates');

  const options: INodePropertyOptions[] = [];
  for (const row of listItems(response) as TemplateRow[]) {
    if (typeof row.slug !== 'string' || row.slug.length === 0) continue;
    const name = typeof row.name === 'string' && row.name.length > 0 ? row.name : row.slug;
    const inactive = row.status === 'inactive' || row.status === 'draft';
    options.push({
      name: inactive ? `${name} (${String(row.status)})` : name,
      value: row.slug,
      description: `Slug: ${row.slug}`,
    });
  }

  options.sort((a, b) => a.name.localeCompare(b.name));
  return options;
}

/**
 * Actions available on the currently selected template.
 *
 * Depends on the `template` parameter. The wire form is always canonical
 * (`normalizeTemplateActions`, packages/shared/src/api/schemas/templates.ts:306-331),
 * so bare-string and legacy `{type,label,value}` storage both arrive as
 * `{ id, label, ... }` objects. The bare-string branch is still handled because
 * a caller can point this at an older instance.
 */
export async function getTemplateActions(
  this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
  const slug = this.getNodeParameter('template', '') as string;
  if (!slug) return [];

  const response = await gatewerkApiRequest.call(this, 'GET', '/api/v1/templates');
  const template = (listItems(response) as TemplateRow[]).find((row) => row.slug === slug);
  if (!template || !Array.isArray(template.actions)) return [];

  const options: INodePropertyOptions[] = [];
  for (const action of template.actions as (TemplateAction | string)[]) {
    if (typeof action === 'string') {
      options.push({ name: action, value: action });
      continue;
    }
    if (typeof action?.id !== 'string' || action.id.length === 0) continue;
    const label = typeof action.label === 'string' && action.label.length > 0 ? action.label : action.id;
    options.push({ name: label, value: action.id, description: `ID: ${action.id}` });
  }
  return options;
}
