/**
 * POST /api/waitlist — waitlist intake.
 *
 * Every integration is optional-graceful:
 *   TURNSTILE_SECRET_KEY  — verify token when set; reject on failure.
 *                           Must be set together with PUBLIC_TURNSTILE_SITE_KEY on the page —
 *                           secret without site key means the widget never renders and every
 *                           submission is rejected with "turnstile_not_configured_on_page".
 *   RESEND_API_KEY        — notify hello@gatewerk.com
 *   GATEWERK_WAITLIST_URL + GATEWERK_WAITLIST_KEY — dogfood: create a review in prod
 *   POSTHOG_KEY           — server-side event capture
 *
 * Missing env = skip that leg, never 500.
 */

interface Env {
  TURNSTILE_SECRET_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_AUDIENCE_ID?: string;
  GATEWERK_WAITLIST_URL?: string;
  GATEWERK_WAITLIST_KEY?: string;
  POSTHOG_KEY?: string;
}

interface WaitlistBody {
  email?: unknown;
  tier?: unknown;
  message?: unknown;
  source?: unknown;
  "cf-turnstile-response"?: unknown;
  utm_source?: unknown;
  utm_medium?: unknown;
  utm_campaign?: unknown;
}

const VALID_TIERS = new Set(["team", "business"]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Validation (extracted for unit-testability)
// ---------------------------------------------------------------------------

export interface ValidatedInput {
  email: string;
  tier: string;
  message: string;
  source: "waitlist" | "newsletter";
  turnstileToken: string | null;
  utm: { source: string; medium: string; campaign: string };
}

export interface ValidationError {
  error: string;
}

export function validateBody(
  raw: WaitlistBody
): ValidatedInput | ValidationError {
  const email = typeof raw.email === "string" ? raw.email.trim() : "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "A valid email address is required." };
  }

  const source = raw.source === "newsletter" ? "newsletter" : "waitlist";

  const parsedTier = typeof raw.tier === "string" ? raw.tier.trim().toLowerCase() : "";
  const tier = source === "newsletter" ? "" : parsedTier;
  if (source === "waitlist" && !VALID_TIERS.has(tier)) {
    return { error: "Tier must be one of: team, business." };
  }

  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (message.length > 2000) {
    return { error: "Message must be 2000 characters or fewer." };
  }

  const turnstileToken =
    typeof raw["cf-turnstile-response"] === "string"
      ? raw["cf-turnstile-response"]
      : null;

  const utm = {
    source:
      typeof raw.utm_source === "string" ? raw.utm_source.slice(0, 200) : "",
    medium:
      typeof raw.utm_medium === "string" ? raw.utm_medium.slice(0, 200) : "",
    campaign:
      typeof raw.utm_campaign === "string"
        ? raw.utm_campaign.slice(0, 200)
        : "",
  };

  return { email, tier, message, source, turnstileToken, utm };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let raw: WaitlistBody;
  try {
    raw = (await request.json()) as WaitlistBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const validated = validateBody(raw);
  if ("error" in validated) {
    return jsonResponse(validated, 400);
  }

  const { email, tier, message, source, turnstileToken, utm } = validated;

  // ── Turnstile verification ──────────────────────────────────────────────
  if (env.TURNSTILE_SECRET_KEY) {
    if (!turnstileToken) {
      // Token absent while secret is set means the widget was never rendered —
      // most likely PUBLIC_TURNSTILE_SITE_KEY is missing on the page side.
      console.warn(
        "[waitlist] TURNSTILE_SECRET_KEY is set but no cf-turnstile-response token " +
          "arrived. Ensure PUBLIC_TURNSTILE_SITE_KEY is also configured so the widget renders."
      );
      return jsonResponse({ error: "turnstile_not_configured_on_page" }, 400);
    }
    try {
      const remoteip = request.headers.get("CF-Connecting-IP") ?? "";
      const form = new FormData();
      form.append("secret", env.TURNSTILE_SECRET_KEY);
      form.append("response", turnstileToken);
      if (remoteip) form.append("remoteip", remoteip);
      const res = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        { method: "POST", body: form, signal: AbortSignal.timeout(5000) }
      );
      const result = (await res.json()) as { success: boolean };
      if (!result.success) {
        return jsonResponse(
          { error: "Human verification failed. Please try again." },
          400
        );
      }
    } catch (err) {
      console.error("[waitlist] Turnstile verify error:", err);
      return jsonResponse(
        { error: "Could not verify human check. Please try again." },
        500
      );
    }
  }

  // ── Resend notification ─────────────────────────────────────────────────
  if (source === "waitlist" && env.RESEND_API_KEY) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // Resend's verified sending domain is mail.gatewerk.com; a
          // bare-domain from address gets rejected.
          from: "waitlist@mail.gatewerk.com",
          to: "hello@gatewerk.com",
          subject: `Waitlist: ${tier} — ${email}`,
          text: [
            `Email: ${email}`,
            `Tier: ${tier}`,
            `Message: ${message || "(none)"}`,
            `UTM: source=${utm.source} medium=${utm.medium} campaign=${utm.campaign}`,
          ].join("\n"),
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.error("[waitlist] Resend error:", err);
      // non-fatal — continue
    }
  }

  // ── Resend Audience contact ─────────────────────────────────────────────
  if (env.RESEND_API_KEY && env.RESEND_AUDIENCE_ID) {
    try {
      await fetch(`https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, unsubscribed: false }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.error("[waitlist] Resend audience error:", err);
      // non-fatal — continue
    }
  }

  // ── Gatewerk dogfood review ─────────────────────────────────────────────
  if (env.GATEWERK_WAITLIST_URL && env.GATEWERK_WAITLIST_KEY) {
    try {
      await fetch(`${env.GATEWERK_WAITLIST_URL}/api/v1/reviews`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GATEWERK_WAITLIST_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          template: "waitlist",
          payload: { email, tier, gating: message },
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.error("[waitlist] Gatewerk dogfood error:", err);
      // non-fatal — continue
    }
  }

  // ── PostHog capture ─────────────────────────────────────────────────────
  if (env.POSTHOG_KEY) {
    try {
      await fetch("https://eu.i.posthog.com/capture/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: env.POSTHOG_KEY,
          event: source === "newsletter" ? "newsletter_joined" : "waitlist_joined",
          distinct_id: email,
          properties: {
            source,
            tier,
            utm_source: utm.source,
            utm_medium: utm.medium,
            utm_campaign: utm.campaign,
          },
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      console.error("[waitlist] PostHog error:", err);
      // non-fatal — continue
    }
  }

  return jsonResponse({ ok: true });
};
