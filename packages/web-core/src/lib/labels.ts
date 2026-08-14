/**
 * Human-readable label for a review decision value.
 * Handles all canonical Decision enum members from @gatewerk/shared and
 * gracefully degrades for unknown future values.
 */
export function decisionLabel(decision: string): string {
  switch (decision) {
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "edited":
      return "Edited";
    case "retried":
      return "Retried";
    case "expired":
      return "Expired";
    case "max_iterations_reached":
      return "Max iterations reached";
    // HOTL monitoring gate outcomes (spec §4.9).
    case "vetoed":
      return "Vetoed";
    case "confirmed":
      return "Confirmed";
    default:
      // Capitalize first letter and replace underscores with spaces for
      // unknown/future decision values introduced without a labels update.
      return decision.charAt(0).toUpperCase() + decision.slice(1).replace(/_/g, " ");
  }
}
