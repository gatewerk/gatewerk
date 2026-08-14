import { useQuery } from "@tanstack/react-query";
import { request } from "@gatewerk/web-core/api/client/http";

export interface TemplateStats {
  total_reviews: number;
  human_decided: number;
  auto_approved: number;
  vetoed: number;
  confirmed_human: number;
  window_elapsed: number;
  pending_now: number;
  waiting_now: number;
  approval_rate: number | null;
  rejection_rate: number | null;
  edit_rate: number | null;
  avg_decision_minutes: number | null;
}

// Best-effort stats fetch. UX falls back to "No reviews yet" on any error, so we
// log failures but don't surface them; auth flows through `request()` which picks
// up the token via `getToken()` from http.ts (both storage layers supported).
export function useTemplateStats(templateId: string | undefined) {
  const enabled = !!templateId && !templateId.startsWith("draft_");
  return useQuery({
    queryKey: ["templates", "stats", templateId ?? "(none)"],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      try {
        return await request<TemplateStats>(`/api/v1/templates/${encodeURIComponent(templateId!)}/stats`);
      } catch (err) {
        console.warn("[useTemplateStats] fetch failed:", err);
        return null;
      }
    },
  });
}
