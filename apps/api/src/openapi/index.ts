// Builds the OpenAPI 3.1 document for the Gatewerk public API surface.
//
// components.schemas is sourced from `registry.generateComponents()` — the
// central OpenAPIRegistry collects all Zod schema registrations from
// per-domain modules under ./components/schemas/. The registrations fire as
// side effects when those modules are imported (see line ~55 below).
//
// paths are still hand-authored object literals in ./paths/ and spread into
// the document; migrating them to `registry.registerPath()` is tracked in
// a follow-up.
//
// Drift rule (spec §5): every new/changed route must update the corresponding
// path file and Zod schema in the same PR.
//
// Covers the public, API-key-authenticated surface:
//   - Reviews CRUD + lifecycle (create, list, get, update, decide, retry,
//     cancel-request, archive/unarchive, delete, versions, tokens, bulk ops)
//   - Templates CRUD + publish/pause/resume
//   - Stats, Feedback, Audit, Webhook deliveries
//   - Key introspection + version info
//
// Excluded (session-only, not for agent consumers):
//   - /auth/login, /auth/me
//   - /settings/* (API key & webhook management, HMAC secret)
//   - review notes and draft endpoints (reviewer-only)

import { VERSION } from "@gatewerk/shared";
import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";

import { metaPaths } from "./paths/meta";
import { reviewPaths } from "./paths/reviews";
import { templatePaths } from "./paths/templates";
import { feedbackPaths } from "./paths/feedback";
import { statsPaths } from "./paths/stats";
import { auditPaths } from "./paths/audit";
import { webhookPaths } from "./paths/webhooks";

import { securitySchemes } from "./components/security-schemes";
import { parameters } from "./components/parameters";
import { responses } from "./components/responses";
import { registry } from "./registry";
// side-effect: registers all Zod schemas with the central OpenAPIRegistry
import "./components/schemas/reviews";
import "./components/schemas/shared";
import "./components/schemas/templates";
import "./components/schemas/reports";

// unionPreferredType: "oneOf" matches the hand-authored snapshot's nullable
// encoding (oneOf:[$ref,{type:"null"}]). Default anyOf would diff against
// snapshot at every nullable ref site.
const generator = new OpenApiGeneratorV31(registry.definitions, {
  unionPreferredType: "oneOf",
});
const generatedComponents = generator.generateComponents();
const generatedSchemas = generatedComponents.components?.schemas as Record<string, unknown> | undefined;
if (!generatedSchemas || Object.keys(generatedSchemas).length === 0) {
  throw new Error(
    "OpenAPIRegistry produced empty components.schemas — schema side-effect imports failed to register Zod schemas",
  );
}

export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Gatewerk API",
    version: VERSION,
    summary: "Human review oversight for AI agents.",
    description:
      "Work done for humans is decided by humans. " +
      "Gatewerk is a self-hosted human-review gateway. Agents POST review " +
      "requests; reviewers approve, reject, or request changes; decisions " +
      "flow back via webhook or polling. This spec covers the HTTP surface " +
      "for agents (API-key auth). Session endpoints used by the dashboard " +
      "are intentionally omitted.",
    contact: { name: "Gatewerk", url: "https://gatewerk.com" },
    license: { name: "Apache-2.0", identifier: "Apache-2.0" },
  },
  servers: [
    { url: "https://api.gatewerk.com", description: "Hosted / default" },
    { url: "http://localhost:3001", description: "Local self-host" },
  ],
  tags: [
    { name: "Reviews", description: "Create, list, decide, and manage reviews." },
    { name: "Templates", description: "Define the shape of review payloads." },
    { name: "Feedback", description: "Query decided reviews for learning loops." },
    { name: "Stats", description: "Aggregate counts and throughput metrics." },
    { name: "Audit", description: "Immutable log of actions on this project." },
    { name: "Webhooks", description: "Inspect outbound delivery attempts." },
    { name: "Meta", description: "Version info and key introspection." },
  ],
  security: [{ bearerAuth: [] }],
  paths: {
    ...metaPaths,
    ...reviewPaths,
    ...templatePaths,
    ...feedbackPaths,
    ...statsPaths,
    ...auditPaths,
    ...webhookPaths,
  },
  components: {
    securitySchemes,
    parameters,
    responses,
    schemas: generatedSchemas,
  },
} as const;

export type OpenApiDocument = typeof openApiDocument;
