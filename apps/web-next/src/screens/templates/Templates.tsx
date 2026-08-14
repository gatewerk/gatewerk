/**
 * Templates — [list 392px | detail] , the Inbox frame with a templates payload.
 *
 * Selection lives in `?id=<template>` , matching apps/web so a link works in
 * either app during the cutover. The inbox uses `?review=` for the same reason.
 */
import { useEffect, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router";
import type { ZenOutletContext } from "~/shell/use-zen";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, SquareStack } from "lucide-react";
import { templates, type Template, type TemplateListPage } from "@gatewerk/web-core/api/templates";
import { mapError, showMappedError } from "@gatewerk/web-core/lib/errors";
import type { TemplateSchema } from "@gatewerk/shared";
import { TemplateList } from "./TemplateList";
import { TemplateDetail } from "./detail/TemplateDetail";
import {
  visibleTemplates,
  type TemplateListItem,
  type TemplateTab,
} from "./template-filters";
import { templatesQuery, TEMPLATES_QUERY_KEY } from "~/route-queries";

/**
 * The list query key.
 *
 * `["templates"]` rather than the typed client's `["templates","list"]`,
 * matching what apps/web's page subscribes to. The two keys have coexisted
 * since before S4; picking the one the optimistic helpers already write to is
 * what makes cache patches land instead of writing to a phantom entry. Detail
 * and stats sit under `["templates","detail",id]` and `["templates","stats",id]`,
 * both of which this key is a prefix of, so invalidating it refreshes all three.
 *
 * Defined in ~/route-queries (the shared catalog); re-exported here so
 * PinPicker.tsx and TemplateDetail.tsx can keep importing it from Templates.
 */
export { TEMPLATES_QUERY_KEY };

export function Templates() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("id");

  const [tab, setTab] = useState<TemplateTab>("all");
  const [query, setQuery] = useState("");
  const { zen } = useOutletContext<ZenOutletContext>();
  // Zen forces the list shut without discarding the reviewer's own choice —
  // it reappears at whatever manual state it was in once zen ends.
  const [manualListCollapsed, setManualListCollapsed] = useState(false);
  const listCollapsed = manualListCollapsed || zen;
  const [creating, setCreating] = useState(false);

  function setSelectedId(id: string | null) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set("id", id);
        else next.delete("id");
        return next;
      },
      { replace: true },
    );
  }

  const { data, isLoading, error, refetch } = useQuery(templatesQuery);

  const items = (data?.items ?? []) as unknown as (Template & TemplateListItem)[];
  const selected = selectedId ? (items.find((t) => t.id === selectedId) ?? null) : null;

  // The same list TemplateList paints, recomputed here for one reason: the
  // detail pane's "select a template" state must not appear beside an empty
  // list (Empty States board, spec §acceptance 8 — one empty state per screen).
  const visible = visibleTemplates(items, tab, query);

  // A selected template can leave the list: deleted here, or deleted in another
  // tab and dropped by a refetch. Drop the id rather than leaving the pane
  // pointing at a row that no longer exists. Guarded on a settled, non-empty
  // list so the first paint does not clear a deep link before data arrives.
  useEffect(() => {
    if (!selectedId || isLoading || items.length === 0) return;
    if (!items.some((t) => t.id === selectedId)) setSelectedId(null);
    // `setSelectedId` is omitted deliberately: it is redeclared every render, so
    // listing it would re-run this on every render rather than on a list change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, selectedId, isLoading]);

  async function handleCreate() {
    if (creating) return;
    setCreating(true);
    try {
      const created = await templates.createDraft({});
      // Splice rather than refetch so the new row is on screen before the round
      // trip to list. `total` moves with it or the count under the tabs lies.
      queryClient.setQueryData(TEMPLATES_QUERY_KEY, (old: unknown) => {
        const page = old as TemplateListPage | undefined;
        if (!page?.items) return old;
        return { ...page, items: [created, ...page.items], total: page.total + 1 };
      });
      setSelectedId(created.id);
    } catch (e) {
      showMappedError(mapError(e));
    } finally {
      setCreating(false);
    }
  }

  function handleRemoved(id: string, message: string) {
    queryClient.setQueryData(TEMPLATES_QUERY_KEY, (old: unknown) => {
      const page = old as TemplateListPage | undefined;
      if (!page?.items) return old;
      return { ...page, items: page.items.filter((t) => t.id !== id), total: Math.max(0, page.total - 1) };
    });
    if (selectedId === id) setSelectedId(null);
    toast.success(message);
  }

  return (
    <div className="flex h-full min-w-0">
      {/* ── List column ── */}
      <div
        className="h-full shrink-0 overflow-hidden transition-[width] duration-[180ms] ease-in-out"
        style={{ width: listCollapsed ? 54 : 392 }}
      >
        {listCollapsed ? (
          <div className="flex h-full flex-col items-center gap-1 py-[14px]">
            <button
              type="button"
              onClick={() => setManualListCollapsed(false)}
              title="Expand list"
              aria-label="Expand list"
              className="gw-focus-ring mb-1.5 flex h-[34px] w-[34px] cursor-pointer items-center justify-center rounded-[9px] border-none bg-transparent text-t8 transition-colors hover:bg-[rgba(var(--gw-line-rgb),0.06)] hover:text-t4"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <line x1="9.5" y1="4" x2="9.5" y2="20" strokeDasharray="2 2" />
              </svg>
            </button>
            {/* Collapsed strip: one dot per template, green while it carries
                unpublished work. The prototype left `miniStyle`/`miniDot`
                undefined on this screen, so its strip rendered unstyled,
                unlabelled hit targets (manifest §1.9). */}
            {items.map((t) => {
              const isSelected = selectedId === t.id;
              const unpublished = t.status === "draft" || t.draft_config != null;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedId(t.id)}
                  title={t.name || "Untitled template"}
                  className="gw-focus-ring flex w-[38px] shrink-0 cursor-pointer items-center justify-center rounded-[8px] border-none transition-colors"
                  style={{
                    height: isSelected ? 30 : 28,
                    background: isSelected ? "rgba(var(--gw-line-rgb),.08)" : "transparent",
                    boxShadow: isSelected ? "inset 0 0 0 1px rgba(var(--gw-line-rgb),.09)" : "none",
                  }}
                >
                  <span
                    style={{
                      display: "block",
                      width: isSelected ? 8 : 7,
                      height: isSelected ? 8 : 7,
                      borderRadius: "50%",
                      background: unpublished
                        ? "var(--gw-green)"
                        : isSelected
                          ? "var(--gw-t3)"
                          : "rgba(var(--gw-line-rgb),.28)",
                    }}
                  />
                </button>
              );
            })}
          </div>
        ) : (
          <TemplateList
            items={items}
            isLoading={isLoading}
            error={error}
            onRetry={() => void refetch()}
            selectedId={selectedId}
            onSelect={setSelectedId}
            tab={tab}
            onTab={setTab}
            query={query}
            onQuery={setQuery}
            onCollapse={() => setManualListCollapsed(true)}
            onCreate={() => void handleCreate()}
            creating={creating}
          />
        )}
      </div>

      {/* ── Detail pane ── */}
      <div
        className="m-[6px_6px_6px_0] min-w-0 flex-1 overflow-hidden rounded-[12px]"
        style={{
          background: "linear-gradient(180deg, var(--gw-panel-a), var(--gw-panel-b))",
          boxShadow: "0 12px 34px rgba(0,0,0,.4), inset 0 1px 0 rgba(var(--gw-line-rgb),.06)",
        }}
      >
        {selected ? (
          <TemplateDetail
            // Remount on identity change so every piece of editor state is
            // seeded from the new row at once. apps/web instead re-seeds 15
            // setters from a `[template.id]` effect, which is the same thing
            // with more ways to forget a field.
            key={selected.id}
            template={selected as unknown as TemplateSchema}
            onRemoved={handleRemoved}
          />
        ) : isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 size={20} className="animate-spin text-t8" />
          </div>
        ) : visible.length > 0 ? (
          /* History's empty-state pattern (it is
             the app's empty-state design — 52px tile, 15px title, 13px body). */
          <div className="grid h-full place-items-center">
            <div
              className="flex flex-col items-center text-center"
              style={{ gap: 16, padding: 24, maxWidth: 280 }}
            >
              <div
                className="flex shrink-0 items-center justify-center"
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 13,
                  background: "rgba(var(--gw-line-rgb),.04)",
                  border: "1px solid rgba(var(--gw-line-rgb),.09)",
                  color: "var(--gw-t8)",
                }}
              >
                <SquareStack size={24} strokeWidth={1.6} />
              </div>
              <div className="flex flex-col" style={{ gap: 6 }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: 15,
                    fontWeight: 600,
                    color: "var(--gw-t4)",
                    letterSpacing: "-.005em",
                  }}
                >
                  Select a template to edit
                </p>
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--gw-t8)" }}>
                  Pick any template from the list to change its fields, actions
                  and rules.
                </p>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
