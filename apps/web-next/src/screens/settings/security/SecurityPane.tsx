/**
 * Settings → Security, in the Redesign prototype's card grammar (manifest
 * §2.9), reconciled with the standing rulings:
 * - Passkeys stay HELD (the prototype draws them; the ruling holds them —
 *   hide never delete, the card ships when the ruling flips).
 * - Active sessions (prototype) AND login history (this morning's ruling)
 *   both ship — control and evidence.
 * Order: the integrity control, its active alarm, what is signed in now,
 * the evidence trail, and the irreversible thing last.
 *
 * Layout (pane width unification): the pane grew from 640 to
 * 1080, so its cards now flow into the same auto-fit grid Project's API
 * Keys | Webhooks pair uses (ProjectPane.tsx:224, values copied exactly)
 * instead of stacking as one narrow column with empty space on both sides.
 * Three cards were judged and kept OUT of the grid, for two different
 * reasons:
 * - SessionsCard and LoginHistorySection are both lists (devices, login
 *   events), not fixed controls — each row already carries a trailing
 *   Revoke/time cluster that wants the row's real width to sit flush
 *   against, not a squeezed grid cell. Tried in the grid first: at 1080,
 *   minmax(360px,1fr) only fits TWO columns per row (1080 < 3*360 plus
 *   gaps), so a third grid item does not get a third column — it wraps
 *   alone into column one of a new row with an empty column two beside it,
 *   which is the exact stranded-card look this pass exists to remove. Both
 *   stay full width sections below the two-up grid instead.
 * - DeleteAccountSection is the one irreversible action on this pane. Tiling
 *   it beside ordinary settings cards would let a misclick land next to
 *   "Login notifications" instead of reading as the deliberately separate,
 *   weightier thing it is, so it also stays out of the grid, on its own row,
 *   full pane width made its confirm inputs and banner stretch edge to edge,
 *   which is exactly the text-input-at-1080 failure mode this pass exists to
 *   remove.
 *
 *   Half the row, not the 640 cap this used —
 *   still its own row (never grid-tiled — the reasoning above stands
 *   unchanged), still last. 526 is the same half-column measure the
 *   auto-fit grids elsewhere on this pane and Account's resolve to at 1080
 *   (`(1080 - 28px gap) / 2`, AccountPane.tsx's own two-column grid), so a
 *   card that is deliberately NOT in a grid still reads as "half of this
 *   pane's width" rather than an arbitrary number.
 *
 * That leaves TwoFactorSection and LoginNotificationsSection as the grid:
 * two fixed-content cards that split 1080 into two even ~526px columns with
 * nothing left over.
 */
import { PaneHeader } from "../_shared/ui";
import { useNarrowViewport } from "~/shell/use-narrow-viewport";
import { TwoFactorSection } from "./TwoFactorSection";
import { LoginNotificationsSection } from "./LoginNotificationsSection";
import { SessionsCard } from "./SessionsCard";
import { LoginHistorySection } from "./LoginHistorySection";
import { DeleteAccountSection } from "./DeleteAccountSection";

export function SecurityPane() {
  // The grid below floors each column at 360px (comment above), which is
  // correct at the pane's 1080px desktop width but clips on a phone. On
  // narrow, drop to one column via useNarrowViewport, the same signal the
  // rest of the mobile work hangs off, not a new breakpoint.
  const narrow = useNarrowViewport();
  return (
    <>
      <PaneHeader title="Security" subtitle="Protect your account and sessions" />
      <div
        className="grid items-start gap-7"
        style={{ gridTemplateColumns: narrow ? "minmax(0, 1fr)" : "repeat(auto-fit, minmax(360px, 1fr))" }}
      >
        <TwoFactorSection />
        <LoginNotificationsSection />
      </div>
      <SessionsCard />
      <LoginHistorySection />
      <div style={{ maxWidth: 526 }}>
        <DeleteAccountSection />
      </div>
    </>
  );
}
