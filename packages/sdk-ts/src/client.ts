import { ReviewsResource } from "./resources/reviews.js";
import { FeedbackResource } from "./resources/feedback.js";
import { TemplatesResource } from "./resources/templates.js";
import { WebhooksResource } from "./resources/webhooks.js";
import { AuditResource } from "./resources/audit.js";
import { StatsResource } from "./resources/stats.js";
import { ChainsResource } from "./resources/chains.js";
import { NotesResource } from "./resources/notes.js";

export interface ClientConfig {
  apiKey?: string;
  url?: string;
}

export interface GatewerkClient {
  reviews: ReviewsResource;
  feedback: FeedbackResource;
  templates: TemplatesResource;
  webhooks: WebhooksResource;
  audit: AuditResource;
  stats: StatsResource;
  // Wave 2: chains + notes resource coverage. See resources/chains.ts and
  // resources/notes.ts for endpoint mapping.
  chains: ChainsResource;
  notes: NotesResource;
}

export function createClient(config?: ClientConfig): GatewerkClient {
  const apiKey = config?.apiKey || process.env.GATEWERK_API_KEY;
  const url = config?.url || process.env.GATEWERK_URL || "http://localhost:3100";

  if (!apiKey) {
    throw new Error("API key is required. Pass apiKey or set GATEWERK_API_KEY env var.");
  }

  const baseUrl = url.replace(/\/+$/, "");

  const headers = () => ({
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  });

  return {
    reviews: new ReviewsResource(baseUrl, headers),
    feedback: new FeedbackResource(baseUrl, headers),
    templates: new TemplatesResource(baseUrl, headers),
    webhooks: new WebhooksResource(),
    audit: new AuditResource(baseUrl, headers),
    stats: new StatsResource(baseUrl, headers),
    chains: new ChainsResource(baseUrl, headers),
    notes: new NotesResource(baseUrl, headers),
  };
}
