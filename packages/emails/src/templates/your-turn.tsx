import { Text } from "@react-email/components";
import { Layout, Header, Button, Footer } from "../components";
import { text } from "../theme";

export interface YourTurnEmailProps {
  title: string;
  /**
   * Deep link to the specific review: `${uiOrigin}/reviews/${id}`.
   *
   * apps/web (the app every deployment actually builds) routes `reviews/:id`
   * to a redirect onto `/?review=<id>`, so this resolves today, and it matches
   * the link shape daily-digest already ships. web-next has neither the route
   * nor query-param selection, which is logged as a cutover blocker (§10).
   */
  reviewUrl: string;
  /** Absolute logo URL served by this deployment's own origin. See Header. */
  logoUrl?: string;
}

export function YourTurnEmail({ title, reviewUrl, logoUrl }: YourTurnEmailProps) {
  return (
    // The subject is the review title, so the preview says what to do with it
    // rather than repeating it (§7.2).
    <Layout preview="Open it to approve, request changes, or reject.">
      <Header logoUrl={logoUrl} />
      <Text style={text.title}>{title}</Text>
      <Text style={text.body}>A review is waiting for your decision.</Text>
      <Button href={reviewUrl}>Open the review</Button>
      <Footer reason="You are receiving this because a review was assigned to you." />
    </Layout>
  );
}

YourTurnEmail.subject = (props: YourTurnEmailProps): string => props.title;

YourTurnEmail.PreviewProps = {
  title: "Your turn · invoice approval",
  reviewUrl: "https://app.gatewerk.com/reviews/rev_a1b2c3",
} satisfies YourTurnEmailProps;

export default YourTurnEmail;
