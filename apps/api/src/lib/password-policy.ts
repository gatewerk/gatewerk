import { createHash } from "crypto";
import { serverEnv } from "../env";

const MIN_LENGTH = 12;
const MAX_LENGTH = 128;
const HIBP_TIMEOUT_MS = 3000;

export interface PasswordValidationResult {
  valid: boolean;
  code?: "too_short" | "too_long" | "breached";
  message?: string;
}

export async function validatePassword(password: string): Promise<PasswordValidationResult> {
  if (password.length < MIN_LENGTH) {
    return {
      valid: false,
      code: "too_short",
      message: `Password must be at least ${MIN_LENGTH} characters`,
    };
  }

  if (password.length > MAX_LENGTH) {
    return {
      valid: false,
      code: "too_long",
      message: `Password must be at most ${MAX_LENGTH} characters`,
    };
  }

  const breached = await checkHibp(password);
  if (breached) {
    return {
      valid: false,
      code: "breached",
      message: "This password has appeared in a data breach and should not be used",
    };
  }

  return { valid: true };
}

async function checkHibp(password: string): Promise<boolean> {
  if (serverEnv.SKIP_HIBP === "true") return false;
  try {
    const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HIBP_TIMEOUT_MS);

    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      signal: controller.signal,
      headers: { "User-Agent": "Gatewerk-Password-Check" },
    });

    clearTimeout(timeoutId);

    if (!res.ok) return false;

    const text = await res.text();
    return text.split("\n").some(line => {
      const [hash] = line.split(":");
      return hash.trim() === suffix;
    });
  } catch {
    return false;
  }
}
