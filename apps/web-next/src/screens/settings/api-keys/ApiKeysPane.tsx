/**
 * ApiKeysPane — list / form / reveal orchestrator.
 *
 * The three views are ONE discriminated union, not three booleans. The reveal
 * view holds a secret that exists nowhere else once the response is dropped,
 * so the state machine is written so no transition can lose it silently:
 * create/rotate either land on {mode:"reveal"} with a verified raw_key, or
 * stay where they are with a loud error (revealFromResult in _forms.ts).
 *
 * List view restyled to the Redesign prototype's grammar (manifest §2.4):
 * PaneHeader, copyable info-card row (base URL / project id / protocol),
 * real OpenAPI/Postman downloads, a quick-start block with a language
 * switcher, then a flat-hairline Keys section. The prototype's row meta
 * vocabulary ("Full access"/"Submit only"/"Read only") is NOT adopted here —
 * this app's existing scope-preset vocabulary (agent/reviewer/admin/custom)
 * is what the rows actually mean, so it stays; only the visual grammar
 * (flat hairline rows, mono meta line, space-separated) is ported.
 *
 * Mutations are plain useMutation + invalidate — no optimistic layer. A
 * settings list has no latency budget that justifies the cache surgery.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Copy, Download, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { SCOPE_PRESETS } from "@gatewerk/shared";
import {
  createApiKeyMutation,
  deleteApiKeyMutation,
  listApiKeys,
  rotateApiKeyMutation,
  sendTestRequestMutation,
  updateApiKeyMutation,
  type ApiKey,
} from "@gatewerk/web-core/api/api-keys";
import { request } from "@gatewerk/web-core/api/client/http";
import { getProjectSettings } from "@gatewerk/web-core/api/projects";
import { downloadFile } from "@gatewerk/web-core/lib/utils";
import { templatesQuery } from "~/route-queries";
import { Modal } from "~/components/Modal";
import { AddLink, EmptyState } from "../../templates/_ui";
import { GreenPill, INFO_CARD, SectionRule } from "../_shared/ui";
import { ApiKeyForm } from "./ApiKeyForm";
import { ApiKeyRow } from "./ApiKeyRow";
import { RevealedKeyPanel } from "./RevealedKeyPanel";
import {
  apiKeyToForm,
  emptyKeyForm,
  formToCreateBody,
  formToUpdateBody,
  revealFromResult,
  type KeyFormData,
  type ScopePreset,
} from "./_forms";

type View =
  | { mode: "list" }
  | { mode: "form"; keyId: string | null }
  | { mode: "reveal"; rawKey: string; name: string };

function assertNever(v: never): never {
  throw new Error(`unreachable view: ${JSON.stringify(v)}`);
}

const QUICK_START_LANGS = ["curl", "MCP", "Python", "Node.js"] as const;
type QuickStartLang = (typeof QUICK_START_LANGS)[number];

/** The `<pre>` block's own font-size/line-height (11.5px / 1.6), so the
 *  computed min-height below tracks it rather than drifting from it. */
const QUICK_START_LINE_HEIGHT = 11.5 * 1.6;
const QUICK_START_V_PADDING = 14 * 2;

// ── downloads/quick-start collapse ──────────────────────────────────────────
//
// Collapsed by default: reference material for wiring up an integration, not
// something read on a daily ops pass through this pane. Remembered in
// localStorage, same convention as theme-store.ts's `readPref`/try-catch (the
// setting is purely a local display preference, not project config, so it
// has no business round-tripping through the API).

const RESOURCES_COLLAPSE_KEY = "gw-api-keys-resources-collapsed";

function readResourcesCollapsed(): boolean {
  try {
    const v = localStorage.getItem(RESOURCES_COLLAPSE_KEY);
    if (v !== null) return v === "1";
  } catch {
    // storage may throw in private mode / sandboxed iframes
  }
  return true;
}

function writeResourcesCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(RESOURCES_COLLAPSE_KEY, collapsed ? "1" : "0");
  } catch {
    // ignore — the toggle still works for the rest of this session
  }
}

function quickStartSnippet(lang: QuickStartLang, origin: string): string {
  switch (lang) {
    case "curl":
      return `curl -X POST ${origin}/api/v1/reviews \\
  -H "Authorization: Bearer gwk_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"template_slug": "deploy-approval", "payload": {"service": "api", "version": "1.2.3"}}'`;
    case "MCP":
      return `{
  "mcpServers": {
    "gatewerk": {
      "command": "npx",
      "args": ["-y", "@gatewerk/mcp"],
      "env": {
        "GATEWERK_API_KEY": "gwk_your_key_here",
        "GATEWERK_API_URL": "${origin}"
      }
    }
  }
}`;
    case "Python":
      return `from gatewerk import Gatewerk

gw = Gatewerk(api_key="gwk_your_key_here")
gw.reviews.create(template_slug="deploy-approval", payload={"service": "api", "version": "1.2.3"})`;
    case "Node.js":
      return `import { Gatewerk } from "@gatewerk/sdk";

const gw = new Gatewerk({ apiKey: "gwk_your_key_here" });
await gw.reviews.create({ templateSlug: "deploy-approval", payload: { service: "api", version: "1.2.3" } });`;
    default:
      return assertNever(lang);
  }
}

/** Copyable info chip — Base URL / Project ID / Protocol (manifest S4.1). */
function InfoCard({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <button
      type="button"
      onClick={onCopy}
      className="gw-focus-ring flex min-w-[150px] flex-1 cursor-pointer items-center justify-between gap-2 border-none text-left transition-colors"
      style={INFO_CARD}
    >
      <span className="min-w-0 flex-1">
        <span
          className="block font-mono text-[9px] font-semibold uppercase"
          style={{ letterSpacing: ".1em", color: "var(--gw-t9)" }}
        >
          {label}
        </span>
        <span className="mt-1 block truncate font-mono text-[12px]" style={{ color: "var(--gw-t3)" }}>
          {value}
        </span>
      </span>
      <Copy size={13} strokeWidth={1.9} className="shrink-0" style={{ color: "var(--gw-t8)" }} />
    </button>
  );
}

export function ApiKeysPane() {
  const queryClient = useQueryClient();

  const [view, setView] = useState<View>({ mode: "list" });
  const [form, setForm] = useState<KeyFormData>(emptyKeyForm());
  const [qsLang, setQsLang] = useState<QuickStartLang>("curl");
  const [resourcesCollapsed, setResourcesCollapsed] = useState(readResourcesCollapsed);

  function toggleResourcesCollapsed() {
    setResourcesCollapsed((collapsed) => {
      const next = !collapsed;
      writeResourcesCollapsed(next);
      return next;
    });
  }

  const { data, isLoading, error } = useQuery(listApiKeys({}));
  const keys = data?.items ?? [];

  const { data: project } = useQuery(getProjectSettings({}));

  const { data: tplData } = useQuery(templatesQuery);
  const availableTemplates = (tplData?.items ?? []).filter(
    (t: { status?: string }) => !t.status || t.status === "active",
  );

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["settings", "api-keys"] });
  }

  function onError(err: unknown) {
    toast.error(err instanceof Error ? err.message : "Request failed");
  }

  const createMutation = useMutation({
    mutationFn: createApiKeyMutation,
    onSuccess: (result, body) => {
      invalidate();
      const reveal = revealFromResult(result, body.name);
      if (reveal) {
        toast.success(`"${body.name}" created`);
        setView({ mode: "reveal", ...reveal });
      } else {
        // The key now exists server side but its secret never reached us.
        // Do NOT pretend otherwise: land on the list, where Rotate can mint
        // a fresh secret for the row that just appeared.
        toast.error(`"${body.name}" was created but no key was returned. Rotate it to get one.`);
        setView({ mode: "list" });
      }
    },
    onError,
  });

  const updateMutation = useMutation({
    mutationFn: updateApiKeyMutation,
    onSuccess: (_r, vars) => {
      invalidate();
      toast.success(`"${vars.name ?? "API key"}" updated`);
      setView({ mode: "list" });
    },
    onError,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteApiKeyMutation,
    onSuccess: () => {
      invalidate();
      toast.success("API key deleted");
    },
    onError,
  });

  const rotateMutation = useMutation({
    mutationFn: rotateApiKeyMutation,
    onSuccess: (result, vars) => {
      invalidate();
      const name = keys.find((k) => k.id === vars.id)?.name || "API key";
      const reveal = revealFromResult(result, name);
      if (reveal) {
        toast.success("Key rotated");
        setView({ mode: "reveal", ...reveal });
      } else {
        toast.error("The key was rotated but no new key was returned. Rotate again.");
      }
    },
    onError,
  });

  const toggleMutation = useMutation({
    mutationFn: updateApiKeyMutation,
    onSuccess: (_r, vars) => {
      invalidate();
      toast.success(vars.is_active ? "API key activated" : "API key deactivated");
    },
    onError,
  });

  const testMutation = useMutation({
    mutationFn: sendTestRequestMutation,
    onSuccess: () => {
      toast.success("Test review created. Check the Inbox.");
    },
    onError,
  });

  function startCreate() {
    setForm(emptyKeyForm());
    setView({ mode: "form", keyId: null });
  }

  function startEdit(key: ApiKey) {
    setForm(apiKeyToForm(key));
    setView({ mode: "form", keyId: key.id });
  }

  function handlePresetChange(preset: ScopePreset) {
    if (preset === "custom") {
      setForm((p) => ({ ...p, scopePreset: "custom" }));
    } else {
      setForm((p) => ({ ...p, scopePreset: preset, scopes: [...SCOPE_PRESETS[preset]] }));
    }
  }

  function toggleScope(scope: string) {
    setForm((p) => {
      const next = p.scopes.includes(scope)
        ? p.scopes.filter((s) => s !== scope)
        : [...p.scopes, scope];
      return { ...p, scopes: next, scopePreset: "custom" };
    });
  }

  function toggleTemplateId(id: string) {
    setForm((p) => ({
      ...p,
      templateIds: p.templateIds.includes(id)
        ? p.templateIds.filter((t) => t !== id)
        : [...p.templateIds, id],
    }));
  }

  function submitForm(keyId: string | null) {
    if (keyId === null) {
      createMutation.mutate(formToCreateBody(form));
    } else {
      updateMutation.mutate({ id: keyId, ...formToUpdateBody(form) });
    }
  }

  function copyToClipboard(value: string, successMessage: string) {
    navigator.clipboard.writeText(value).then(
      () => toast.success(successMessage),
      () => toast.error("Failed to copy"),
    );
  }

  async function downloadSpec(path: string, filename: string, label: string) {
    try {
      const result = await request(path);
      downloadFile(JSON.stringify(result, null, 2), filename, "application/json");
      toast.success(`${label} downloaded`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to download ${label.toLowerCase()}`);
    }
  }

  function renderModal() {
    if (view.mode === "list") return null;
    if (view.mode === "form") {
      return (
        <Modal
          onClose={() => setView({ mode: "list" })}
          ariaLabel={view.keyId !== null ? "Edit API key" : "New API key"}
          title={view.keyId !== null ? "Edit API key" : "New API key"}
          width={640}
        >
          <ApiKeyForm
            form={form}
            setForm={setForm}
            isEditing={view.keyId !== null}
            isSaving={createMutation.isPending || updateMutation.isPending}
            availableTemplates={availableTemplates}
            onCancel={() => setView({ mode: "list" })}
            onSubmit={() => submitForm(view.keyId)}
            onPresetChange={handlePresetChange}
            onToggleScope={toggleScope}
            onToggleTemplateId={toggleTemplateId}
          />
        </Modal>
      );
    }
    if (view.mode === "reveal") {
      // No backdrop-close: this is the one time the raw key exists, and a
      // stray click just outside the card must not be how it's lost. Escape
      // stays enabled (the panel's own doc comment already treats it as a
      // sanctioned exit, same as Done).
      return (
        <Modal
          onClose={() => setView({ mode: "list" })}
          ariaLabel={`Key for ${view.name}`}
          title={`Key for ${view.name}`}
          width={480}
          closeOnBackdrop={false}
        >
          <RevealedKeyPanel rawKey={view.rawKey} name={view.name} onDone={() => setView({ mode: "list" })} />
        </Modal>
      );
    }
    return assertNever(view);
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 size={16} className="animate-spin" style={{ color: "var(--gw-t8)" }} />
      </div>
    );
  }

  if (error) {
    return <EmptyState title="Could not load API keys" hint={error instanceof Error ? error.message : undefined} />;
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  // Sized to the tallest variant (MCP) rather than each snippet's own line
  // count — otherwise switching tabs resizes the box and the API keys list
  // underneath jumps with it.
  const quickStartMinHeight =
    Math.max(...QUICK_START_LANGS.map((lang) => quickStartSnippet(lang, origin).split("\n").length)) *
      QUICK_START_LINE_HEIGHT +
    QUICK_START_V_PADDING;

  return (
    <div className="flex min-w-0 flex-col gap-[22px]">
      <SectionRule label="API keys" right={<GreenPill onClick={startCreate}>New key</GreenPill>} />

      <div className="flex flex-wrap gap-2.5">
        <InfoCard label="Base URL" value={origin} onCopy={() => copyToClipboard(origin, "Base URL copied")} />
        <InfoCard
          label="Project ID"
          value={project?.id ?? ""}
          onCopy={() => project?.id && copyToClipboard(project.id, "Project ID copied")}
        />
        <InfoCard label="Protocol" value="v1" onCopy={() => copyToClipboard("v1", "Protocol copied")} />
      </div>

      {/* Downloads + quick start — reference material, not a daily-ops
          surface, so it starts collapsed and stays that way across visits
          (readResourcesCollapsed/writeResourcesCollapsed above). */}
      <div className="flex flex-col gap-4">
        <button
          type="button"
          onClick={toggleResourcesCollapsed}
          aria-expanded={!resourcesCollapsed}
          className="gw-focus-ring flex cursor-pointer items-center gap-1.5 self-start border-none bg-transparent p-0 font-mono text-[9px] font-semibold uppercase transition-colors"
          style={{ letterSpacing: ".1em", color: "var(--gw-t9)" }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--gw-t6)")}
          onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--gw-t9)")}
        >
          <ChevronRight
            size={11}
            strokeWidth={2.2}
            style={{
              transform: resourcesCollapsed ? "none" : "rotate(90deg)",
              transition: "transform .12s",
            }}
          />
          Downloads &amp; quick start
        </button>

        {!resourcesCollapsed && (
          <>
            <div className="flex items-center gap-5">
              <span
                className="shrink-0 font-mono text-[9px] font-semibold uppercase"
                style={{ letterSpacing: ".1em", color: "var(--gw-t9)" }}
              >
                Downloads
              </span>
              <button
                type="button"
                onClick={() => downloadSpec("/api/v1/openapi.json", "gatewerk-openapi.json", "OpenAPI spec")}
                className="gw-focus-ring flex cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-[12.5px] transition-colors"
                style={{ color: "var(--gw-t4)" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--gw-t2)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--gw-t4)")}
              >
                <Download size={13} strokeWidth={1.9} />
                OpenAPI
              </button>
              <button
                type="button"
                onClick={() => downloadSpec("/api/v1/postman.json", "gatewerk-postman.json", "Postman collection")}
                className="gw-focus-ring flex cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-[12.5px] transition-colors"
                style={{ color: "var(--gw-t4)" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--gw-t2)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.color = "var(--gw-t4)")}
              >
                <Download size={13} strokeWidth={1.9} />
                Postman
              </button>
            </div>

            <div className="flex flex-col gap-2.5">
              <div className="flex items-center gap-3.5">
                <span
                  className="shrink-0 font-mono text-[9px] font-semibold uppercase"
                  style={{ letterSpacing: ".1em", color: "var(--gw-t9)" }}
                >
                  Quick start
                </span>
                <div
                  className="inline-flex gap-0.5 rounded-[9px] p-[3px]"
                  style={{ background: "rgba(var(--gw-hi-rgb),.03)", border: "1px solid rgba(var(--gw-line-rgb),.09)" }}
                >
                  {QUICK_START_LANGS.map((lang) => (
                    <button
                      key={lang}
                      type="button"
                      onClick={() => setQsLang(lang)}
                      className="gw-focus-ring cursor-pointer rounded-[6px] border-none px-2.5 py-1 font-mono text-[11px] transition-colors"
                      style={{
                        background: qsLang === lang ? "rgba(var(--gw-hi-rgb),.10)" : "transparent",
                        color: qsLang === lang ? "var(--gw-t2)" : "var(--gw-t7)",
                        fontWeight: qsLang === lang ? 600 : 500,
                      }}
                    >
                      {lang}
                    </button>
                  ))}
                </div>
              </div>

              <div className="relative">
                <pre
                  className="m-0 overflow-x-auto whitespace-pre-wrap font-mono text-[11.5px]"
                  style={{
                    lineHeight: 1.6,
                    color: "var(--gw-t5)",
                    background: "var(--gw-inset)",
                    border: "1px solid rgba(var(--gw-line-rgb),.08)",
                    borderRadius: 11,
                    padding: "14px 16px",
                    minHeight: quickStartMinHeight,
                  }}
                >
                  {quickStartSnippet(qsLang, origin)}
                </pre>
                <button
                  type="button"
                  title="Copy"
                  onClick={() => copyToClipboard(quickStartSnippet(qsLang, origin), "Copied to clipboard")}
                  className="gw-focus-ring absolute flex cursor-pointer items-center justify-center rounded-[7px] border-none transition-opacity hover:opacity-85"
                  style={{
                    top: 11,
                    right: 11,
                    width: 26,
                    height: 26,
                    // Was a hardcoded rgba(20,20,18,.6) — a fixed near-black floating
                    // on a surface that flips light in light mode (theme-tokens rule).
                    background: "rgba(var(--gw-glass-rgb),.6)",
                  }}
                >
                  <Copy size={13} strokeWidth={1.9} style={{ color: "var(--gw-t4)" }} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="flex flex-col gap-3">

        {keys.length > 0 ? (
          <div className="flex flex-col">
            {keys.map((k) => (
              <ApiKeyRow
                key={k.id}
                apiKey={k}
                onToggle={(v) => toggleMutation.mutate({ id: k.id, is_active: v })}
                onTest={() => testMutation.mutate({ id: k.id })}
                onEdit={() => startEdit(k)}
                onRotate={() => rotateMutation.mutate({ id: k.id })}
                onDelete={() => deleteMutation.mutate({ id: k.id })}
              />
            ))}
          </div>
        ) : (
          <>
            <EmptyState
              title="No API keys yet"
              hint="Each key authorizes one agent or integration to send reviews to this project."
            />
            <div className="flex justify-center">
              <AddLink onClick={startCreate}>
                <Plus size={12} strokeWidth={2} />
                Create key
              </AddLink>
            </div>
          </>
        )}
      </div>

      {renderModal()}
    </div>
  );
}
