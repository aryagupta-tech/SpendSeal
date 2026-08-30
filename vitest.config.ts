import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/server/test/**/*.test.ts", "apps/extension/src/**/*.test.ts"],
    environment: "node",
    coverage: { reporter: ["text", "html"] },
  },
});
