import type { Request, Response, NextFunction } from "express";

type LogLevel = "info" | "warn" | "error";

interface AccessLogLine {
  level: LogLevel;
  msg: "http_request";
  ts: string;
  request_id: string;
  method: string;
  path: string;
  route?: string;
  status: number;
  duration_ms: number;
  user_id?: string;
  user_agent?: string;
  content_length?: number;
}

const SENSITIVE_PARAMS = /([?&])(ticket|token|key|secret|password|code)=[^&]*/gi;
// Single-use external review tokens land in path segments under /r/:token
// and /api/v1/r/:token. Without redaction the raw token sits in plaintext
// access logs and can be replayed by anyone with log read access within
// the token's validity window. The token prefix `gw_tok_` is canonical;
// invite tokens are 64-hex strings and password-reset tokens use the
// base64url email-tokens shape (`<encoded>.<sig>`) — redact all three.
const SENSITIVE_PATHS = [
  /(\/(?:api\/v1\/)?r\/)(gw_tok_[^\/?]+)/gi,
  /(\/api\/v1\/auth\/invite\/)([^\/?]+)/gi,
  /(\/api\/v1\/auth\/reset-password\/)([^\/?]+)/gi,
];

function sanitizePath(url: string): string {
  let out = url;
  for (const re of SENSITIVE_PATHS) {
    out = out.replace(re, "$1[REDACTED]");
  }
  if (out.indexOf("?") !== -1) {
    out = out.replace(SENSITIVE_PARAMS, "$1$2=[REDACTED]");
  }
  return out;
}

function levelFor(status: number): LogLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}

export function requestLogging() {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const contentLengthHeader = res.getHeader("content-length");
      const contentLength =
        typeof contentLengthHeader === "string"
          ? Number(contentLengthHeader)
          : typeof contentLengthHeader === "number"
          ? contentLengthHeader
          : undefined;

      // req.route is only set after route matching; fall back to the raw path.
      const matchedRoute = (req as any).route?.path as string | undefined;
      // req.user is populated by api-key-auth / session-auth / dual-auth.
      const userId = (req as any).user?.id as string | undefined;

      const line: AccessLogLine = {
        level: levelFor(res.statusCode),
        msg: "http_request",
        ts: new Date().toISOString(),
        request_id: req.requestId,
        method: req.method,
        path: sanitizePath(req.originalUrl || req.url),
        status: res.statusCode,
        duration_ms: Math.round(durationMs * 100) / 100,
        user_agent: req.header("user-agent") || undefined,
      };
      if (matchedRoute) line.route = matchedRoute;
      if (userId) line.user_id = userId;
      if (Number.isFinite(contentLength)) line.content_length = contentLength;

      // One JSON line per request. stdout for normal traffic, stderr for 5xx.
      const out = line.level === "error" ? process.stderr : process.stdout;
      out.write(JSON.stringify(line) + "\n");
    });

    next();
  };
}
