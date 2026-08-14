import { randomBytes, createHash } from "crypto";

/**
 * Generate a new API key with `gwk_` prefix.
 * Returns the raw key (shown once), the SHA-256 hash (stored), and the display prefix.
 */
export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const random = randomBytes(32).toString("hex");
  const raw = `gwk_${random}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const prefix = `gwk_${random.slice(0, 8)}`;
  return { raw, hash, prefix };
}
