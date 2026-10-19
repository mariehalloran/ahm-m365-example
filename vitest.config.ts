import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "telemetry/tests/**/*.test.ts",
      "probes/*/tests/**/*.test.ts",
      "runner/tests/**/*.test.ts",
      "shared/tests/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
  },
});
