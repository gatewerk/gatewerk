/**
 * Create/edit form for one webhook. Rendered inside WebhooksPane's `Modal`
 * (~/components/Modal), same as ApiKeyForm — the list stays mounted and
 * dimmed behind it. Escape cancels, and the ONLY green element is the button
 * that commits — matching ApiKeyForm.
 *
 * Grammar: SectionRule per section (the Redesign prototype's mono-uppercase
 * hairline header, manifest §2.0), RowLabel + inset controls per row. Event
 * selection is a Toggle list (Permissions' custom-scopes grammar in
 * ApiKeyForm), not the reference's colored pill buttons — event selection is
 * a configuration fact, not live attention, and the doctrine reserves color
 * for the latter.
 */
import { useEffect } from "react";
import { Loader2, Plus, Send, Trash2 } from "lucide-react";
import type { NotificationChannelType } from "@gatewerk/shared";
import { Field } from "../../../components/field/Field";
import { TextInput } from "../../../components/field/inputs";
import {
  AddLink,
  GhostButton,
  IconButton,
  INSET_INPUT_CLASS,
  INSET_STYLE,
  PrimaryButton,
  RowLabel,
  SelectMenu,
} from "../../templates/_ui";
import { SectionRule } from "../_shared/ui";
import { Toggle } from "../_shared/Toggle";
import { AVAILABLE_EVENTS, CHANNEL_TYPE_OPTIONS, channelPlaceholder, type WebhookFormData } from "./webhooks-logic";

const TYPE_SELECT = CHANNEL_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }));

interface WebhookFormProps {
  form: WebhookFormData;
  setForm: React.Dispatch<React.SetStateAction<WebhookFormData>>;
  isEditing: boolean;
  isSaving: boolean;
  isTesting: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  onTest: () => void;
}

export function WebhookForm({
  form,
  setForm,
  isEditing,
  isSaving,
  isTesting,
  onCancel,
  onSubmit,
  onTest,
}: WebhookFormProps) {
  // Escape cancels — unless a SelectMenu already claimed it at capture (it
  // preventDefaults, per the Escape cascade in ApiKeyForm).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const canSubmit =
    form.name.trim().length > 0 && form.webhookUrl.trim().length > 0 && form.events.length > 0 && !isSaving;

  function toggleEvent(value: string) {
    setForm((p) => ({
      ...p,
      events: p.events.includes(value) ? p.events.filter((e) => e !== value) : [...p.events, value],
    }));
  }

  function updateHeader(i: number, field: "key" | "value", val: string) {
    setForm((p) => ({ ...p, headers: p.headers.map((h, idx) => (idx === i ? { ...h, [field]: val } : h)) }));
  }

  function removeHeader(i: number) {
    setForm((p) => ({ ...p, headers: p.headers.filter((_, idx) => idx !== i) }));
  }

  return (
    <div className="flex min-w-0 flex-col gap-7">
      {/* ── Webhook ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <RowLabel>Name</RowLabel>
          <input
            aria-label="Webhook name"
            value={form.name}
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            placeholder="Slack notifications"
            className={`${INSET_INPUT_CLASS} w-64`}
            style={INSET_STYLE}
          />
        </div>
        <div className="flex items-center gap-3">
          <RowLabel>Type</RowLabel>
          <SelectMenu
            value={form.type}
            options={TYPE_SELECT}
            onChange={(v) => setForm((p) => ({ ...p, type: v as NotificationChannelType }))}
            ariaLabel="Webhook type"
            minWidth={140}
          />
        </div>
        <div className="flex items-center gap-3">
          <RowLabel>Webhook URL</RowLabel>
          <input
            aria-label="Webhook URL"
            value={form.webhookUrl}
            onChange={(e) => setForm((p) => ({ ...p, webhookUrl: e.target.value }))}
            placeholder={channelPlaceholder(form.type)}
            className={`${INSET_INPUT_CLASS} w-full font-mono`}
            style={INSET_STYLE}
          />
        </div>
      </section>

      {/* ── Events ── */}
      <section className="flex flex-col gap-3">
        <SectionRule label="Events" />
        <div className="flex flex-col gap-2">
          {AVAILABLE_EVENTS.map((evt) => (
            <div key={evt.value} className="flex items-center justify-between gap-3">
              <span
                className="text-[12px]"
                style={{ color: form.events.includes(evt.value) ? "var(--gw-t3)" : "var(--gw-t7)" }}
              >
                {evt.label}
              </span>
              <Toggle
                checked={form.events.includes(evt.value)}
                onChange={() => toggleEvent(evt.value)}
                aria-label={evt.label}
              />
            </div>
          ))}
        </div>
      </section>

      {/* ── Headers ── */}
      <section className="flex flex-col gap-3">
        <SectionRule label="Custom headers" />
        {form.headers.length > 0 && (
          <div className="flex flex-col gap-2">
            {form.headers.map((h, i) => (
              <div key={i} className="flex items-center gap-2">
                <Field label="Header name" hideLabel className="flex-1">
                  <TextInput
                    value={h.key}
                    onChange={(e) => updateHeader(i, "key", e.target.value)}
                    placeholder="Header-Name"
                    className="font-mono"
                  />
                </Field>
                <Field label="Header value" hideLabel className="flex-1">
                  <TextInput
                    value={h.value}
                    onChange={(e) => updateHeader(i, "value", e.target.value)}
                    placeholder="Value"
                  />
                </Field>
                <IconButton title="Remove header" onClick={() => removeHeader(i)} size={26}>
                  <Trash2 size={12} strokeWidth={1.9} />
                </IconButton>
              </div>
            ))}
          </div>
        )}
        <AddLink onClick={() => setForm((p) => ({ ...p, headers: [...p.headers, { key: "", value: "" }] }))}>
          <Plus size={12} strokeWidth={2} />
          Add header
        </AddLink>
      </section>

      {/* ── Commit ── */}
      <div className="flex items-center justify-end gap-2">
        <GhostButton onClick={onTest} disabled={!form.webhookUrl.trim() || isTesting}>
          {isTesting ? (
            <Loader2 size={12} className="mr-1.5 animate-spin" />
          ) : (
            <Send size={12} className="mr-1.5" />
          )}
          Send test
        </GhostButton>
        <GhostButton onClick={onCancel}>Cancel</GhostButton>
        <PrimaryButton onClick={onSubmit} disabled={!canSubmit}>
          {isSaving && <Loader2 size={12} className="mr-1.5 animate-spin" />}
          {isEditing ? "Save" : "Create webhook"}
        </PrimaryButton>
      </div>
    </div>
  );
}
