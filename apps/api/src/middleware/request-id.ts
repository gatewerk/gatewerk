import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

const INCOMING_HEADER = "x-request-id";
const OUTGOING_HEADER = "X-Request-Id";

// Validate caller-provided value to prevent log injection.
// Without this, a client could send `X-Request-Id: foo\r\n{"level":"error",...}`
// and forge structured log lines. URL-safe 8–128 chars is permissive enough to
// accept upstream proxy correlation IDs (UUIDs, ULIDs, GitHub-style 40-char hex).
const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function requestId() {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header(INCOMING_HEADER);
    const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    req.requestId = id;
    res.setHeader(OUTGOING_HEADER, id);
    next();
  };
}
