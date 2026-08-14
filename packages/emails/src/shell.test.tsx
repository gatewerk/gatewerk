import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderEmail, type EmailTemplate } from "./index";
import { Header } from "./components";
import { render } from "@react-email/render";

import { OtpCodeEmail } from "./templates/otp-code";
import { EmailVerifyEmail } from "./templates/email-verify";
import { PasswordResetEmail } from "./templates/password-reset";
import { DailyDigestEmail } from "./templates/daily-digest";
import { NewIpLoginEmail } from "./templates/new-ip-login";
import { TestEmail } from "./templates/test-email";
import { YourTurnEmail } from "./templates/your-turn";
import { NotificationDigestEmail } from "./templates/notification-digest";

/**
 * Cross-template conformance for the email shell.
 * These are the EMAIL_BUILD_SPEC §8 verification rows that need no running
 * stack. Rows 10 and 11 (real sends, spf/dkim/dmarc) are manual.
 *
 * Every template is exercised through its own PreviewProps, so this suite also
 * fails if a PreviewProps block drifts out of sync with its props type.
 *
 * The four Cloud dunning templates used to be checked here too. They live in
 * the private ee submodule now, so this file cannot import them and the
 * directory scans below no longer reach them. ee/emails/shell-conformance.test.tsx
 * carries the identical checks for that side — including both source scans,
 * without which a Cloud template could ship a hardcoded gatewerk.com asset URL
 * and leak recipient IPs with nothing to catch it.
 */

// Each entry carries its declared PreviewProps. `any` is deliberate: the point
// is to iterate twelve templates with twelve unrelated prop types.
/* eslint-disable @typescript-eslint/no-explicit-any */
const ALL: Array<{ name: string; Template: EmailTemplate<any>; props: any }> = [
  { name: "otp-code", Template: OtpCodeEmail, props: OtpCodeEmail.PreviewProps },
  { name: "email-verify", Template: EmailVerifyEmail, props: EmailVerifyEmail.PreviewProps },
  { name: "password-reset", Template: PasswordResetEmail, props: PasswordResetEmail.PreviewProps },
  { name: "daily-digest", Template: DailyDigestEmail, props: DailyDigestEmail.PreviewProps },
  { name: "new-ip-login", Template: NewIpLoginEmail, props: NewIpLoginEmail.PreviewProps },
  { name: "test-email", Template: TestEmail, props: TestEmail.PreviewProps },
  { name: "your-turn", Template: YourTurnEmail, props: YourTurnEmail.PreviewProps },
  { name: "notification-digest", Template: NotificationDigestEmail, props: NotificationDigestEmail.PreviewProps },
];
/* eslint-enable @typescript-eslint/no-explicit-any */

/** React Email renders the <Preview> into a hidden div it marks for us. */
function extractPreview(html: string): string {
  const m = html.match(/data-skip-in-text="true">([^<]*)</);
  return m ? m[1].trim() : "";
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe("email shell conformance", () => {
  it("counts eight OSS templates, so a new one cannot skip these checks", () => {
    // Was twelve. The other four are Cloud-only and are counted by the
    // matching assertion in the ee submodule's suite.
    expect(ALL).toHaveLength(8);
  });

  // §8.1 + §8.8
  it("keeps no zinc-era literal and no hardcoded price in source", () => {
    const forbidden = [
      "#f4f4f5", "#ffffff", "#18181b", "#3f3f46",
      "#a1a1aa", "#71717a", "#e4e4e7", "#22C55E", "#0C0C0C",
      "$12",
    ];
    const offences: string[] = [];
    for (const file of sourceFiles(__dirname)) {
      const body = readFileSync(file, "utf8");
      for (const literal of forbidden) {
        if (body.includes(literal)) offences.push(`${file}: ${literal}`);
      }
    }
    expect(offences).toEqual([]);
  });

  // §8.2
  it("declares a light colour scheme and the warm card on the warm page", async () => {
    const out = await renderEmail(TestEmail, {});
    expect(out.html).toContain('name="color-scheme" content="light"');
    expect(out.html).toContain('name="supported-color-schemes" content="light"');
    expect(out.html).toContain("background-color:#efece3"); // --gw-page
    expect(out.html).toContain("background-color:#fbfaf6"); // --gw-panel-a
    expect(out.html).toContain("border-radius:14px");
  });

  // §8.3
  it("paints the primary action in the brand green with theme-invariant ink", async () => {
    const out = await renderEmail(YourTurnEmail, YourTurnEmail.PreviewProps);
    expect(out.html).toContain("background-color:#21b571");
    expect(out.html).toContain("color:#0a1a11");
  });

  // §8.4 — elevation, not lines
  it("separates the footer with a tonal band and no rule", async () => {
    const out = await renderEmail(TestEmail, {});
    expect(out.html).toContain("background-color:#f4f1e9"); // --gw-panel-b
    expect(out.html).not.toMatch(/border-top/i);
  });

  // §8.5 — the mark is decoration, never the only carrier of identity
  it("renders the mark from the given origin and still says Gatewerk without it", async () => {
    const withMark = await render(
      <Header logoUrl="https://self.hosted.example/brand/gatewerk-logo-256.png" />,
      { pretty: false },
    );
    expect(withMark).toContain(
      'src="https://self.hosted.example/brand/gatewerk-logo-256.png"',
    );
    expect(withMark).toContain('alt="Gatewerk"');

    const withoutMark = await render(<Header />, { pretty: false });
    expect(withoutMark).not.toContain("<img");
    expect(withoutMark).toContain("Gatewerk");
  });

  it("never points the mark at a Gatewerk-run CDN", () => {
    // A hardcoded gatewerk.com asset URL would make every self-hosted send
    // report that recipient's IP and open time to us. The URL must always
    // arrive as a prop derived from the deployment's own origin.
    for (const file of sourceFiles(__dirname)) {
      const body = readFileSync(file, "utf8");
      expect(body).not.toMatch(/https:\/\/(www\.)?gatewerk\.com\/brand/);
    }
  });

  // §8.6
  it.each(ALL)("$name renders a preview that is not just the subject", async ({ Template, props }) => {
    const out = await renderEmail(Template, props);
    const preview = extractPreview(out.html);
    expect(preview.length).toBeGreaterThan(0);
    expect(preview).not.toBe(out.subject);
  });

  it.each(ALL)("$name renders non-empty html and text", async ({ Template, props }) => {
    const out = await renderEmail(Template, props);
    expect(out.html.length).toBeGreaterThan(0);
    expect(out.text.trim().length).toBeGreaterThan(0);
  });

  it.each(ALL)("$name resolves to a system font stack, never a webfont we cannot ship", async ({ Template, props }) => {
    const out = await renderEmail(Template, props);
    expect(out.html).not.toContain("Inter");
    expect(out.html).not.toContain("JetBrains");
  });

  // §8.7 — the plain-text part is what spam filters weigh, and it is derived
  // from the HTML, so structure decides its quality.
  it("carries the code, the sender clause and the expiry into plain text", async () => {
    const out = await renderEmail(OtpCodeEmail, { code: "483920", senderHint: "A***" });
    expect(out.text).toContain("483920");
    expect(out.text).toContain("A***");
    expect(out.text).toContain("10 minutes");
  });

  it("drops the sender clause rather than naming nobody when the hint is empty", async () => {
    const out = await renderEmail(OtpCodeEmail, { code: "483920", senderHint: "" });
    expect(out.text).toContain("Enter this code to open the review shared with you.");
    expect(out.text).not.toContain("shared with you by");
  });

  it("never names the review title in the OTP mail", async () => {
    // Ruled (§9 Q1): an auth step, landing in an inbox we do not control.
    const out = await renderEmail(OtpCodeEmail, {
      code: "483920",
      senderHint: "A***",
    });
    expect(out.subject).not.toMatch(/invoice|review .*#/i);
    expect(out.text).not.toContain("Approve invoice");
  });

  // §8.9
  it("links daily-digest samples by id, never as a bare URL label", async () => {
    const out = await renderEmail(DailyDigestEmail, DailyDigestEmail.PreviewProps);
    expect(out.html).toContain(
      'href="https://app.gatewerk.com/reviews/rev_a1b2c3"',
    );
    // The id is the link text; the old template used the whole URL as its own
    // label, which told the reader nothing.
    expect(out.html).toContain(">rev_a1b2c3<");
    expect(out.html).not.toContain(
      ">https://app.gatewerk.com/reviews/rev_a1b2c3<",
    );
  });
});
