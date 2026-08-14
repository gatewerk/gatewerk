/**
 * Templates list: tab predicate, search, sort, and the row meta string.
 *
 * Framework-free on purpose, the same reason the S4 editor modules are — it
 * means the list's behaviour is covered by tests rather than by looking at it.
 * The Inbox's sibling of this file is `screens/inbox/review-filters.ts`.
 */
import type { Priority } from "@gatewerk/shared";

export const TEMPLATE_TABS = ["all", "active", "inactive", "drafts"] as const;
export type TemplateTab = (typeof TEMPLATE_TABS)[number];

export const TEMPLATE_TAB_LABELS: Record<TemplateTab, string> = {
  all: "All",
  active: "Active",
  inactive: "Inactive",
  drafts: "Drafts",
};

/**
 * The subset of a template row this module reads. Deliberately structural
 * rather than `Template`: the list query returns the Zod-inferred wire type and
 * the detail pane takes the hand-maintained `TemplateSchema`, and neither is a
 * subtype of the other. Naming only what is read keeps both callers honest.
 */
export interface TemplateListItem {
  id: string;
  slug: string;
  name: string;
  status?: string;
  default_priority: Priority;
  fields: unknown[];
  draft_config?: Record<string, unknown> | null;
  chain_config?: Record<string, unknown> | null;
  /** When the template was last touched — the row's timestamp, like the
   *  other lists'. Optional because older servers may omit it. */
  updated_at?: string;
}

/**
 * Tab membership. Note `drafts` is not exclusive with `active`/`inactive`: a
 * published template with unsaved edits carries a `draft_config` and belongs in
 * both. That matches the prototype (`hasDraft`) and, more importantly, the
 * product: "has unpublished work" is the question the tab answers.
 */
export function templateInTab(t: TemplateListItem, tab: TemplateTab): boolean {
  switch (tab) {
    case "all":
      return true;
    case "active":
      return t.status === "active";
    case "inactive":
      return t.status === "inactive";
    case "drafts":
      return t.status === "draft" || t.draft_config != null;
  }
}

/**
 * Tier 2 copy for a tab that matched nothing, verbatim from the Empty States
 * board (Templates section, T2 · active / inactive / drafts).
 *
 * It is a function rather than a lookup table because two of the three carry a
 * count, and the count is the whole point of the hint: it says "your data is
 * still there, this tab is the narrow thing". The drafts title is also NOT
 * derivable from the tab label — the board says "No drafts", where the
 * label-interpolating version this replaces said "No drafts templates". That
 * bug survived an earlier fix that swapped the tab KEY for the tab LABEL,
 * because lowercasing "Drafts" lands back on "drafts".
 *
 * `all` is excluded at the type level: with no query, the all tab shows every
 * row, so it can only be empty when the whole list is, which is Tier 1.
 */
export function templateTabEmptyCopy(
  tab: Exclude<TemplateTab, "all">,
  items: readonly TemplateListItem[],
): { title: string; hint?: string } {
  switch (tab) {
    case "active": {
      const other = items.filter((t) => !templateInTab(t, "active")).length;
      return {
        title: "No active templates",
        // Never "0 are paused or drafts" — a zero hint is worse than silence,
        // the same rule the inbox tab hints follow.
        hint: other > 0 ? `${other} are paused or drafts.` : undefined,
      };
    }
    case "inactive":
      // No hint on the board: there is no second number worth naming here.
      return { title: "No inactive templates" };
    case "drafts": {
      const published = items.filter((t) => !templateInTab(t, "drafts")).length;
      return {
        title: "No drafts",
        hint: published > 0 ? `All ${published} templates are published.` : undefined,
      };
    }
  }
}

/** Name and slug only, matching the prototype. Descriptions are not searched. */
export function searchTemplates<T extends TemplateListItem>(items: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((t) => t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q));
}

/**
 * Drafts first, then by slug.
 *
 * Sorting on slug while the row displays `name` is inherited from both the
 * prototype and apps/web, and it is deliberate: slug is immutable after publish,
 * so the order stays put while an operator renames a template. Sorting on a
 * value the user is actively typing would make rows jump under the cursor.
 */
export function sortTemplates<T extends TemplateListItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const aDraft = a.status === "draft";
    const bDraft = b.status === "draft";
    if (aDraft !== bDraft) return aDraft ? -1 : 1;
    return a.slug.localeCompare(b.slug);
  });
}

export function visibleTemplates<T extends TemplateListItem>(
  items: readonly T[],
  tab: TemplateTab,
  query: string,
): T[] {
  return sortTemplates(searchTemplates(items.filter((t) => templateInTab(t, tab)), query));
}

/** Only fields an operator actually named count — an unnamed row is dropped on save. */
export function countNamedFields(fields: readonly unknown[]): number {
  return fields.filter((f) => typeof (f as { name?: unknown } | null)?.name === "string" && (f as { name: string }).name.length > 0).length;
}

export function chainStepCount(chainConfig: Record<string, unknown> | null | undefined): number {
  const steps = (chainConfig as { steps?: unknown } | null | undefined)?.steps;
  return Array.isArray(steps) ? steps.length : 0;
}

const PRIORITY_LABELS: Record<string, string> = {
  critical: "Critical",
  high: "High",
  normal: "Normal",
  low: "Low",
};

/**
 * The row's second line: `Draft · Critical · 5 fields · Chain 3`.
 *
 * Two departures from the prototype, both deliberate:
 *   * the separator is a middle dot, which is the project's tabular separator
 *     rule; the prototype used `  /  `.
 *   * `Chain · 3` becomes `Chain 3`, because a middle dot inside a segment of a
 *     middle-dot-separated line reads as a fourth segment.
 *
 * The prototype's `Unpublished` segment is replaced by `Unpublished changes`
 * and keyed off `draft_config` rather than a `published` flag. The prototype's
 * version was unreachable on first load (manifest §1.5) and the real product
 * distinction is "this row has edits nobody can see yet", which is what an
 * operator needs to know before they publish.
 */
/**
 * The meta line as parts, not a punctuated string. Rulings:
 * lowercase throughout (mono data text, like the other lists' slugs), no
 * middots — the row separates parts with space alone — and NO color: a
 * template's default priority is configuration, not a live alarm. It appears
 * here only because the filter popover does not cover it, and "normal" is
 * omitted because a default carries no information.
 */
export function templateMetaParts(t: TemplateListItem): string[] {
  const status =
    t.status === "draft"
      ? "draft"
      : t.draft_config != null
        ? "unpublished changes"
        : t.status === "inactive"
          ? "inactive"
          : "";
  const fieldCount = countNamedFields(t.fields);
  const chain = chainStepCount(t.chain_config);

  const parts: string[] = [];
  if (status) parts.push(status);
  if (t.default_priority !== "normal") parts.push(t.default_priority);
  parts.push(`${fieldCount} ${fieldCount === 1 ? "field" : "fields"}`);
  if (chain > 0) parts.push(`chain ${chain}`);
  return parts;
}
