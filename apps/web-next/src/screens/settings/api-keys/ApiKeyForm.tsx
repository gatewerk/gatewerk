/**
 * Create/edit form for one API key. Rendered inside ApiKeysPane's `Modal`
 * (~/components/Modal) — the list stays mounted and dimmed behind it rather
 * than being replaced, so closing the form is a clean return to whatever was
 * on screen, not a re-fetch/re-render of the list. Its own Escape-to-cancel
 * below is redundant with the Modal's (harmless double no-op — both call the
 * same onCancel), kept so this form still cancels correctly if ever reused
 * outside a Modal. The ONLY green element is the button that commits.
 *
 * Grammar: SectionRule per section, RowLabel + inset controls per row —
 * the template editor's edit grid, which is the app's shipped form language.
 * Preset selection is SegmentedTabs, the shared list-pill.
 */
import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { SCOPES, SCOPE_LABELS, type Scope } from "@gatewerk/shared";
import {
  GhostButton,
  INSET_INPUT_CLASS,
  INSET_STYLE,
  PrimaryButton,
  RowLabel,
  SelectMenu,
} from "../../templates/_ui";
import { SegmentedTabs } from "~/components/SegmentedTabs";
import { SectionRule } from "../_shared/ui";
import { Toggle } from "../_shared/Toggle";
import {
  EXPIRATION_OPTIONS,
  type ExpirationPreset,
  type KeyFormData,
  type ScopePreset,
} from "./_forms";

const PRESET_TABS = [
  { value: "agent", label: "Agent" },
  { value: "reviewer", label: "Reviewer" },
  { value: "admin", label: "Admin" },
  { value: "custom", label: "Custom" },
] as const;

const EXPIRATION_SELECT = EXPIRATION_OPTIONS.map((o) => ({ value: o.value, label: o.label }));

/** Chip list + entry input. Enter or comma commits, Backspace on empty pops. */
function ChipInput({
  values,
  onChange,
  placeholder,
  addPlaceholder,
  mono = false,
  ariaLabel,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addPlaceholder: string;
  mono?: boolean;
  ariaLabel: string;
}) {
  const [input, setInput] = useState("");

  function commit() {
    const entry = input.trim().replace(/,$/, "");
    if (entry && !values.includes(entry)) onChange([...values, entry]);
    setInput("");
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <input
        aria-label={ariaLabel}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === ",") && input.trim()) {
            e.preventDefault();
            commit();
          }
          if (e.key === "Backspace" && !input && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
        placeholder={values.length === 0 ? placeholder : addPlaceholder}
        className={`${INSET_INPUT_CLASS} w-64 ${mono ? "font-mono" : ""}`}
        style={INSET_STYLE}
      />
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((entry) => (
            <span
              key={entry}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] ${mono ? "font-mono" : ""}`}
              style={INSET_STYLE}
            >
              {entry}
              <button
                type="button"
                aria-label={`Remove ${entry}`}
                onClick={() => onChange(values.filter((v) => v !== entry))}
                className="ml-0.5 flex cursor-pointer items-center rounded-full border-none bg-transparent p-0.5 transition-opacity hover:opacity-70"
                style={{ color: "var(--gw-t7)" }}
              >
                <X size={10} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

interface ApiKeyFormProps {
  form: KeyFormData;
  setForm: React.Dispatch<React.SetStateAction<KeyFormData>>;
  isEditing: boolean;
  isSaving: boolean;
  availableTemplates: Array<{ id: string; name: string; slug: string }>;
  onCancel: () => void;
  onSubmit: () => void;
  onPresetChange: (preset: ScopePreset) => void;
  onToggleScope: (scope: string) => void;
  onToggleTemplateId: (id: string) => void;
}

export function ApiKeyForm({
  form,
  setForm,
  isEditing,
  isSaving,
  availableTemplates,
  onCancel,
  onSubmit,
  onPresetChange,
  onToggleScope,
  onToggleTemplateId,
}: ApiKeyFormProps) {
  // Escape cancels — unless a SelectMenu or row menu already claimed it at
  // capture (they preventDefault, per the Escape cascade).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const canSubmit = form.name.trim().length > 0 && form.scopes.length > 0 && !isSaving;

  return (
    <div className="flex min-w-0 flex-col gap-7">
      {/* ── Key ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <RowLabel>Name</RowLabel>
          <input
            aria-label="Key name"
            value={form.name}
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            placeholder="My agent"
            className={`${INSET_INPUT_CLASS} w-64`}
            style={INSET_STYLE}
          />
        </div>
        <div className="flex items-center gap-3">
          <RowLabel>Description</RowLabel>
          <input
            aria-label="Key description"
            value={form.description}
            onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
            placeholder="Optional"
            className={`${INSET_INPUT_CLASS} w-64`}
            style={INSET_STYLE}
          />
        </div>
      </section>

      {/* ── Permissions ── */}
      <section className="flex flex-col gap-3">
        <SectionRule label="Permissions" />
        <div className="flex max-w-sm">
          <SegmentedTabs
            tabs={PRESET_TABS}
            active={form.scopePreset}
            onChange={(v) => onPresetChange(v)}
            ariaLabel="Permission preset"
            equalWidth
          />
        </div>
        {/* Named checklist for every preset, not just Custom — a count with
            no names told the reviewer 2 of 19 permissions were on and left
            them guessing which two. Toggling one here already flips
            scopePreset to "custom" (ApiKeysPane's onToggleScope), so this
            list doubles as the Custom editor with no separate mode needed. */}
        <p className="m-0 text-[12px]" style={{ color: "var(--gw-t7)" }}>
          {form.scopes.length} of {SCOPES.length} permissions enabled
        </p>
        <div className="flex flex-col gap-2">
          {SCOPES.map((scope) => (
            <div key={scope} className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-baseline gap-2">
                <span
                  className="text-[12px]"
                  style={{ color: form.scopes.includes(scope) ? "var(--gw-t3)" : "var(--gw-t7)" }}
                >
                  {SCOPE_LABELS[scope as Scope]}
                </span>
                <span className="font-mono text-[10px]" style={{ color: "var(--gw-t8)" }}>
                  {scope}
                </span>
              </div>
              <Toggle
                checked={form.scopes.includes(scope)}
                onChange={() => onToggleScope(scope)}
                aria-label={SCOPE_LABELS[scope as Scope]}
              />
            </div>
          ))}
        </div>
      </section>

      {/* ── Configuration ── */}
      <section className="flex flex-col gap-3">
        <SectionRule label="Configuration" />

        <div className="flex items-center gap-3">
          <RowLabel>All templates</RowLabel>
          <Toggle
            checked={form.allTemplates}
            onChange={(v) => setForm((p) => ({ ...p, allTemplates: v, templateIds: [] }))}
            aria-label="All templates"
          />
          <span className="text-[11.5px]" style={{ color: "var(--gw-t7)" }}>
            {form.allTemplates
              ? "This key can submit to any template"
              : `${form.templateIds.length} template${form.templateIds.length !== 1 ? "s" : ""} selected`}
          </span>
        </div>
        {!form.allTemplates && (
          <div className="flex items-start gap-3">
            <RowLabel top>Templates</RowLabel>
            {availableTemplates.length > 0 ? (
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                {availableTemplates.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate text-[12px]" style={{ color: "var(--gw-t3)" }}>
                        {t.name}
                      </span>
                      <span className="font-mono text-[10px]" style={{ color: "var(--gw-t8)" }}>
                        {t.slug}
                      </span>
                    </div>
                    <Toggle
                      checked={form.templateIds.includes(t.id)}
                      onChange={() => onToggleTemplateId(t.id)}
                      aria-label={t.name}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <span className="pt-1.5 text-[12px]" style={{ color: "var(--gw-t7)" }}>
                No templates available
              </span>
            )}
          </div>
        )}

        <div className="flex items-center gap-3">
          <RowLabel>Callback URL</RowLabel>
          <input
            aria-label="Callback URL"
            value={form.callbackUrl}
            onChange={(e) => setForm((p) => ({ ...p, callbackUrl: e.target.value }))}
            placeholder="https://..."
            className={`${INSET_INPUT_CLASS} w-64 font-mono`}
            style={INSET_STYLE}
          />
        </div>

        <div className="flex items-start gap-3">
          <RowLabel top>Default reviewers</RowLabel>
          <ChipInput
            values={form.defaultReviewers}
            onChange={(next) => setForm((p) => ({ ...p, defaultReviewers: next }))}
            placeholder="email@example.com"
            addPlaceholder="Add another..."
            ariaLabel="Add default reviewer"
          />
        </div>

        <div className="flex items-center gap-3">
          <RowLabel>Rate limit</RowLabel>
          <input
            aria-label="Rate limit per hour"
            value={form.rateLimit}
            onChange={(e) => setForm((p) => ({ ...p, rateLimit: e.target.value.replace(/\D/g, "") }))}
            placeholder="Unlimited"
            className={`${INSET_INPUT_CLASS} w-28`}
            style={INSET_STYLE}
          />
          <span className="text-[11.5px]" style={{ color: "var(--gw-t7)" }}>
            requests per hour
          </span>
        </div>

        <div className="flex items-center gap-3">
          <RowLabel>Expiration</RowLabel>
          <SelectMenu
            value={form.expiration}
            options={EXPIRATION_SELECT}
            onChange={(v) =>
              setForm((p) => ({
                ...p,
                expiration: v as ExpirationPreset,
                expiresAt: v === "custom" ? p.expiresAt : "",
              }))
            }
            ariaLabel="Expiration"
            minWidth={112}
          />
          {form.expiration === "custom" && (
            <input
              type="date"
              aria-label="Expiration date"
              value={form.expiresAt}
              min={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setForm((p) => ({ ...p, expiresAt: e.target.value }))}
              className={`${INSET_INPUT_CLASS} w-40`}
              style={INSET_STYLE}
            />
          )}
        </div>

        <div className="flex items-start gap-3">
          <RowLabel top>IP allowlist</RowLabel>
          <ChipInput
            values={form.ipAllowlist}
            onChange={(next) => setForm((p) => ({ ...p, ipAllowlist: next }))}
            placeholder="10.0.0.0/8 or 1.2.3.4"
            addPlaceholder="Add another..."
            mono
            ariaLabel="Add IP or CIDR"
          />
        </div>
      </section>

      {/* ── Commit ── */}
      <div className="flex items-center justify-end gap-2">
        <GhostButton onClick={onCancel}>Cancel</GhostButton>
        <PrimaryButton onClick={onSubmit} disabled={!canSubmit}>
          {isSaving && <Loader2 size={12} className="mr-1.5 animate-spin" />}
          {isEditing ? "Save" : "Create key"}
        </PrimaryButton>
      </div>
    </div>
  );
}
