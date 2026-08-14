import { Text, Link } from "@react-email/components";
import { Layout, Header, Button, Footer } from "../components";
import { email, text } from "../theme";

export interface EmailVerifyEmailProps {
  verifyUrl: string;
  /** Absolute logo URL served by this deployment's own origin. See Header. */
  logoUrl?: string;
}

export function EmailVerifyEmail({ verifyUrl, logoUrl }: EmailVerifyEmailProps) {
  return (
    <Layout preview="The link expires in 24 hours.">
      <Header logoUrl={logoUrl} />
      <Text style={text.title}>Verify your email address</Text>
      <Text style={text.body}>
        Click the button below to confirm your email address and activate your
        account. This link expires in 24 hours.
      </Text>
      <Button href={verifyUrl}>Verify email address</Button>
      <Text style={{ ...text.meta, margin: "16px 0 0" }}>
        Or copy this link into your browser:{" "}
        {/* Neutral, not green. Green is reserved for the primary action, since
            colour means needs-attention (§2.5). */}
        <Link href={verifyUrl} style={{ color: email.t4, textDecoration: "underline" }}>
          {verifyUrl}
        </Link>
      </Text>
      <Footer reason="If you did not create a Gatewerk account, you can ignore this email." />
    </Layout>
  );
}

EmailVerifyEmail.subject = (_props: EmailVerifyEmailProps): string =>
  "Verify your Gatewerk email address";

EmailVerifyEmail.PreviewProps = { verifyUrl: "https://app.gatewerk.com/verify-email?token=preview" } satisfies EmailVerifyEmailProps;
export default EmailVerifyEmail;
