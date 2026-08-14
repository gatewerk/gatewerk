import { GatewerkError } from "@gatewerk/shared";

// Local subclasses for status codes the shared package has no class for.
// They live in apps/api (not packages/shared) because only the API emits
// them; the envelope they serialize to is identical.
export class RateLimitError extends GatewerkError {
  constructor(message: string, code = "rate_limit_exceeded") {
    super(message, 429, "rate_limit", code);
    this.name = "RateLimitError";
  }
}

export class ServiceUnavailableError extends GatewerkError {
  constructor(message: string, code = "service_unavailable") {
    super(message, 503, "service_unavailable", code);
    this.name = "ServiceUnavailableError";
  }
}

export class NotImplementedError extends GatewerkError {
  constructor(message: string, code = "not_implemented") {
    super(message, 501, "not_implemented", code);
    this.name = "NotImplementedError";
  }
}

export class BadGatewayError extends GatewerkError {
  constructor(message: string, code = "bad_gateway") {
    super(message, 502, "bad_gateway", code);
    this.name = "BadGatewayError";
  }
}
