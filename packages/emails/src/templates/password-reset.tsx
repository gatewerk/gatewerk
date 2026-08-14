import { Text, Link } from "@react-email/components";
import { Layout, Header, Button, Footer } from "../components";
import { email, text } from "../theme";

export interface PasswordResetEmailProps {
  resetUrl: string;
  /** Absolute logo URL served by this deployment's own origin. See Header. */
  logoUrl?: string;
}

export function PasswordResetEmail({ resetUrl, logoUrl }: PasswordResetEmailProps) {
  return (
    <Layout preview="The link expires in 1 hour.">
      <Header logoUrl={logoUrl} />
      <Text style={text.title}>Reset your password</Text>
      <Text style={text.body}>
        You requested a password reset for your Gatewerk account. Click the
        button below to set a new password. This link expires in 1 hour.
      </Text>
      <Button href={resetUrl}>Reset password</Button>
      <Text style={{ ...text.meta, margin: "16px 0 0" }}>
        Or copy this link into your browser:{" "}
        {/* Neutral, not green (§2.5). */}
        <Link href={resetUrl} style={{ color: email.t4, textDecoration: "underline" }}>
          {resetUrl}
        </Link>
      </Text>
      <Footer reason="If you did not request this, you can ignore this email." />
    </Layout>
  );
}

PasswordResetEmail.subject = (_props: PasswordResetEmailProps): string =>
  "Reset your Gatewerk password";

PasswordResetEmail.PreviewProps = { resetUrl: "https://app.gatewerk.com/reset-password?token=preview" } satisfies PasswordResetEmailProps;
export default PasswordResetEmail;
