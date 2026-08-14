import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../app";
import { openApiDocument } from "../openapi";

describe("OpenAPI spec", () => {
  const app = createApp();

  it("GET /api/v1/openapi.json returns the 3.1 document", async () => {
    const res = await request(app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body.info?.title).toBe("Gatewerk API");
  });

  it("spec is self-consistent: every $ref points at a declared component", () => {
    const refs: string[] = [];
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === "$ref" && typeof value === "string") refs.push(value);
        else walk(value);
      }
    };
    walk(openApiDocument);

    // Narrow, statically-typed lookup tables. Avoids dynamic property access
    // on arbitrary paths (prototype-pollution rule tripped on generic walker).
    const schemas = new Map(Object.entries(openApiDocument.components.schemas));
    const parameters = new Map(Object.entries(openApiDocument.components.parameters));
    const responses = new Map(Object.entries(openApiDocument.components.responses));

    for (const ref of refs) {
      expect(ref.startsWith("#/components/")).toBe(true);
      const suffix = ref.slice("#/components/".length);
      const [bucket, name] = suffix.split("/");
      if (bucket === "schemas") expect(schemas.has(name), `unresolved schema $ref: ${ref}`).toBe(true);
      else if (bucket === "parameters") expect(parameters.has(name), `unresolved parameter $ref: ${ref}`).toBe(true);
      else if (bucket === "responses") expect(responses.has(name), `unresolved response $ref: ${ref}`).toBe(true);
      else throw new Error(`unexpected $ref bucket: ${ref}`);
    }
  });

  it("GET /api/v1/postman.json returns a Postman Collection v2.1", async () => {
    const res = await request(app).get("/api/v1/postman.json");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    // Postman Collection v2.1 top shape: { info: { schema: ".../collection/v2.1.0/..." }, item: [...] }
    expect(typeof res.body.info).toBe("object");
    expect(res.body.info.schema).toMatch(/schema\.getpostman\.com\/json\/collection\/v2\.1\.0/);
    expect(Array.isArray(res.body.item)).toBe(true);
    expect(res.body.item.length).toBeGreaterThan(0);
  });

  it("each operation declares a stable operationId", () => {
    const ids = new Set<string>();
    for (const methods of Object.values(openApiDocument.paths)) {
      for (const [method, op] of Object.entries(methods as Record<string, unknown>)) {
        if (["get", "post", "put", "delete", "patch"].includes(method)) {
          const id = (op as any)?.operationId;
          expect(id, `missing operationId: ${method}`).toBeTruthy();
          expect(ids.has(id), `duplicate operationId: ${id}`).toBe(false);
          ids.add(id);
        }
      }
    }
    expect(ids.size).toBeGreaterThan(20);
  });
});
