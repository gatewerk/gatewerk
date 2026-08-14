import { Link, Section, Text } from "@react-email/components";
import { Layout, Header, Button, Footer } from "../components";
import { email, text } from "../theme";

export interface DailyDigestEmailProps {
  count: number;
  sampleReviewIds: string[];
  inboxUrl: string;
  /** Absolute logo URL served by this deployment's own origin. See Header. */
  logoUrl?: string;
}

export function DailyDigestEmail(props: DailyDigestEmailProps) {
  const { count, sampleReviewIds, inboxUrl, logoUrl } = props;
  const noun = count === 1 ? "review token" : "review tokens";
  return (
    // The subject carries the count and the fact they expired, so the preview
    // carries the consequence instead (§7.2).
    <Layout preview="The parent reviews are still awaiting external input.">
      <Header logoUrl={logoUrl} />
      <Section>
        <Text style={text.title}>
          {count} {noun} expired without a response
        </Text>
        <Text style={text.body}>
          {count === 1
            ? "A review token you shared expired without a decision while the parent review is still awaiting external input."
            : `${count} review tokens you shared expired without a decision while the parent reviews are still awaiting external input.`}
        </Text>
        <Text
          style={{
            fontSize: "13px",
            fontWeight: "600",
            color: email.t1,
            margin: "0 0 8px",
          }}
        >
          Affected reviews
        </Text>
        <Section style={{ margin: "0 0 20px" }}>
          {sampleReviewIds.map((id) => (
            // RULED (Q3): the id is the link text. Printing the whole URL as
            // its own label made the list unreadable and told the reader
            // nothing. Titles would need a new query on DailyDigestBatch and
            // are deferred.
            <Text
              key={id}
              style={{
                fontSize: "14px",
                lineHeight: "1.5",
                color: email.t4,
                margin: "0 0 6px",
                paddingLeft: "12px",
                borderLeft: `3px solid ${email.line}`,
              }}
            >
              <Link
                href={`${inboxUrl}/reviews/${id}`}
                style={{ color: email.t4, textDecoration: "underline" }}
              >
                {id}
              </Link>
            </Text>
          ))}
        </Section>
        <Button href={inboxUrl}>Open your inbox</Button>
      </Section>
      <Footer reason="You are receiving this because tokens you shared expired without a decision." />
    </Layout>
  );
}

DailyDigestEmail.subject = (props: DailyDigestEmailProps): string => {
  const noun = props.count === 1 ? "review token" : "review tokens";
  return `Gatewerk: ${props.count} ${noun} expired without a response`;
};

DailyDigestEmail.PreviewProps = {
  count: 3,
  sampleReviewIds: ["rev_a1b2c3", "rev_d4e5f6"],
  inboxUrl: "https://app.gatewerk.com",
} satisfies DailyDigestEmailProps;
export default DailyDigestEmail;
