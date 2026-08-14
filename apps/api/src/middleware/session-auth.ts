import type { Request, Response, NextFunction } from "express";
import { AuthenticationError } from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import { validateJwt } from "../lib/auth-helpers";
import { config } from "../config";

export function sessionAuth(db: AppDb) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return next(new AuthenticationError("Missing token", "missing_token"));
    }

    const token = header.slice(7);

    try {
      const result = await validateJwt(token, db);
      if (!result) {
        return next(new AuthenticationError("Invalid token", "invalid_token"));
      }

      (req as any).reviewer = result;
      (req as any).authType = "session";

      // Throttled last_active_at update for session-backed tokens
      if (result.sessionId && result.lastActiveAt) {
        import("../services/sessions").then(({ createSessionService }) => {
          const svc = createSessionService(db);
          svc.updateLastActive(result.sessionId!, result.lastActiveAt!).catch(() => {});
        });
      }

      next();
    } catch (err: any) {
      if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
        if (config.mode === "cloud") {
          try {
            const helperPath = (): string => new URL("../../../../ee/api/auth/cloud-auth-helper.js", import.meta.url).href;
            const { validateSupabaseToken } = await import(helperPath());
            const cloudResult = await validateSupabaseToken(token, db);
            if (cloudResult) {
              (req as any).reviewer = cloudResult.reviewer;
              (req as any).authType = "session";
              if (cloudResult.organizationId) {
                (req as any).organizationId = cloudResult.organizationId;
              }
              if (cloudResult.subscription) {
                (req as any).subscription = cloudResult.subscription;
              }
              return next();
            }
          } catch {
            // Supabase validation failed — fall through to original error
          }
        }
        return next(new AuthenticationError("Invalid token", "invalid_token"));
      }
      next(err);
    }
  };
}
