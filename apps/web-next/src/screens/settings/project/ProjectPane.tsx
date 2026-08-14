/**
 * ProjectPane — project name, description, and project id.
 *
 * Restyled to the Redesign prototype's Settings grammar (manifest §2.2):
 * flat hairline rows via the `_shared/ui` kit, label col 150px, mono
 * truncating values. Name/Description/Project ID click the value itself to
 * edit or copy (SettingsRow's `onValueClick`) rather than a separate Edit/
 * Copy link beside it — a bare link read as dated next to the rest of the
 * app's row affordances, and this also matches the API Keys pane's own
 * click-anywhere-to-copy info chips. Every row's value sits in RowValue and
 * every inline edit uses RowTextInput/RowSaveCancel (`_shared/ui.tsx`) —
 * the same fixed-height pattern AccountPane's rows use, so entering edit
 * mode here never resizes the row or jumps Description/Project ID, and a
 * row here is never a different height than an equivalent row on Account.
 * This USED to be a plain ActionLink Cancel/Save pair deliberately kept
 * smaller than Account's own buttons for exactly this reason (the taller
 * buttons hadn't been height-stabilized yet); now both panes share one
 * real implementation instead of two styles chasing the same constraint.
 * The prototype's rows list also shows Slug and Default timezone, but the
 * API has neither field — a hint has to be true, so this pane only
 * renders what's real.
 *
 * The signing secret section (hmac preview/reveal/rotate) moved out to the
 * Webhooks pane, where it belongs alongside the rest of the webhook
 * configuration; `maskedHmacSecret` stays exported from project-logic.ts for
 * that pane to reuse.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Pencil } from "lucide-react";
import { toast } from "sonner";
import { getProjectSettings, updateProjectSettingsMutation } from "@gatewerk/web-core/api/projects";
import { Skeleton } from "~/components/skeleton";
import { EmptyState } from "../../templates/_ui";
import { PaneHeader, RowSaveCancel, RowTextInput, RowValue, SettingsRow } from "../_shared/ui";
import { ApiKeysPane } from "../api-keys/ApiKeysPane";
import { TeamPane } from "../team/TeamPane";
import { WebhooksPane } from "../webhooks/WebhooksPane";
import { buildUpdatePayload, isProjectDirty, projectToForm, type ProjectForm } from "./project-logic";

export function ProjectPane() {
  const queryClient = useQueryClient();

  const { data: project, isLoading, error } = useQuery(getProjectSettings({}));

  const [form, setForm] = useState<ProjectForm>({ name: "", description: "" });
  useEffect(() => {
    if (project) setForm(projectToForm(project));
  }, [project]);

  const dirty = project ? isProjectDirty(form, project) : false;

  const [editingName, setEditingName] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const editing = editingName || editingDescription;

  function onError(err: unknown) {
    toast.error(err instanceof Error ? err.message : "Request failed");
  }

  function resetForm() {
    if (project) setForm(projectToForm(project));
  }

  function closeEditors() {
    setEditingName(false);
    setEditingDescription(false);
  }

  const saveMutation = useMutation({
    mutationFn: updateProjectSettingsMutation,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["settings", "project"] });
      toast.success("Project saved");
      closeEditors();
    },
    onError,
  });

  function saveProject() {
    saveMutation.mutate(buildUpdatePayload(form));
  }

  function cancelEdit() {
    resetForm();
    closeEditors();
  }

  // Escape reverts a pending edit and closes whichever row is open, unless
  // something above it already claimed the key at capture.
  useEffect(() => {
    if (!editing) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      cancelEdit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, project]);

  const [idCopied, setIdCopied] = useState(false);
  function copyProjectId() {
    if (!project) return;
    navigator.clipboard.writeText(project.id).then(
      () => {
        toast.success("Project ID copied");
        setIdCopied(true);
        setTimeout(() => setIdCopied(false), 1500);
      },
      () => toast.error("Failed to copy"),
    );
  }

  function saveCancelActions() {
    return (
      <RowSaveCancel
        onSave={saveProject}
        onCancel={cancelEdit}
        saving={saveMutation.isPending}
        saveDisabled={!dirty}
      />
    );
  }

  return (
    <div className="flex flex-col gap-[26px]">
      <PaneHeader title="Project" subtitle="Base configuration for this project" />

      {/* Capped rather than the pane's full 1080px (needed below for the
          API Keys | Webhooks pair): three short fields stretched edge to
          edge left a hairline with nothing under most of it — the row was
          too long. 640 matches Account/Security's own
          pane width, so a short settings list reads the same width
          everywhere it appears. */}
      <div className="flex flex-col" style={{ maxWidth: 640 }}>
        {isLoading ? (
          <div className="flex flex-col">
            <span className="sr-only" role="status">
              Loading project settings
            </span>
            <div className="flex flex-col" aria-hidden="true">
              {/* three field rows: label block + value block, footprint matched to
                  SettingsRow itself (px-0.5 py-3.5 + hairline) with the value block
                  at RowValue's fixed ROW_CONTENT_HEIGHT (28px) rather than the
                  label's 13px, so each skeleton row is exactly as tall as the real
                  row it stands in for and Team/API Keys/Webhooks below don't jump
                  when the data lands. */}
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 px-0.5 py-3.5"
                  style={{ borderBottom: "1px solid rgba(var(--gw-line-rgb),.06)" }}
                >
                  <Skeleton width={150} height={13} />
                  <Skeleton width={i === 2 ? 280 : 180} height={28} />
                </div>
              ))}
            </div>
          </div>
        ) : error || !project ? (
          <EmptyState title="Failed to load project settings" hint={error instanceof Error ? error.message : undefined} />
        ) : (
          <>
            <SettingsRow
              label="Project name"
              labelWidth={150}
              mono
              action={editingName ? saveCancelActions() : undefined}
              // Locked while a sibling row is mid-edit, same as before — just
              // expressed as "not clickable" rather than a separate disabled
              // link, since the click target now IS the value.
              onValueClick={editing ? undefined : () => setEditingName(true)}
              onValueClickIcon={<Pencil size={12} strokeWidth={1.9} />}
              onValueClickLabel="Edit project name"
            >
              {editingName ? (
                <RowValue>
                  <RowTextInput
                    aria-label="Project name"
                    autoFocus
                    value={form.name}
                    onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  />
                </RowValue>
              ) : (
                <RowValue>{project.name}</RowValue>
              )}
            </SettingsRow>

            <SettingsRow
              label="Description"
              labelWidth={150}
              mono
              action={editingDescription ? saveCancelActions() : undefined}
              onValueClick={editing ? undefined : () => setEditingDescription(true)}
              onValueClickIcon={<Pencil size={12} strokeWidth={1.9} />}
              onValueClickLabel="Edit description"
            >
              {editingDescription ? (
                <RowValue>
                  <RowTextInput
                    aria-label="Project description"
                    autoFocus
                    value={form.description}
                    onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                    placeholder="Add a description"
                  />
                </RowValue>
              ) : (
                <RowValue>
                  {project.description || <span style={{ color: "var(--gw-t8)" }}>No description</span>}
                </RowValue>
              )}
            </SettingsRow>

            <SettingsRow
              label="Project ID"
              labelWidth={150}
              mono
              onValueClick={copyProjectId}
              onValueClickIcon={
                idCopied ? (
                  <Check size={12} strokeWidth={2} style={{ color: "var(--gw-green-t)" }} />
                ) : (
                  <Copy size={12} strokeWidth={1.9} />
                )
              }
              onValueClickLabel="Copy project ID"
            >
              <RowValue>{project.id}</RowValue>
            </SettingsRow>
          </>
        )}
      </div>

      <TeamPane />

      {/* The connection surface, as one pair — how agents reach Gatewerk and
          how Gatewerk reaches back. Same auto-fit grid as the template page's
          fields | actions (TemplateDetail.tsx): it splits on the width the
          column actually has and folds to one column when narrow. */}
      <div className="grid items-start gap-7" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
        <ApiKeysPane />
        <WebhooksPane />
      </div>
    </div>
  );
}
