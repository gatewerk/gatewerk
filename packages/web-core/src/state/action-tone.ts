/**
 * What colour a template action turns out to be, for everything that has to
 * agree about it.
 *
 * There were four independent derivations of this and three of them
 * disagreed:
 *
 *   * the inbox decision rail (screens/inbox/detail/rail/action-tones.ts)
 *   * the external review page (screens/review/DecisionRow.tsx)
 *   * the template editor's role chip (ActionsSection.tsx), which read the
 *     ROLE alone and so painted `send_back` blue while the rail painted the
 *     same button neutral
 *   * apps/web, via `resolveActionStyle` in state/inbox/action-row-state.ts
 *
 * A template editor that shows one colour while the reviewer presses another
 * is not a preview, it is a claim that happens to be false. This is the one
 * function that answers the question, so the editor can promise exactly what
 * the rail will do.
 *
 * `resolveActionStyle` is deliberately left where it is: it speaks apps/web's
 * five-value button vocabulary (primary/destructive/warning/secondary), and
 * apps/web is being deleted. This is web-next's three-tone vocabulary, and
 * the two agree on the only question that matters — an explicit
 * `style: "destructive"` outranks whatever the kind would have implied.
 */
export type ActionTone = "green" | "red" | "neutral";

/** Structural, not `TemplateActionConfigCanonical`: callers hold both the
 *  canonical config and looser API-shaped objects, and this reads three
 *  fields off either. */
export interface ActionToneInput {
  kind: string;
  decision_value?: string | null;
  style?: string | null;
}

export function actionTone(action: ActionToneInput): ActionTone {
  // Explicit first. An action a template calls destructive is red wherever it
  // appears, whatever its kind — that is the whole point of the axis.
  if (action.style === "destructive") return "red";
  if (action.kind === "decision" && action.decision_value === "approved") return "green";
  if (action.kind === "decision" && action.decision_value === "rejected") return "red";
  return "neutral";
}
