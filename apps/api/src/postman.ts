// Lazy Postman Collection v2.1 generator, derived from `openapi.ts`.
//
// Conversion runs once per process on first request and the result is cached
// in-memory. The spec is ~34 KB and conversion completes in well under a
// second, so a warm cache cost is irrelevant; we still pay it lazily so cold
// boot stays fast and tests that never hit the endpoint never import the
// converter.

import { convertV2, type CollectionResult } from "openapi-to-postmanv2";
import { openApiDocument } from "./openapi";

let cached: object | null = null;
let inflight: Promise<object> | null = null;

function runConversion(): Promise<object> {
  return new Promise((resolve, reject) => {
    convertV2(
      { type: "json", data: openApiDocument as unknown as object },
      { folderStrategy: "Tags", requestNameSource: "Fallback" },
      (err: { message: string } | null, result?: CollectionResult) => {
        if (err) return reject(new Error(err.message));
        if (!result?.result) return reject(new Error(result?.reason || "postman conversion failed"));
        const collection = result.output?.[0]?.data;
        if (!collection) return reject(new Error("postman conversion returned no collection"));
        resolve(collection);
      },
    );
  });
}

export async function getPostmanCollection(): Promise<object> {
  if (cached) return cached;
  if (!inflight) {
    inflight = runConversion()
      .then((col) => { cached = col; return col; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}
