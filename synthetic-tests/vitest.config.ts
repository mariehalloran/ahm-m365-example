import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "exchange/tests/**/*.test.ts",
      "teams/tests/**/*.test.ts",
      "onedrive/tests/**/*.test.ts",
      "utils/tests/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
  },
});
