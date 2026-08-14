/**
 * share-link-utils.ts — pure helpers shared by ShareModal + RailReviewLink.
 */

/** The API returns a relative recipient path (/r/gw_tok_…) — share/copy
 *  always use the absolute URL. */
export function absoluteTokenUrl(url: string): string {
  return new URL(url, window.location.origin).toString();
}

/** Future-relative expiry: "expires 4h" / "expires 3d" / "expired". */
export function expiresLabel(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return "expires <1h";
  if (hours < 48) return `expires ${hours}h`;
  return `expires ${Math.round(hours / 24)}d`;
}

/** Clipboard write with a legacy fallback so Copy always lands + toasts. */
export function copyToClipboard(text: string, onDone: (ok: boolean) => void): void {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(
      () => onDone(true),
      () => fallbackCopy(text, onDone),
    );
  } else {
    fallbackCopy(text, onDone);
  }
}

function fallbackCopy(text: string, onDone: (ok: boolean) => void): void {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    onDone(ok);
  } catch {
    onDone(false);
  }
}
