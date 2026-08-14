import { Section, Text } from "@react-email/components";
import { email, fontMono } from "../theme";

interface CodeProps {
  /** The OTP code string, e.g. "483920". */
  value: string;
}

export function Code({ value }: CodeProps) {
  return (
    <Section
      style={{
        backgroundColor: email.inset,
        borderRadius: "10px",
        padding: "22px",
        textAlign: "center",
        margin: "16px 0",
      }}
    >
      <Text
        style={{
          fontFamily: fontMono,
          fontSize: "34px",
          fontWeight: "600",
          letterSpacing: "10px",
          color: email.t1,
          margin: "0",
          // letter-spacing appends a trailing gap after the last digit, which
          // drags the block visually left of centre. Left padding equal to the
          // tracking puts it back.
          paddingLeft: "10px",
        }}
      >
        {value}
      </Text>
    </Section>
  );
}
