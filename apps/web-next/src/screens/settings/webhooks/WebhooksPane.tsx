/**
 * WebhooksPane — list / form orchestrator, restyled to the Redesign
 * prototype's Settings grammar (manifest §2.5): PaneHeader, a signing-secret
 * card, then an "Endpoints" SectionRule with the pane's one green primary
 * ("New webhook") and flat hairline endpoint rows.
 *
 * Two views, one discriminated union: the list (always mounted) and the
 * create/edit form, which opens in a `Modal` (~/components/Modal) on top of
 * it rather than replacing it. Test doesn't get a third view — it fires from the row
 * menu (an existing webhook: reuses its saved url/type/headers, no need to
 * open the form) or from inside the form (an unsaved draft: uses the fields
 * on screen right now), and either way lands as a toast, never a persisted
 * view of its own.
 *
 * Mutations are plain useMutation + invalidate, matching ApiKeysPane — no
 * optimistic layer. apps/web's
 * WebhooksSection uses useOptimisticMutation; that cache-surgery layer isn't
 * ported here for the same reason its form types aren't imported: apps/web
 * is frozen, and every additional import into it is one more module the
 * eventual deletion has to unpick.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  createWebhookMutation,
  deleteWebhookMutation,
  listWebhooks,
  testWebhookMutation,
  updateWebhookMutation,
  type Webhook,
} from "@gatewerk/web-core/api/webhooks";
import { Modal } from "~/components/Modal";
import { EmptyState } from "../../templates/_ui";
import { GreenPill, SectionRule } from "../_shared/ui";
import { SigningSecretCard } from "./SigningSecretCard";
import { WebhookForm } from "./WebhookForm";
import { WebhookRow } from "./WebhookRow";
import {
  emptyWebhookForm,
  formToCreateBody,
  formToTestBody,
  formToUpdateBody,
  testToastMessage,
  webhookToForm,
  type WebhookFormData,
} from "./webhooks-logic";

type View = { mode: "list" } | { mode: "form"; webhookId: string | null };

function assertNever(v: never): never {
  throw new Error(`unreachable view: ${JSON.stringify(v)}`);
}

export function WebhooksPane() {
  const queryClient = useQueryClient();

  const [view, setView] = useState<View>({ mode: "list" });
  const [form, setForm] = useState<WebhookFormData>(emptyWebhookForm());

  const { data, isLoading, error } = useQuery(listWebhooks({}));
  const webhooksList = data?.items ?? [];

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["settings", "webhooks"] });
  }

  function onError(err: unknown) {
    toast.error(err instanceof Error ? err.message : "Request failed");
  }

  const createMutation = useMutation({
    mutationFn: createWebhookMutation,
    onSuccess: (_result, body) => {
      invalidate();
      toast.success(`"${body.name}" created`);
      setView({ mode: "list" });
    },
    onError,
  });

  const updateMutation = useMutation({
    mutationFn: updateWebhookMutation,
    onSuccess: (_result, vars) => {
      invalidate();
      toast.success(`"${vars.name ?? "Webhook"}" updated`);
      setView({ mode: "list" });
    },
    onError,
  });

  const deleteMutation = useMutation({
    mutationFn: deleteWebhookMutation,
    onSuccess: (_result, vars) => {
      invalidate();
      const name = webhooksList.find((w) => w.id === vars.id)?.name || "Webhook";
      toast.success(`"${name}" deleted`);
    },
    onError,
  });

  const toggleMutation = useMutation({
    mutationFn: updateWebhookMutation,
    onSuccess: (_result, vars) => {
      invalidate();
      toast.success(vars.is_active ? "Webhook activated" : "Webhook deactivated");
    },
    onError,
  });

  const testMutation = useMutation({
    mutationFn: testWebhookMutation,
    onSuccess: (result) => {
      const outcome = testToastMessage(result);
      if (outcome.kind === "success") toast.success(outcome.message);
      else toast.error(outcome.message);
    },
    onError,
  });

  function startCreate() {
    setForm(emptyWebhookForm());
    setView({ mode: "form", webhookId: null });
  }

  function startEdit(w: Webhook) {
    setForm(webhookToForm(w));
    setView({ mode: "form", webhookId: w.id });
  }

  function submitForm(webhookId: string | null) {
    if (webhookId === null) {
      createMutation.mutate(formToCreateBody(form));
    } else {
      updateMutation.mutate({ id: webhookId, ...formToUpdateBody(form) });
    }
  }

  function testExisting(w: Webhook) {
    testMutation.mutate({ webhook_url: w.webhook_url, type: w.type, headers: w.headers ?? undefined });
  }

  function renderModal() {
    if (view.mode === "list") return null;
    if (view.mode === "form") {
      return (
        <Modal
          onClose={() => setView({ mode: "list" })}
          ariaLabel={view.webhookId !== null ? "Edit webhook" : "New webhook"}
          title={view.webhookId !== null ? "Edit webhook" : "New webhook"}
          width={640}
        >
          <WebhookForm
            form={form}
            setForm={setForm}
            isEditing={view.webhookId !== null}
            isSaving={createMutation.isPending || updateMutation.isPending}
            isTesting={testMutation.isPending}
            onCancel={() => setView({ mode: "list" })}
            onSubmit={() => submitForm(view.webhookId)}
            onTest={() => testMutation.mutate(formToTestBody(form))}
          />
        </Modal>
      );
    }
    return assertNever(view);
  }

  return (
    <div className="flex min-w-0 flex-col gap-[22px]">
      <SectionRule label="Webhooks" right={<GreenPill onClick={startCreate}>New webhook</GreenPill>} />

      <SigningSecretCard />

      <div className="flex flex-col gap-3">

        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 size={16} className="animate-spin" style={{ color: "var(--gw-t8)" }} />
          </div>
        ) : error ? (
          <EmptyState title="Could not load webhooks" hint={error instanceof Error ? error.message : undefined} />
        ) : webhooksList.length > 0 ? (
          <div className="flex flex-col">
            {webhooksList.map((w) => (
              <WebhookRow
                key={w.id}
                webhook={w}
                onToggle={(v) => toggleMutation.mutate({ id: w.id, is_active: v })}
                onTest={() => testExisting(w)}
                onEdit={() => startEdit(w)}
                onDelete={() => deleteMutation.mutate({ id: w.id })}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title="No webhooks yet"
            hint="Send review events to your own endpoints when decisions are made."
          />
        )}
      </div>

      {renderModal()}
    </div>
  );
}
