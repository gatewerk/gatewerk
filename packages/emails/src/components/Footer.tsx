import { Section, Text } from "@react-email/components";
import type { ReactNode } from "react";
import { email } from "../theme";

interface FooterProps {
  /** Explanation line, e.g. "You are receiving this because..." */
  reason?: string;
  /**
   * Extra footer content, rendered INSIDE the band below the identity line.
   * The band bleeds to the card edge and rounds its bottom corners, so
   * anything placed after <Footer> would sit outside the card. Digest
   * unsubscribe links belong here.
   */
  children?: ReactNode;
}

export function Footer({ reason, children }: FooterProps) {
  return (
    <Section
      style={{
        backgroundColor: email.band,
        // Negative side margins bleed the band out to the card edge. Layout's
        // container carries 32px side padding and no bottom padding, so the
        // band closes the card and rounds with it.
        margin: "32px -32px 0",
        padding: "20px 32px",
        borderRadius: "0 0 14px 14px",
        // Deliberately NO borderTop. Separation here is a tonal step, which is
        // elevation expressed in fill and survives every client, where
        // box-shadow does not (§2.4).
      }}
    >
      {reason ? (
        <Text
          style={{
            fontSize: "12px",
            lineHeight: "1.5",
            color: email.t7,
            margin: "0 0 4px",
          }}
        >
          {reason}
        </Text>
      ) : null}
      {/* The middot is tabular, which the no-dashes rule permits. */}
      <Text style={{ fontSize: "12px", color: email.t9, margin: "0" }}>
        Gatewerk · Human oversight for AI agents
      </Text>
      {children}
    </Section>
  );
}
