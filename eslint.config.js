import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

// Type-aware rules need the TypeScript program. projectService finds the nearest tsconfig.json that
// includes each file (client/, server/, shared/ and the root each have one).
const typeAware = {
  projectService: true,
  tsconfigRootDir: import.meta.dirname,
};

export default defineConfig([
  globalIgnores([
    "**/dist/",
    "**/node_modules/",
    "server/logs/",
    "playwright-report/",
    "test-results/",
  ]),
  js.configs.recommended,
  {
    files: ["client/src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
    },
  },
  {
    files: [
      "client/scripts/**/*.mjs",
      "client/*.config.js",
      "client/test/**/*.js", // Vitest runs these in Node, not in a browser
      "server/**/*.js",
      "shared/**/*.js",
      "shared/**/*.mjs",
      "server/**/*.mjs",
      "scripts/**/*.mjs",
      "*.config.js",
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
  },

  // TypeScript (shared/, e2e/, tool configs): the full type-checked ruleset.
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: typeAware },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      // A leading underscore means "deliberately unused" (empty subclass hooks, `_exhaustive: never`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },

  // JavaScript (client/, server/): untyped code would drown the unsafe-any rules in noise, so only the
  // rules about promises run here. They are the ones that catch real server bugs: a forgotten `await`
  // or an un-handled rejection that crashes the process.
  {
    files: ["**/*.{js,mjs}"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ...typeAware, sourceType: "module" },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
]);
