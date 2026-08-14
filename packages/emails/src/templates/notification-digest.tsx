import { Link, Section, Text } from "@react-email/components";
import { Layout, Header, Button, Footer } from "../components";
import { email, text } from "../theme";

export interface NotificationDigestEmailProps {
  count: number;
  sampleTitles: string[];
  inboxUrl: string;
  unsubscribeUrl: string;
  /** Absolute logo URL served by this deployment's own origin. See Header. */
  logoUrl?: string;
}

export function NotificationDigestEmail({
  count,
  sampleTitles,
  inboxUrl,
  unsubscribeUrl,
  logoUrl,
}: NotificationDigestEmailProps) {
  const noun = count === 1 ? "item" : "items";
  // The subject carries the count, so the preview spends its space naming the
  // first item instead of repeating it (§7.2).
  const preview =
    sampleTitles.length === 0
      ? "Open your inbox to decide."
      : count > 1
        ? `${sampleTitles[0]} and ${count - 1} more.`
        : `${sampleTitles[0]}.`;
  return (
    <Layout preview={preview}>
      <Header logoUrl={logoUrl} />
      <Section>
        <Text style={text.title}>
          {count} {noun} waiting for you
        </Text>
        <Text style={text.body}>
          The following reviews are pending your decision.
        </Text>
        {sampleTitles.length > 0 ? (
          <Section style={{ margin: "0 0 20px" }}>
            {sampleTitles.map((title, i) => (
              <Text
                key={i}
                style={{
                  fontSize: "14px",
                  lineHeight: "1.5",
                  color: email.t4,
                  margin: "0 0 6px",
                  paddingLeft: "12px",
                  // Neutral edge, not a coloured one: colour means
                  // needs-attention and a list of pending items does not
                  // need it (§2.5).
                  borderLeft: `3px solid ${email.line}`,
                }}
              >
                {title}
              </Text>
            ))}
          </Section>
        ) : null}
        <Button href={inboxUrl}>Open your inbox</Button>
      </Section>
      <Footer reason="You are receiving this because reviews are waiting for your decision.">
        <Text style={{ fontSize: "12px", color: email.t9, margin: "8px 0 0" }}>
          <Link href={unsubscribeUrl} style={{ color: email.t9 }}>
            Unsubscribe
          </Link>{" "}
          from digest notifications
        </Text>
      </Footer>
    </Layout>
  );
}

NotificationDigestEmail.subject = (
  props: NotificationDigestEmailProps,
): string => {
  const noun = props.count === 1 ? "item" : "items";
  return `You have ${props.count} ${noun} waiting in Gatewerk`;
};

NotificationDigestEmail.PreviewProps = {
  count: 3,
  sampleTitles: ["Approve invoice #1234", "Review agent output", "Confirm deployment"],
  inboxUrl: "https://app.gatewerk.com",
  unsubscribeUrl: "https://app.gatewerk.com/unsubscribe?token=preview",
} satisfies NotificationDigestEmailProps;

export default NotificationDigestEmail;
