import { Html, Head, Body, Container, Preview } from "@react-email/components";
import type { ReactNode } from "react";
import { email, fontSans } from "../theme";

interface LayoutProps {
  children: ReactNode;
  /** Short preview text shown in the inbox list before the email is opened. */
  preview?: string;
}

export function Layout({ children, preview }: LayoutProps) {
  return (
    <Html lang="en" dir="ltr">
      <Head>
        {/* Apple Mail and Outlook.com honour these and leave the cream alone.
            Gmail's dark mode partly ignores them and will still shift some
            values; that is accepted rather than fought. The ink ramp is
            warm-dark already and inverts legibly, so the bar there is
            legibility, not parity. */}
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
      </Head>
      {preview ? <Preview>{preview}</Preview> : null}
      <Body
        style={{
          backgroundColor: email.page,
          fontFamily: fontSans,
          margin: "0",
          padding: "24px 0",
        }}
      >
        <Container
          style={{
            maxWidth: "480px",
            margin: "0 auto",
            backgroundColor: email.card,
            borderRadius: "14px",
            // Bottom padding is 0 on purpose: Footer supplies its own and
            // bleeds to the card edge to draw the tonal band (§2.4).
            padding: "32px 32px 0",
          }}
        >
          {children}
        </Container>
      </Body>
    </Html>
  );
}
