import type { AppDb } from "@gatewerk/db";
import { createReviewCrudSlice } from "./crud";
import { createReviewDecideSlice } from "./decide";
import { createReviewLifecycleSlice } from "./lifecycle";
import { createReviewBulkSlice } from "./bulk";

// Composes four cohesive slices into the single review-service surface that routes
// and tests consume. Spread-merge preserves the flat method namespace required by
// existing callers (service.create / service.decide / service.bulkArchive / etc.);
// cross-slice reads (decide → findReview, updateVersion → findReview) are wired via
// the shared ./_queries helper rather than `this` binding, so slices have no intra-
// service runtime coupling.
export function createReviewService(db: AppDb) {
  return {
    ...createReviewCrudSlice(db),
    ...createReviewDecideSlice(db),
    ...createReviewLifecycleSlice(db),
    ...createReviewBulkSlice(db),
  };
}
