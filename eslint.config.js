import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["**/dist/", "**/node_modules/", "server/logs/"] },
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
      "server/**/*.js",
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
];
