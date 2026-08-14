import type { Request, Response, NextFunction } from "express";
import { RateLimitError } from "../lib/http-errors";

const windows = new Map<string, { count: number; resetAt: number }>();

// Clean stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of windows) {
    if (val.resetAt < now) windows.delete(key);
  }
}, 5 * 60 * 1000);

export function rateLimitByKey() {
  return (req: Request, res: Response, next: NextFunction) => {
    const limit: number | null = (req as any).rateLimitPerHour;
    const keyId: string | undefined = (req as any).apiKeyId;

    if (!limit || !keyId) return next();

    const now = Date.now();
    const hourMs = 60 * 60 * 1000;
    let window = windows.get(keyId);

    if (!window || window.resetAt < now) {
      window = { count: 0, resetAt: now + hourMs };
      windows.set(keyId, window);
    }

    window.count++;

    if (window.count > limit) {
      res.set("Retry-After", String(Math.ceil((window.resetAt - now) / 1000)));
      return res.status(429).json(new RateLimitError(`Rate limit of ${limit}/hour exceeded`).toJSON());
    }

    next();
  };
}
