import type { Request, Response, NextFunction } from "express";
import { AuthenticationError } from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import { validateApiKey, validateJwt, ipMatchesAllowlist } from "../lib/auth-helpers";
import { scheduleApiKeyUsageLog } from "./api-key-usage-log";
import { config } from "../config";

export function dualAuth(db: AppDb) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // EE cloud provisioning (/api/v1/cloud/*) authenticates itself via the
    // Supabase session inside its own route handler and MUST be reachable by
    // users who do not have a reviewer row yet — creating that row is exactly
    // what provisioning does. dualAuth's cloud fallback (validateSupabaseToken)
    // requires an EXISTING reviewer, so without this skip it returns
    // invalid_token before the provision route runs: an unbreakable
    // chicken-and-egg that blocks every first-time OAuth / email-confirmed
    // signup. dualRouter is mounted at /api/v1, so `originalUrl` is the full
    // path here. Billing routes (/api/v1/billing/*) are intentionally NOT
    // skipped — their callers are already provisioned.
    if (req.originalUrl.startsWith("/api/v1/cloud/")) return next();

    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return next(new AuthenticationError("Missing credentials", "missing_credentials"));
    }

    const token = header.slice(7);

    // API key path
    if (token.startsWith("gwk_")) {
      try {
        const result = await validateApiKey(token, db);
        if (!result) {
          return next(new AuthenticationError("Invalid API key", "invalid_api_key"));
        }
        if (result.expiresAt && result.expiresAt.getTime() <= Date.now()) {
          return next(new AuthenticationError("API key has expired", "key_expired"));
        }
        if (result.ipAllowlist && result.ipAllowlist.length > 0) {
          const clientIp = req.ip ?? "";
          if (!clientIp || !ipMatchesAllowlist(clientIp, result.ipAllowlist)) {
            return next(new AuthenticationError("Request IP is not allowed for this key", "ip_not_allowed"));
          }
        }
        (req as any).projectId = result.projectId;
        (req as any).apiKeyId = result.apiKeyId;
        (req as any).apiKeyPrefix = result.apiKeyPrefix;
        (req as any).scopes = result.scopes;
        (req as any).templateIds = result.templateIds;
        (req as any).defaultReviewer = result.defaultReviewer;
        (req as any).rateLimitPerHour = result.rateLimitPerHour;
        (req as any).authType = "apikey";
        scheduleApiKeyUsageLog(db, result.apiKeyId, req, res);
        return next();
      } catch (err) {
        return next(err);
      }
    }

    // JWT session path
    try {
      const result = await validateJwt(token, db);
      if (!result) {
        return next(new AuthenticationError("Invalid token", "invalid_token"));
      }
      (req as any).reviewer = result;
      (req as any).authType = "session";
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
