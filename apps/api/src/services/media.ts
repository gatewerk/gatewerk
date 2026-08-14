import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { validateWebhookUrlWithDns } from "../lib/ssrf";
import { config } from "../config";
import { serverEnv } from "../env";

const UPLOADS_DIR = serverEnv.UPLOADS_DIR ?? "/data/uploads";
const MAX_DOWNLOAD_SIZE = 150 * 1024 * 1024; // 150MB

const DANGEROUS_CONTENT_TYPES = new Set([
  "image/svg+xml",
  "text/html",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
]);

export interface StoredMedia {
  original_url: string;
  stored_path: string;
  content_type: string;
  size_bytes: number;
}

type R2Uploader = (key: string, body: Buffer, contentType: string) => Promise<boolean>;
let r2Upload: R2Uploader | null = null;

if (config.mode === "cloud") {
  const r2Path = (): string => new URL("../../../../ee/api/storage/r2-storage.js", import.meta.url).href;
  import(r2Path())
    .then((m: { uploadToR2: R2Uploader }) => { r2Upload = m.uploadToR2; })
    .catch(() => {});
}

// fieldName is agent-supplied — strip to [a-zA-Z0-9_-] to prevent traversal.
function sanitizePathComponent(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * The object-storage prefix every file for one review is written under. The
 * single source of truth for that layout: the uploader below, the download
 * route in app.ts, and the org-deletion sweep in ee/jobs/data-cleanup.ts all
 * derive their key from this.
 *
 * They used to each spell it out. The cleanup job spelled it `org/<orgId>/`,
 * a prefix nothing has ever written, so it deleted nothing and customer
 * uploads were retained forever, including after account deletion. Two sides
 * of a storage layout stated in two places will eventually disagree, and the
 * disagreement is silent — a delete that matches no keys looks exactly like a
 * delete that had no work to do.
 */
export function mediaKeyPrefix(reviewId: string): string {
  return `media/${sanitizePathComponent(reviewId)}/`;
}

async function storeBuffer(
  buffer: Buffer,
  contentType: string,
  reviewId: string,
  fieldName: string,
): Promise<{ stored_path: string } | null> {
  const safeReviewId = sanitizePathComponent(reviewId);
  const safeFieldName = sanitizePathComponent(fieldName);
  const ext = getExtension(contentType);
  const filename = `${safeFieldName}${ext}`;

  if (r2Upload) {
    const key = `${mediaKeyPrefix(reviewId)}${filename}`;
    const ok = await r2Upload(key, buffer, contentType);
    if (!ok) return null;
    return { stored_path: `/api/v1/media/${safeReviewId}/${filename}` };
  }

  const dir = join(UPLOADS_DIR, safeReviewId);
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/${filename}`, buffer);
  return { stored_path: `/uploads/${safeReviewId}/${filename}` };
}

/**
 * Download media from a URL and store locally (OSS) or in R2 (Cloud).
 * Returns null if URL is unreachable, file exceeds 150MB, or download fails.
 * In all failure cases, the original URL is preserved (graceful degradation).
 */
export async function downloadAndStore(
  url: string,
  reviewId: string,
  fieldName: string,
): Promise<StoredMedia | null> {
  try {
    // SSRF guard: agent-supplied URL cannot target private/reserved addresses.
    // Throws on private IP, loopback, reserved range, non-HTTP(S) scheme, or
    // malformed URL; caught by the outer catch which returns null per the
    // graceful-degradation contract (original_url is preserved in the review
    // payload regardless).
    await validateWebhookUrlWithDns(url);

    const headRes = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(10_000),
    });

    if (!headRes.ok) return null;

    const contentLength = parseInt(headRes.headers.get("content-length") || "0");
    const contentType = headRes.headers.get("content-type") || "application/octet-stream";

    if (DANGEROUS_CONTENT_TYPES.has(contentType.split(";")[0].trim().toLowerCase())) return null;
    if (contentLength > MAX_DOWNLOAD_SIZE) return null;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_DOWNLOAD_SIZE) return null;

    const result = await storeBuffer(buffer, contentType, reviewId, fieldName);
    if (!result) return null;

    return {
      original_url: url,
      stored_path: result.stored_path,
      content_type: contentType,
      size_bytes: buffer.length,
    };
  } catch {
    return null;
  }
}

function getExtension(contentType: string): string {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("svg")) return ".svg";
  if (contentType.includes("mp4")) return ".mp4";
  if (contentType.includes("webm")) return ".webm";
  if (contentType.includes("quicktime") || contentType.includes("mov")) return ".mov";
  return "";
}

export function isMediaUrl(value: unknown): value is string {
  return typeof value === "string" && (
    value.startsWith("http://") || value.startsWith("https://")
  );
}

export function isBase64Media(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

/**
 * Decode base64 media and store locally (OSS) or in R2 (Cloud).
 */
export async function decodeAndStore(
  base64: string,
  reviewId: string,
  fieldName: string,
): Promise<StoredMedia | null> {
  try {
    const match = base64.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) return null;

    const contentType = match[1];
    if (DANGEROUS_CONTENT_TYPES.has(contentType.split(";")[0].trim().toLowerCase())) return null;
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > MAX_DOWNLOAD_SIZE) return null;

    const result = await storeBuffer(buffer, contentType, reviewId, fieldName);
    if (!result) return null;

    return {
      original_url: `base64:${contentType}`,
      stored_path: result.stored_path,
      content_type: contentType,
      size_bytes: buffer.length,
    };
  } catch {
    return null;
  }
}
