/**
 * Guards the one assumption src/ee-modules.d.ts rests on.
 *
 * That file declares an ambient `declare module "@ee/*"` so a public clone —
 * where the private submodule is absent — can still run `tsc --noEmit` instead
 * of failing with eleven TS2307s. The declaration is untyped, so every Cloud
 * module it answers for becomes `any`.
 *
 * That is fine only while it stays a FALLBACK. TypeScript consults ambient
 * wildcards after normal resolution fails, so with the submodule checked out
 * the "@ee/*" entry in tsconfig.json's `paths` should win and real types should
 * apply. If that precedence ever inverted — a tsconfig edit, a TypeScript
 * upgrade — every type error between src/ and the Cloud tree would silently
 * become `any` and stop being reported. Nothing else in the suite would notice:
 * typecheck would go greener, not redder.
 *
 * So this compiles a probe that is only an error if the real types are in
 * force, and fails if that error does not appear. It runs a small standalone
 * tsc rather than the app's full program, and skips entirely when the submodule
 * is absent, because with no real module there is nothing to take precedence.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const APP = join(__dirname, "..", "..");
const EE_PRESENT = existsSync(join(APP, "..", "..", "ee", "web-next"));

describe("ee shim precedence", () => {
  it.skipIf(!EE_PRESENT)("lets the real Cloud types win over the ambient fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-ee-precedence-"));
    const probe = join(dir, "probe.ts");
    const tsconfig = join(dir, "tsconfig.json");

    // PLAN_ROWS is a real exported array in ee/web-next/billing/BillingPane.tsx.
    // Assigning it to `number` is an error against the real type and legal
    // against `any`.
    writeFileSync(
      probe,
      `async function probe(): Promise<number> {\n` +
        `  const m = await import("@ee/billing/BillingPane");\n` +
        `  const wrong: number = m.PLAN_ROWS;\n` +
        `  return wrong;\n` +
        `}\n` +
        `void probe;\n`,
    );
    writeFileSync(
      tsconfig,
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          module: "ESNext",
          moduleResolution: "bundler",
          target: "ES2022",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          baseUrl: APP,
          paths: {
            "@ee/*": ["../../ee/web-next/*"],
            "~/*": ["./src/*"],
            "@gatewerk/web-core/*": ["../../packages/web-core/src/*"],
          },
          types: [],
        },
        files: [probe],
      }),
    );

    let output = "";
    try {
      execFileSync("node", [join(APP, "node_modules", "typescript", "bin", "tsc"), "-p", tsconfig], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      output = String((err as { stdout?: string }).stdout ?? "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(
      output,
      "the ambient @ee/* fallback is masking the real Cloud types — every type " +
        "error across the OSS/EE boundary would now go unreported",
    ).toContain("TS2322");
  });
});
