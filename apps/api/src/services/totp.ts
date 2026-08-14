import crypto from "crypto";
import * as OTPAuth from "otpauth";
import bcrypt from "bcryptjs";
import { serverEnv } from "../env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 8;
const TOTP_WINDOW = 1;
const TOTP_PERIOD = 30;

function getEncryptionKey(): Buffer {
  const keyHex = serverEnv.TOTP_ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error("TOTP_ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  }
  return Buffer.from(keyHex, "hex");
}

export function encryptTotpSecret(secret: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${encrypted.toString("hex")}:${tag.toString("hex")}`;
}

export function decryptTotpSecret(encryptedValue: string): string {
  const key = getEncryptionKey();
  const [ivHex, encHex, tagHex] = encryptedValue.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(encHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

export function isTotpConfigured(): boolean {
  const keyHex = serverEnv.TOTP_ENCRYPTION_KEY;
  return !!keyHex && keyHex.length === 64;
}

export function generateTotpSecret(email: string): {
  secret: string;
  uri: string;
  base32: string;
} {
  const totp = new OTPAuth.TOTP({
    issuer: "Gatewerk",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD,
  });

  return {
    secret: totp.secret.base32,
    uri: totp.toString(),
    base32: totp.secret.base32,
  };
}

export function verifyTotpCode(secret: string, code: string): boolean {
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD,
  });

  const delta = totp.validate({ token: code, window: TOTP_WINDOW });
  return delta !== null;
}

/**
 * Anti-replay variant for login-time validation. A plain `verifyTotpCode`
 * accepts any code within the +/-1 step window regardless of whether it was
 * already used — the same 6 digits stay valid (and replayable, e.g. by
 * something that shoulder-surfed or intercepted one) for up to ~90s. This
 * returns which step the code matched so the caller can compare against
 * `reviewers.last_used_totp_at` and reject a step that's already been spent.
 */
export function verifyTotpCodeWithStep(
  secret: string,
  code: string,
): { valid: boolean; stepStartedAt: Date | null } {
  const totp = new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    algorithm: "SHA1",
    digits: 6,
    period: TOTP_PERIOD,
  });

  const delta = totp.validate({ token: code, window: TOTP_WINDOW });
  if (delta === null) return { valid: false, stepStartedAt: null };

  const currentStep = Math.floor(Date.now() / 1000 / TOTP_PERIOD);
  const matchedStep = currentStep + delta;
  return { valid: true, stepStartedAt: new Date(matchedStep * TOTP_PERIOD * 1000) };
}

export function generateBackupCodes(): string[] {
  const codes: string[] = [];
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    let code = "";
    const bytes = crypto.randomBytes(BACKUP_CODE_LENGTH);
    for (let j = 0; j < BACKUP_CODE_LENGTH; j++) {
      code += chars[bytes[j] % chars.length];
    }
    codes.push(code);
  }
  return codes;
}

export async function hashBackupCodes(
  codes: string[],
): Promise<Array<{ hash: string; used_at: string | null }>> {
  return Promise.all(
    codes.map(async (code) => ({
      hash: await bcrypt.hash(code.toUpperCase(), 10),
      used_at: null,
    })),
  );
}

export async function verifyBackupCode(
  code: string,
  storedCodes: Array<{ hash: string; used_at: string | null }>,
): Promise<{ valid: boolean; index: number }> {
  const normalized = code.toUpperCase().replace(/[\s-]/g, "");
  for (let i = 0; i < storedCodes.length; i++) {
    if (storedCodes[i].used_at) continue;
    const match = await bcrypt.compare(normalized, storedCodes[i].hash);
    if (match) return { valid: true, index: i };
  }
  return { valid: false, index: -1 };
}
