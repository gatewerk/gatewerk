import { Button as RButton } from "@react-email/components";
import type { ReactNode } from "react";
import { email } from "../theme";

interface ButtonProps {
  href: string;
  children: ReactNode;
}

export function Button({ href, children }: ButtonProps) {
  return (
    <RButton
      href={href}
      style={{
        display: "inline-block",
        // The brand green. What shipped before was Tailwind green-500, which
        // was never a Gatewerk hue.
        backgroundColor: email.green,
        color: email.onGreen,
        fontWeight: "600",
        fontSize: "15px",
        textDecoration: "none",
        borderRadius: "10px",
        padding: "12px 22px",
        margin: "20px 0 4px",
        // No shadow: clients disagree about box-shadow and a green fill is
        // signal enough. Green appears here and nowhere else, because colour
        // means needs-attention (§2.5).
      }}
    >
      {children}
    </RButton>
  );
}
