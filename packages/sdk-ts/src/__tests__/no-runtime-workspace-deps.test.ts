import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const SRC = join(__dirname, "..");

/**
 * The SDK is published to npm. `@gatewerk/shared` is `private: true` and
 * never is. So a VALUE import of it survives compilation into dist/ and makes
 * the published package unresolvable for every user:
 *
 *   Cannot find package '@gatewerk/shared' imported from .../dist/station.js
 *
 * That shipped in gatewerk@0.1.0 and broke `npx @gatewerk/mcp` on the first
 * command a stranger would run. `import type` is fine — it erases. This test
 * exists because the whole suite passed while the published artifact was
 * unusable: nothing here ever imports the built output the way Node does.
 *
 * Relative specifiers must also carry a .js extension. The repo's base
 * tsconfig uses moduleResolution "bundler", which lets tsc emit extensionless
 * imports — fine inside Vite, invalid for Node ESM, and this package is
 * "type": "module".
 */
async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("published SDK carries no workspace runtime dependency", () => {
  it("never imports @gatewerk/shared as a value", async () => {
    const offenders: string[] = [];
    for (const file of await tsFiles(SRC)) {
      const src = await readFile(file, "utf8");
      for (const line of src.split("\n")) {
        // `import type { … } from "@gatewerk/shared"` erases at compile time.
        // Anything else from that specifier does not.
        if (!line.includes("@gatewerk/shared")) continue;
        if (!/^\s*(import|export)\s/.test(line)) continue;
        if (/^\s*(import|export)\s+type\s/.test(line)) continue;
        offenders.push(`${file.replace(SRC, "src")}: ${line.trim()}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("gives every relative import a .js extension for Node ESM", async () => {
    const offenders: string[] = [];
    for (const file of await tsFiles(SRC)) {
      const src = await readFile(file, "utf8");
      for (const m of src.matchAll(/from\s+"(\.\.?\/[^"]+)"/g)) {
        if (!m[1].endsWith(".js") && !m[1].endsWith(".json")) {
          offenders.push(`${file.replace(SRC, "src")}: ${m[1]}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
