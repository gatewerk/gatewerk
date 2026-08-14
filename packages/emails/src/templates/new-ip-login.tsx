import { Section, Text } from "@react-email/components";
import { Layout, Header, Footer } from "../components";
import { email, text } from "../theme";

export interface NewIpLoginEmailProps {
  ip: string;
  userAgent?: string;
  detectedAt: string;
  /** Absolute logo URL served by this deployment's own origin. See Header. */
  logoUrl?: string;
}

/**
 * A raw ISO timestamp ("2026-06-04T20:00:00.000Z") is unreadable in a security
 * email, which is the one kind a reader scans for "was that me, at that time".
 * Locale and time zone are pinned so the render is deterministic across hosts;
 * an unparseable value is passed through rather than hidden.
 */
function formatDetectedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  })} UTC`;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <Text
      style={{
        fontSize: "13px",
        lineHeight: "1.5",
        color: email.t4,
        margin: "0 0 4px",
      }}
    >
      <span style={{ color: email.t7 }}>{label}</span> {value}
    </Text>
  );
}

export function NewIpLoginEmail(props: NewIpLoginEmailProps) {
  const { ip, userAgent, detectedAt, logoUrl } = props;
  const at = formatDetectedAt(detectedAt);
  return (
    // The subject says a new sign-in happened; the preview says which one, so
    // the reader can often clear it without opening (§7.2).
    <Layout preview={`${ip} · ${at}`}>
      <Header logoUrl={logoUrl} />
      <Text style={text.title}>New sign-in detected</Text>
      <Text style={text.body}>
        A new sign-in was detected on your Gatewerk account.
      </Text>
      <Section
        style={{
          backgroundColor: email.inset,
          borderRadius: "10px",
          padding: "16px 18px",
          margin: "0 0 16px",
        }}
      >
        <DetailRow label="IP" value={ip} />
        <DetailRow label="Browser" value={userAgent ?? "Unknown"} />
        <DetailRow label="Time" value={at} />
      </Section>
      <Text style={text.body}>
        If this wasn&apos;t you, change your password immediately.
      </Text>
      <Footer />
    </Layout>
  );
}

NewIpLoginEmail.subject = (_props: NewIpLoginEmailProps): string =>
  "New sign-in to your Gatewerk account";

NewIpLoginEmail.PreviewProps = { ip: "203.0.113.7", userAgent: "Chrome 120 on macOS", detectedAt: "2026-06-04T20:00:00.000Z" } satisfies NewIpLoginEmailProps;
export default NewIpLoginEmail;
