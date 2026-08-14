import { asc, eq } from "drizzle-orm";
import { projects, reviews as reviewsTable } from "@gatewerk/db/src/schema/index";
import type { AppDb } from "@gatewerk/db";

/**
 * Resolve the project id for the current request.
 *
 * API key auth sets `req.projectId` directly — it always wins. Session auth
 * (JWT) leaves it unset, so we fall back per the third argument:
 *   - `reviewId` provided → look it up from that review's `project_id`
 *   - `reviewId` omitted   → use the OLDEST project by `created_at` (the
 *     OSS single-project default; deterministic in multi-project test
 *     setups thanks to the explicit ORDER BY)
 *
 * Review routes pass the review id from the URL because session-authed admins
 * may act on reviews from any project — without that fallback they could only
 * touch the "first project". Settings/templates/connections routes are scoped
 * to the active project anyway, so they take the first-project default.
 *
 * TODO(cloud-multi-project): the oldest-project fallback is correct for OSS
 * single-project deployments but unsafe for Cloud where a session admin
 * should resolve to *their* active project, not whichever project the org
 * created first. The cloud-active-project mechanism (user_projects +
 * auth_id + req.activeProjectId) lands with Cloud Solo M22-M32; until then,
 * a session admin in a multi-project deployment will only see the oldest
 * project's data via this fallback. Use API-key auth for cross-project
 * reads in the meantime.
 */
export async function resolveProjectId(
  req: any,
  db: AppDb,
  reviewId?: string
): Promise<string | null> {
  if (req.projectId) return req.projectId;

  if (reviewId) {
    const [review] = await db
      .select({ project_id: reviewsTable.project_id })
      .from(reviewsTable)
      .where(eq(reviewsTable.id, reviewId))
      .limit(1);
    return review?.project_id ?? null;
  }

  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .orderBy(asc(projects.created_at))
    .limit(1);
  return project?.id ?? null;
}
