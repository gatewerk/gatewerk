import type { TemplateField, TemplateCreateBody } from "@gatewerk/shared";

// StarterTemplateField is a strict subset of the server's TemplateField shape.
// Using Pick ensures TypeScript catches any upstream field renames at compile time.
export type StarterTemplateField = Pick<TemplateField, "name" | "type" | "label">;

// StarterTemplate.draft is typed as a Pick over TemplateCreateBody so that any
// field the server adds to the create schema is not silently dropped here.
// We omit slug (server-generated from name) and chain_config (not used in starters).
export type StarterTemplate = {
  id: string;
  display_name: string;
  blurb: string;
  draft: Pick<TemplateCreateBody, "name" | "description" | "default_priority" | "fields">;
};

export const STARTER_TEMPLATES = [
  {
    id: "proposal_review",
    display_name: "Proposal review",
    blurb: "Customer-facing proposals: scope, pricing, terms.",
    draft: {
      name: "Proposal review",
      description: "Review proposals before they are sent to a customer.",
      default_priority: "high",
      fields: [
        { name: "customer", type: "text", label: "Customer" },
        { name: "scope", type: "markdown", label: "Scope of work" },
        { name: "pricing", type: "markdown", label: "Pricing" },
        { name: "terms", type: "markdown", label: "Terms" },
      ],
    },
  },
  {
    id: "content_approval",
    display_name: "Content approval",
    blurb: "Blog posts, social copy, marketing assets.",
    draft: {
      name: "Content approval",
      description: "Approve marketing or editorial content before publishing.",
      default_priority: "normal",
      fields: [
        { name: "title", type: "text", label: "Title" },
        { name: "body", type: "markdown", label: "Body" },
        { name: "destination", type: "text", label: "Destination channel" },
      ],
    },
  },
  {
    id: "code_change_review",
    display_name: "Code change review",
    blurb: "PR descriptions, refactor proposals, diff summaries.",
    draft: {
      name: "Code change review",
      description: "Review a proposed code change before it is merged or deployed.",
      default_priority: "normal",
      fields: [
        { name: "summary", type: "markdown", label: "Change summary" },
        { name: "diff", type: "markdown", label: "Diff or patch" },
        { name: "risk_notes", type: "markdown", label: "Risk and rollback notes" },
      ],
    },
  },
  {
    id: "marketing_copy_review",
    display_name: "Marketing copy review",
    blurb: "Ad copy, landing-page headlines, email subjects.",
    draft: {
      name: "Marketing copy review",
      description: "Approve marketing copy before it ships in a campaign.",
      default_priority: "low",
      fields: [
        { name: "surface", type: "text", label: "Surface" },
        { name: "headline", type: "text", label: "Headline" },
        { name: "subhead", type: "text", label: "Subhead" },
        { name: "body", type: "markdown", label: "Body copy" },
      ],
    },
  },
] as const satisfies ReadonlyArray<StarterTemplate>;

export type StarterTemplateId = (typeof STARTER_TEMPLATES)[number]["id"];

export function starterTemplateById(id: StarterTemplateId): StarterTemplate {
  return STARTER_TEMPLATES.find((s) => s.id === id)!;
}
