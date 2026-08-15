import type { Request, Response, NextFunction, RequestHandler } from "express";
import { z } from "zod";
import { GatewerkError } from "@gatewerk/shared";

type Segment = "body" | "query" | "params";

export class ValidationError extends GatewerkError {
  readonly details: Array<{ path: string; message: string; code: string }>;

  constructor(segment: Segment, issues: z.ZodIssue[]) {
    const details = issues.map((i) => ({
      path: [segment, ...i.path.map(String)].join("."),
      message: i.message,
      code: i.code ?? "invalid",
    }));
    const primary = details[0];
    super(
      `Invalid ${segment}: ${primary?.message ?? "validation failed"}`,
      422,
      "invalid_request",
      "validation_failed",
      primary?.path,
    );
    this.name = "ValidationError";
    this.details = details;
  }

  toJSON() {
    const base = super.toJSON() as { error: Record<string, unknown> };
    base.error.details = this.details;
    return base;
  }
}

export interface ValidateSpec<
  B extends z.ZodTypeAny | undefined = undefined,
  Q extends z.ZodTypeAny | undefined = undefined,
  P extends z.ZodTypeAny | undefined = undefined,
> {
  body?: B;
  query?: Q;
  params?: P;
}

export function validate<
  B extends z.ZodTypeAny | undefined = undefined,
  Q extends z.ZodTypeAny | undefined = undefined,
  P extends z.ZodTypeAny | undefined = undefined,
>(spec: ValidateSpec<B, Q, P>): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (spec.body) {
        // express 5 leaves req.body undefined when no parser matched;
        // express 4 gave {}. Keep {} so bodies with only optional fields
        // stay legal on a body-less request.
        const parsed = spec.body.safeParse(req.body ?? {});
        if (!parsed.success) throw new ValidationError("body", parsed.error.issues);
        req.body = parsed.data;
      }
      if (spec.query) {
        const parsed = spec.query.safeParse(req.query);
        if (!parsed.success) throw new ValidationError("query", parsed.error.issues);
        // express 5 exposes req.query through a prototype getter with no
        // setter, so plain assignment throws; an own property shadows it.
        Object.defineProperty(req, "query", {
          value: parsed.data as Request["query"],
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      if (spec.params) {
        const parsed = spec.params.safeParse(req.params);
        if (!parsed.success) throw new ValidationError("params", parsed.error.issues);
        req.params = parsed.data as Request["params"];
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
