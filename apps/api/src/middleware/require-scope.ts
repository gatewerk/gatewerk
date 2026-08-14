import type { RequestHandler } from "express";
import type { Scope } from "@gatewerk/shared";
import { AuthenticationError, ForbiddenError } from "@gatewerk/shared";
import { can, subjectFromRequest } from "../policy";

export function requireScope(...scopes: Scope[]): RequestHandler {
  return (req, _res, next) => {
    const subject = subjectFromRequest(req);
    if (!subject) {
      return next(new AuthenticationError("Authentication required", "authentication_required"));
    }

    const decision = can(subject, scopes);
    if (!decision.allow) {
      console.warn("authz.deny", {
        request_id: (req as any).requestId,
        subject_kind: subject.kind,
        required_scopes: scopes,
        reason: decision.reason,
      });
      return next(new ForbiddenError(`Missing required scope(s): ${scopes.join(", ")}`));
    }

    next();
  };
}
