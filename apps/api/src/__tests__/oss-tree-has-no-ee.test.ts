/*
 * The public repo must be shippable with the private `ee` submodule absent.
 *
 * These assertions fail on the commit that introduces them, on purpose: the
 * commercial trees still live inline under apps/ and packages/, and the
 * cloud-only dependencies are still declared by the public manifests. They
 * turn green as the split lands, and from then on they are what stops the
 * commercial code, or its dependency footprint, leaking back into the repo
 * that strangers clone.
 *
 * Note what is NOT asserted here: the presence of ./ee. This suite must pass
 * both on a contributor machine with the submodule checked out and in the
 * Lint workflow, which deliberately never checks it out.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const REPO = join(__dirname, "..", "..", "..", "..");

describe("OSS tree without ee", () => {
  it("keeps no ee directory inside published packages", () => {
    for (const p of [
      "apps/api/ee",
      "apps/web-next/ee",
      "packages/emails/src/ee",
      "packages/emails/src/templates/ee",
    ]) {
      expect(existsSync(join(REPO, p)), `${p} must not exist inline`).toBe(false);
    }
  });

  it("keeps cloud-only dependencies out of the public manifests", async () => {
    // "resend" was briefly exempt here. It was the one entry on the split
    // plan's cloud-only list that was not actually cloud-only: the OSS tree
    // imported it statically and used it whenever RESEND_API_KEY was set, a
    // condition on the env var rather than on GATEWERK_MODE. Ruled
    // Cloud-only, so the transport moved to ee/api/adapters and the
    // selection is now gated on mode. It belongs on this list again.
    const CLOUD_ONLY = [
      "stripe",
      "@supabase/supabase-js",
      "resend",
      "@sentry/bun",
      "@sentry/react",
      "posthog-node",
      "posthog-js",
      "@marsidev/react-turnstile",
    ];
    for (const manifest of ["apps/api/package.json", "apps/web-next/package.json"]) {
      const pkg = JSON.parse(await readFile(join(REPO, manifest), "utf8"));
      const declared = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const dep of CLOUD_ONLY) {
        expect(declared[dep], `${manifest} must not declare ${dep}`).toBeUndefined();
      }
    }
  });
});
