import { createDb } from "./index";
import { projects, apiKeys, templates, reviewers, organizations, organizationMemberships } from "./schema/index";
import { randomBytes, createHash } from "crypto";
import { generateId, ALL_SCOPES } from "@gatewerk/shared";
import { eq, count } from "drizzle-orm";

// Duplicated from apps/api/src/lib/generate-api-key.ts — packages/db must not import from apps/api. Keep in sync.
function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const random = randomBytes(32).toString("hex");
  const raw = `gwk_${random}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const prefix = `gwk_${random.slice(0, 8)}`;
  return { raw, hash, prefix };
}

const db = createDb(process.env.DATABASE_URL!);

async function seed() {
  // Idempotency guard: if any user exists the database has already been seeded.
  // Re-running seed on a populated DB would create duplicate orgs/projects/templates
  // and trip the unique-email constraint on the admin reviewer.
  const [{ value: userCount }] = await db.select({ value: count() }).from(reviewers);
  if (userCount > 0) {
    console.log("seed: users present, skipping");
    process.exit(0);
  }

  console.log("Seeding database...");

  // Create default project
  const [project] = await db.insert(projects).values({
    id: generateId("project"),
    name: "Demo Project",
    description: "Default project for testing",
    hmac_secret: randomBytes(32).toString("hex"),
  }).returning();

  // Create default organization
  const orgId = generateId("org");
  await db.insert(organizations).values({
    id: orgId,
    name: "Default Organization",
    slug: "default",
    cloud_config: null, // null = OSS standalone mode
  });

  // Link project to organization
  await db
    .update(projects)
    .set({ organization_id: orgId })
    .where(eq(projects.id, project.id));

  // Create API key (gwk_ prefix, required by api-key-auth middleware)
  const { raw: rawKey, hash: keyHash, prefix: keyPrefix } = generateApiKey();
  await db.insert(apiKeys).values({
    id: generateId("api_key"),
    project_id: project.id,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    label: "Default key",
    scopes: ALL_SCOPES,
  });

  // Create demo template
  await db.insert(templates).values({
    id: generateId("template"),
    slug: "proposal-review",
    project_id: project.id,
    name: "Proposal Review",
    description: "Review AI-generated proposals before sending",
    fields: [
      { name: "job_title", type: "text", label: "Job Title", readonly: true },
      { name: "proposal", type: "markdown", label: "Proposal", editable: true },
      { name: "confidence", type: "number", label: "Confidence", readonly: true },
    ],
    actions: ["approve", "edit", "reject", "retry"],
    default_priority: "normal",
  });

  // 5 pre-built templates
  await db.insert(templates).values([
    {
      id: generateId("template"),
      slug: "email-review",
      project_id: project.id,
      name: "Email Review",
      description: "Review AI-drafted emails before sending",
      fields: [
        { name: "to", type: "text", label: "To", readonly: true },
        { name: "subject", type: "text", label: "Subject", editable: true },
        { name: "body", type: "markdown", label: "Body", editable: true },
        { name: "tone", type: "select", label: "Tone", options: ["formal", "casual", "friendly"], readonly: true },
      ],
      actions: ["approve", "edit", "reject", "retry"],
      default_priority: "normal",
    },
    {
      id: generateId("template"),
      slug: "code-deploy",
      project_id: project.id,
      name: "Code Deploy",
      description: "Approve code deployments to production",
      fields: [
        { name: "service", type: "text", label: "Service", readonly: true },
        { name: "version", type: "text", label: "Version", readonly: true },
        { name: "changelog", type: "markdown", label: "Changelog", readonly: true },
        { name: "environment", type: "select", label: "Environment", options: ["staging", "production"], readonly: true },
      ],
      actions: ["approve", "reject"],
      default_priority: "high",
    },
    {
      id: generateId("template"),
      slug: "content-approval",
      project_id: project.id,
      name: "Content Approval",
      description: "Review AI-generated content before publishing",
      fields: [
        { name: "title", type: "text", label: "Title", editable: true },
        { name: "content", type: "markdown", label: "Content", editable: true },
        { name: "platform", type: "select", label: "Platform", options: ["blog", "social", "docs", "newsletter"], readonly: true },
      ],
      actions: ["approve", "edit", "reject", "retry"],
      default_priority: "normal",
    },
    {
      id: generateId("template"),
      slug: "expense-report",
      project_id: project.id,
      name: "Expense Report",
      description: "Approve or reject expense claims",
      fields: [
        { name: "employee", type: "text", label: "Employee", readonly: true },
        { name: "amount", type: "number", label: "Amount ($)", readonly: true },
        { name: "category", type: "select", label: "Category", options: ["travel", "software", "hardware", "meals", "other"], readonly: true },
        { name: "description", type: "text", label: "Description", readonly: true },
        { name: "receipt", type: "image", label: "Receipt", readonly: true },
      ],
      actions: ["approve", "reject"],
      default_priority: "normal",
    },
    {
      id: generateId("template"),
      slug: "customer-reply",
      project_id: project.id,
      name: "Customer Reply",
      description: "Review AI-drafted customer support replies",
      fields: [
        { name: "customer_name", type: "text", label: "Customer", readonly: true },
        { name: "ticket_id", type: "text", label: "Ticket ID", readonly: true },
        { name: "original_message", type: "markdown", label: "Customer Message", readonly: true },
        { name: "draft_reply", type: "markdown", label: "Draft Reply", editable: true },
        { name: "sentiment", type: "select", label: "Sentiment", options: ["positive", "neutral", "negative", "urgent"], readonly: true },
      ],
      actions: ["approve", "edit", "reject", "retry"],
      default_priority: "normal",
    },
  ]);

  // Create admin reviewer using argon2id (OWASP 2025)
  const argon2 = await import("argon2");
  const hash = await argon2.hash("admin123", {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  await db.insert(reviewers).values({
    id: generateId("user"),
    email: "admin@gatewerk.local",
    name: "Admin",
    password_hash: hash,
    role: "admin",
    must_change_password: true,
  });

  // Add admin as organization owner
  const [adminUser] = await db
    .select()
    .from(reviewers)
    .where(eq(reviewers.email, "admin@gatewerk.local"))
    .limit(1);

  if (adminUser) {
    await db.insert(organizationMemberships).values({
      id: generateId("omem"),
      organization_id: orgId,
      user_id: adminUser.id,
      role: "owner",
    });
  }

  console.log("\nSeed complete!");
  console.log(`Organization: ${orgId} (default)`);
  console.log(`Project: ${project.name} (${project.id})`);
  console.log(`API Key: ${rawKey}`);
  console.log("Admin login: admin@gatewerk.local / admin123");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
