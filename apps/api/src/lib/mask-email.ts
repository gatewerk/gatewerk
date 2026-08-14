/**
 * Mask an email address, keeping the first character and the domain visible.
 *
 * Two call sites with different reasons for wanting the same shape:
 *  - the OTP step shows it so a recipient can confirm "yes that's mine"
 *    without leaking the full address to anyone who landed on the link;
 *  - the bounce attribution log keeps the domain, which is the useful
 *    deliverability signal (a whole domain failing looks different from one
 *    mailbox), while dropping the local part, which is the PII.
 *
 * Returns "" for null/undefined rather than a placeholder, so a caller cannot
 * accidentally reveal that no address was pinned.
 *
 * Lives here rather than beside either caller because masking rules are the
 * kind of thing that gets tightened later, and a second copy would not receive
 * the tightening.
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "";
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length <= 1) return `${local}***${domain}`;
  return `${local[0]}***${domain}`;
}
