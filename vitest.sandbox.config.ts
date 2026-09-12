import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

// Explicit real-backend gate. Missing prerequisites fail; they never count as a skip.
export default defineConfig({
  ...baseConfig,
  test: { ...baseConfig.test, include: ["tests/host/bubblewrap-*.real.ts"] },
});
