import { Section, Text } from "@react-email/components";
import { Layout, Header, Footer, Code } from "../components";
import { text } from "../theme";

export interface OtpCodeEmailProps {
  code: string;
  expiresInMinutes?: number; // default 10
  /**
   * Masked label of the person who CREATED the review link, e.g. "A***", from
   * resolveSenderHint. Empty string for agent-created and chain-created links,
   * where there is no human sender to name.
   *
   * The review TITLE is deliberately absent. This is an auth step, not a
   * notification, and the title is the reviewed subject matter landing in an
   * inbox we do not control, sometimes a shared one (ruled, spec §9 Q1).
   */
  senderHint?: string;
  /** Absolute logo URL served by this deployment's own origin. See Header. */
  logoUrl?: string;
}

export function OtpCodeEmail({
  code,
  expiresInMinutes = 10,
  senderHint,
  logoUrl,
}: OtpCodeEmailProps) {
  return (
    // Preview adds the expiry rather than repeating the code, which the
    // subject already carries (§7.2).
    <Layout preview={`Expires in ${expiresInMinutes} minutes.`}>
      <Header logoUrl={logoUrl} />
      <Section>
        <Text style={text.title}>Verification code</Text>
        <Text style={text.body}>
          {senderHint
            ? `Enter this code to open the review shared with you by ${senderHint}.`
            : "Enter this code to open the review shared with you."}
        </Text>
        <Code value={code} />
        <Text style={text.meta}>
          {`This code expires in ${expiresInMinutes} minutes.`}
        </Text>
      </Section>
      <Footer reason="You are receiving this because a code was requested for a review link sent to this address. If that was not you, you can ignore this email." />
    </Layout>
  );
}

// The code stays in the subject: it is what lets iOS and Android offer it as
// an autofill suggestion, which is worth more than the tidiness of hiding it.
OtpCodeEmail.subject = (props: OtpCodeEmailProps): string =>
  `Your Gatewerk verification code: ${props.code}`;

OtpCodeEmail.PreviewProps = {
  code: "483920",
  senderHint: "A***",
} satisfies OtpCodeEmailProps;
export default OtpCodeEmail;
