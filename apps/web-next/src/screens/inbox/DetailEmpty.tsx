/**
 * DetailEmpty — shown when no review is selected in the detail area.
 *
 * History's empty-state design is the app's pattern
 * (52px icon tile, 15px title, 13px body), so the Inbox adopts it. That shape
 * now lives in EmptyStateTier3 rather than being hand-copied here, in History
 * and in NotFound — three copies that had already begun to drift.
 *
 * Still no keyboard-hint row: the Inbox has no ↑/↓ browsing wired, and a hint
 * that advertises a behaviour that does not exist is a defect, not a design.
 * The row arrives with the keys. History has one because History has the keys.
 */
import { Inbox } from "lucide-react";
import { EmptyStateTier3 } from "~/components/empty-state";

export function DetailEmpty() {
  return (
    <EmptyStateTier3
      icon={<Inbox size={24} strokeWidth={1.6} />}
      title="Select a review to inspect"
      body="Pick any review from the list to see its submission and decide what happens next."
    />
  );
}
