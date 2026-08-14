import { DEFAULT_ACTION_PRESETS, type TemplateActionConfigCanonical } from "@gatewerk/shared";
import type { OptimisticMutationOptions } from "@gatewerk/web-core/api/client/use-optimistic-mutation";
import type { Template, TemplateListPage } from "@gatewerk/web-core/api/templates";

export function normalizeToCanonical(raw: unknown): TemplateActionConfigCanonical[] {
  if (!Array.isArray(raw)) return [];
  const out: TemplateActionConfigCanonical[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (item && typeof item === "object" && "id" in item && "kind" in item) {
      out.push({ ...(item as TemplateActionConfigCanonical) });
      continue;
    }
    if (typeof item === "string") {
      const preset = DEFAULT_ACTION_PRESETS[item as keyof typeof DEFAULT_ACTION_PRESETS];
      if (preset) out.push({ ...preset, order: i });
      else console.warn(`[normalizeToCanonical] Dropped unknown bare-string action at index ${i}: ${JSON.stringify(item)}`);
      continue;
    }
    if (item && typeof item === "object" && "type" in item) {
      const type = (item as { type: string }).type;
      const preset = DEFAULT_ACTION_PRESETS[type as keyof typeof DEFAULT_ACTION_PRESETS];
      if (preset) {
        const label = (item as { label?: string }).label;
        out.push(label ? { ...preset, label, order: i } : { ...preset, order: i });
      } else {
        console.warn(`[normalizeToCanonical] Dropped legacy action with unknown type at index ${i}: ${JSON.stringify(item)}`);
      }
    }
  }
  return out;
}

// Shared options for publishing a draft, used by TemplateDetail's handlePublish.
//
// No `onOptimistic`: the draft to published cascading state swap (status transition plus
// server-assigned fields like `published_at`, `draft_config: null`) is too
// server-shaped to guess. Helper replaces the row from the server response, and
// invalidates the detail-prefix cache so any open subscription refetches truth.
export const publishMutationOptions: OptimisticMutationOptions<{ id: string }, Template> = {
  keys: () => [["templates"]],
  onServerResponse: (prev, response) => {
    if (!prev) return undefined;
    const list = prev as TemplateListPage;
    return {
      ...list,
      items: list.items.map((t: Template) => (t.id === response.id ? response : t)),
    };
  },
  invalidateOnSuccess: ({ id }) => [["templates", "detail", id]],
};
