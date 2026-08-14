import { toast } from "sonner";
import type { useNavigate } from "react-router";
import type { useQueryClient } from "@tanstack/react-query";
import { eventKey, shouldShowToast, type LiveEvent } from "./live-events";

// Pure dispatch logic for incoming SSE LiveEvent payloads. Extracted from
// Layout.tsx so unit tests can verify invalidation + toast behaviour
// without rendering the full Layout shell (which pulls in react-router,
// lucide-react, etc. and requires a DOM mount).

export type LiveEventCtx = {
  navigate: ReturnType<typeof useNavigate>;
  queryClient: ReturnType<typeof useQueryClient>;
};

export function handleLiveEvent(event: LiveEvent, { navigate, queryClient }: LiveEventCtx): void {
  if (event.type === "open") return;

  // Invalidate any review query so list counts and detail pages resync with
  // server state. Targeted key prefix `["reviews"]` covers list, pending,
  // detail, and notes caches without nuking templates/settings.
  queryClient.invalidateQueries({ queryKey: ["reviews"] });

  // Chain context invalidation. When
  // the wire payload carries chain_run_id, the review is part of an
  // active chain and the per-review chain panel cache
  // (queryKey: ["review-chain", reviewId]) must refresh so the stepper
  // reflects the latest step state without waiting on the 30s staleTime.
  // Non-chain events (chain_run_id undefined on the wire) skip this so
  // the chain queryKey for unrelated reviews stays warm.
  if (event.chain_run_id) {
    queryClient.invalidateQueries({ queryKey: ["review-chain", event.review_id] });
  }

  // Invalidate the deliveries cache for this review when a veto or confirmed
  // delivery fails so the failure banners in ReviewPane show immediately.
  if (event.type === "review.veto_delivery_failed" || event.type === "review.confirmed_delivery_failed") {
    queryClient.invalidateQueries({ queryKey: ["deliveries", event.review_id] });
  }

  // Only fire a toast on inbound reviews and escalations — decided/expired
  // events are invalidation-only (the reviewer rarely needs a toast for
  // their own action). shouldShowToast keeps only the first tab in a
  // multi-tab session from toasting the same event.
  // review.monitoring_created toasts so operators know the veto window is open.
  const notify = event.type === "review.created" || event.type === "review.urgent" || event.type === "review.monitoring_created";
  if (!notify) return;
  if (!shouldShowToast(eventKey(event), localStorage)) return;

  const reviewId = event.review_id;
  toast.info(`New review: ${event.template_slug}`, {
    action: {
      label: "View",
      onClick: () => navigate(`/?review=${reviewId}`, { viewTransition: true }),
    },
  });
}
