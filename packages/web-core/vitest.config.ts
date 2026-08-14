import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@gatewerk/web-core": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules", "dist", "build"],
    testTimeout: 10000,
    // Carried over from apps/web/vitest.config.ts with these tests. Vitest 4
    // made vi.spyOn idempotent — repeated spies on the same target share
    // call-count state instead of creating fresh spies. Without this, counts
    // accumulate across tests: _helpers.test.ts asserts warn was called once
    // and sees two. Dropping it is not a cosmetic config difference.
    clearMocks: true,
  },
});
