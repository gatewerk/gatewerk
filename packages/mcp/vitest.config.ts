import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      gatewerk: path.resolve(__dirname, "../sdk-ts/src/index.ts"),
    },
  },
});
