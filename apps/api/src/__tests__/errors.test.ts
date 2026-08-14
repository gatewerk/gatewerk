import { describe, it, expect } from "vitest";
import {
  GatewerkError,
  InvalidRequestError,
  NotFoundError,
  ConflictError,
  AuthenticationError,
  ForbiddenError,
} from "@gatewerk/shared";

describe("Actionable Errors", () => {
  it("InvalidRequestError has correct shape", () => {
    const err = new InvalidRequestError("Template not found", "template", "template_not_found");
    expect(err).toBeInstanceOf(GatewerkError);
    expect(err).toBeInstanceOf(InvalidRequestError);
    expect(err.statusCode).toBe(400);
    expect(err.type).toBe("invalid_request");
    expect(err.code).toBe("template_not_found");
    expect(err.message).toBe("Template not found");
    expect(err.param).toBe("template");
  });

  it("NotFoundError has correct shape", () => {
    const err = new NotFoundError("Review not found", "review_not_found");
    expect(err.statusCode).toBe(404);
    expect(err.type).toBe("not_found");
    expect(err.code).toBe("review_not_found");
  });

  it("ConflictError has correct shape", () => {
    const err = new ConflictError("Review already decided", "review_already_decided");
    expect(err.statusCode).toBe(409);
    expect(err.type).toBe("conflict");
    expect(err.code).toBe("review_already_decided");
  });

  it("AuthenticationError has correct shape", () => {
    const err = new AuthenticationError("Invalid API key");
    expect(err.statusCode).toBe(401);
    expect(err.type).toBe("authentication_error");
  });

  it("ForbiddenError has correct shape", () => {
    const err = new ForbiddenError("API key required");
    expect(err.statusCode).toBe(403);
    expect(err.type).toBe("forbidden");
  });

  it("toJSON produces Stripe-style error envelope", () => {
    const err = new InvalidRequestError(
      "Template 'proposal-review' does not exist",
      "template",
      "template_not_found"
    );
    const json = err.toJSON();
    expect(json).toEqual({
      error: {
        type: "invalid_request",
        code: "template_not_found",
        message: "Template 'proposal-review' does not exist",
        param: "template",
        doc_url: "https://docs.gatewerk.dev/errors/template_not_found",
      },
    });
  });

  it("toJSON omits param when not set", () => {
    const err = new NotFoundError("Review not found", "review_not_found");
    const json = err.toJSON();
    expect(json.error.param).toBeUndefined();
  });
});
