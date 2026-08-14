import type { Request, Response, NextFunction } from "express";
import { AuthenticationError } from "@gatewerk/shared";
import type { AppDb } from "@gatewerk/db";
import { validateApiKey, ipMatchesAllowlist } from "../lib/auth-helpers";
import { scheduleApiKeyUsageLog } from "./api-key-usage-log";

export function apiKeyAuth(db: AppDb) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return next(new AuthenticationError("Missing API key", "missing_api_key"));
    }

    const key = header.slice(7);
    if (!key.startsWith("gwk_")) {
      return next(new AuthenticationError("Invalid API key format", "invalid_api_key_format"));
    }

    try {
      const result = await validateApiKey(key, db);
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
      // authType mirrors dual-auth.ts:39. Without it `subjectFromRequest`
      // returns null and every downstream `requireScope(...)` 401s. Today
      // this is masked by `dualAuth` running as outer middleware at /api/v1
      // (it sets authType first), but an apiKeyAuth-only endpoint mounted
      // under any prefix NOT covered by dualRouter would silently fail
      // authorization with no signal that authType is the missing piece.
      (req as any).authType = "apikey";

      scheduleApiKeyUsageLog(db, result.apiKeyId, req, res);

      next();
    } catch (err) {
      next(err);
    }
  };
}
