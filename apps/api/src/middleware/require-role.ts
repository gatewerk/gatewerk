import type { RequestHandler } from "express";
import { AuthenticationError, ForbiddenError } from "@gatewerk/shared";

export function requireRole(...roles: string[]): RequestHandler {
  return (req: any, _res, next) => {
    if (!req.reviewer) {
      return next(new AuthenticationError("Authentication required", "authentication_required"));
    }
    if (!roles.includes(req.reviewer.role)) {
      return next(new ForbiddenError(`This action requires one of these roles: ${roles.join(", ")}`));
    }
    next();
  };
}
