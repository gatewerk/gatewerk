import { request } from "./client/http";

export interface StatsResponse {
  total: number;
  by_status: Record<string, number>;
  by_decision: Record<string, number>;
  avg_review_time_ms: number | null;
  by_template: Array<{ template_slug: string; count: number }>;
  reviews_per_day: Array<{ date: string; count: number }>;
}

export async function getStats(): Promise<StatsResponse> {
  return request<StatsResponse>("/api/v1/stats");
}

export const stats = {
  get: getStats,
};
