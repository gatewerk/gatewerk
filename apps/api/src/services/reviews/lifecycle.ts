import { eq, and, inArray } from "drizzle-orm";
import { reviews, reviewVersions } from "@gatewerk/db/src/schema/index";
import {
  generateId,
  NotFoundError,
  ConflictError,
  isIterationStatus,
} from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import { findReview, notInLiveChain } from "./_queries";

export function createReviewLifecycleSlice(db: AppDb) {
  return {
    async archive(projectId: string, id: string) {
      const result = await db
        .update(reviews)
        .set({ status: "archived", updated_at: new Date() })
        .where(and(
          eq(reviews.id, id),
          eq(reviews.project_id, projectId),
          inArray(reviews.status, ["decided", "expired"]),
          // Same guard the bulk path carries, for the same reason: a step's
          // review can be 'decided' while its chain_steps row is still
          // 'active', and archiving flips the status to a value
          // chain-engine-reconcile skips while review_id stays set, so the
          // orphan-halt branch never fires either. The run is then active with
          // no reviewable review, permanently. Adding it only to bulkArchive
          // left the same strand one POST away.
          notInLiveChain(db),
        ))
        .returning();
      if (result.length === 0) throw new NotFoundError("Review not found or not in archivable state", "review_not_found");
      return result[0];
    },

    async unarchive(projectId: string, id: string) {
      const [existing] = await db
        .select({ decided_at: reviews.decided_at })
        .from(reviews)
        .where(and(eq(reviews.id, id), eq(reviews.project_id, projectId), eq(reviews.status, "archived")))
        .limit(1);
      if (!existing) throw new NotFoundError("Review not found or not archived", "review_not_found");

      const restoreStatus = existing.decided_at ? "decided" : "expired";
      const [result] = await db
        .update(reviews)
        .set({ status: restoreStatus, updated_at: new Date() })
        .where(and(eq(reviews.id, id), eq(reviews.project_id, projectId), eq(reviews.status, "archived")))
        .returning();
      if (!result) throw new NotFoundError("Review not found or not archived", "review_not_found");
      return result;
    },

    async updateVersion(projectId: string, id: string, data: {
      payload: Record<string, unknown>;
      version: number;
    }) {
      return await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(reviews)
          .where(and(eq(reviews.id, id), eq(reviews.project_id, projectId)))
          .for("update")
          .limit(1);

        if (!existing) {
          throw new NotFoundError("Review not found", "review_not_found");
        }

        if (existing.status === "decided") {
          throw new ConflictError("Review already decided. Cannot submit new version.", "review_already_decided");
        }
        if (existing.status === "expired") {
          throw new ConflictError("Review expired. Cannot submit new version.", "review_expired");
        }
        if (!isIterationStatus(existing.status)) {
          throw new ConflictError("Review is not awaiting changes.", "not_awaiting_changes");
        }

        const nextVersion = existing.current_version + 1;

        await tx.insert(reviewVersions).values({
          id: generateId("version"),
          review_id: id,
          version: nextVersion,
          payload: data.payload,
          feedback: existing.feedback,
        });

        const [updated] = await tx
          .update(reviews)
          .set({
            status: "pending",
            payload: data.payload,
            suggested_value: data.payload,
            current_version: nextVersion,
            feedback: null,
            prompt_edit: null,
            updated_at: new Date(),
          })
          .where(and(eq(reviews.id, id), eq(reviews.project_id, projectId)))
          .returning();

        return updated;
      });
    },

  };
}
