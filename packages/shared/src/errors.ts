const DOCS_BASE = "https://docs.gatewerk.dev/errors";

export class GatewerkError extends Error {
  readonly statusCode: number;
  readonly type: string;
  readonly code: string;
  readonly param?: string;

  constructor(message: string, statusCode: number, type: string, code: string, param?: string) {
    super(message);
    this.name = "GatewerkError";
    this.statusCode = statusCode;
    this.type = type;
    this.code = code;
    this.param = param;
  }

  toJSON() {
    const error: Record<string, unknown> = {
      type: this.type,
      code: this.code,
      message: this.message,
    };
    if (this.param) {
      error.param = this.param;
    }
    error.doc_url = `${DOCS_BASE}/${this.code}`;
    return { error };
  }
}

export class InvalidRequestError extends GatewerkError {
  constructor(message: string, param?: string, code = "invalid_request") {
    super(message, 400, "invalid_request", code, param);
    this.name = "InvalidRequestError";
  }
}

export class NotFoundError extends GatewerkError {
  constructor(message: string, code = "not_found") {
    super(message, 404, "not_found", code);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends GatewerkError {
  constructor(message: string, code = "conflict") {
    super(message, 409, "conflict", code);
    this.name = "ConflictError";
  }
}

export class AuthenticationError extends GatewerkError {
  constructor(message = "Invalid or missing API key", code = "authentication_error") {
    super(message, 401, "authentication_error", code);
    this.name = "AuthenticationError";
  }
}

export class ForbiddenError extends GatewerkError {
  constructor(message = "Insufficient permissions", code = "forbidden") {
    super(message, 403, "forbidden", code);
    this.name = "ForbiddenError";
  }
}

export class GoneError extends GatewerkError {
  constructor(message: string, code = "gone") {
    super(message, 410, "gone", code);
    this.name = "GoneError";
  }
}

export class PayloadTooLargeError extends GatewerkError {
  constructor(message: string, code = "payload_too_large") {
    super(message, 413, "payload_too_large", code);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Raised at process boot when required configuration is missing or uses an
 * insecure default. This terminates startup before the HTTP server binds, so
 * it never reaches a client; it is not a request-path error. Subclasses
 * `GatewerkError` purely for consistency with the rest of the error surface.
 */
export class BootError extends GatewerkError {
  constructor(message: string, code = "boot_error") {
    super(message, 500, "boot_error", code);
    this.name = "BootError";
  }
}
