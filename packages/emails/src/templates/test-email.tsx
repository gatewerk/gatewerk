import { Text } from "@react-email/components";
import { Layout, Header, Footer } from "../components";
import { text } from "../theme";

export interface TestEmailProps {
  /** Absolute logo URL served by this deployment's own origin. See Header. */
  logoUrl?: string;
}

export function TestEmail({ logoUrl }: TestEmailProps) {
  return (
    // This one has a job the others do not: the operator reading it is checking
    // whether the mark loaded and the styling survived their client, so the
    // preview states the result plainly (§7.2).
    <Layout preview="Outbound email is wired correctly.">
      <Header logoUrl={logoUrl} />
      <Text style={text.title}>Test email</Text>
      <Text style={text.body}>
        This is a test message from Gatewerk. If you received it, outbound email
        is wired correctly.
      </Text>
      <Footer />
    </Layout>
  );
}

TestEmail.subject = (_props: TestEmailProps): string => "Gatewerk test email";

TestEmail.PreviewProps = {} satisfies TestEmailProps;
export default TestEmail;
