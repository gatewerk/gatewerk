import { Column, Img, Row, Section, Text } from "@react-email/components";
import { email } from "../theme";

interface HeaderProps {
  /** Optional tagline below the wordmark. */
  tagline?: string;
  /**
   * Absolute URL of the 256px mark, served by the deployment's OWN origin:
   * `${config.uiOrigin}/brand/gatewerk-logo-256.png`.
   *
   * Never point this at gatewerk.com. A self-hoster's recipients would then
   * report their IP and open time to a CDN we run, from a deployment we do
   * not run, and they are not our users. Spec §4.
   *
   * Optional, and the wordmark stays live text beside it, so a client that
   * blocks images (many do, by default) still reads as Gatewerk. The mark is
   * decoration; it is never the only carrier of identity.
   */
  logoUrl?: string;
}

export function Header({ tagline, logoUrl }: HeaderProps) {
  return (
    <Section style={{ paddingBottom: "24px" }}>
      <Row>
        {logoUrl ? (
          // 42 = the 32px mark plus the 10px gap.
          <Column style={{ width: "42px", verticalAlign: "middle" }}>
            <Img
              src={logoUrl}
              width="32"
              height="32"
              alt="Gatewerk"
              style={{ borderRadius: "7px", display: "block" }}
            />
          </Column>
        ) : null}
        <Column style={{ verticalAlign: "middle" }}>
          {/* No letter-spacing: at this size on an unknown fallback font it
              is guesswork, not typography. */}
          <Text
            style={{
              fontSize: "17px",
              fontWeight: "700",
              color: email.t1,
              margin: "0",
            }}
          >
            Gatewerk
          </Text>
          {tagline ? (
            <Text
              style={{ fontSize: "13px", color: email.t7, margin: "2px 0 0" }}
            >
              {tagline}
            </Text>
          ) : null}
        </Column>
      </Row>
    </Section>
  );
}
