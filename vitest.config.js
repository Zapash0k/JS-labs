import { defineConfig } from "vitest/config";

// One runner for the whole repo (Lab 07). `npm test` runs every project; `npm test -- --project shared`
// runs one. Coverage is measured on shared/ only (the code that runs on both sides).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "shared",
          root: "./shared",
          include: ["test/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "client",
          root: "./client",
          include: ["test/**/*.test.js"],
        },
      },
      {
        test: {
          name: "server",
          root: "./server",
          include: ["test/**/*.test.js"],
          testTimeout: 15_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["**/shared/src/**/*.ts"],
      reporter: ["text-summary", "text", "html"],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
});
