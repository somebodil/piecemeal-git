import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores(["node_modules", "main.js", "esbuild.config.mjs"]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
      },
    },
  },
  {
    // What runs on Node.js only: the tests, the git server they talk to, and files and HTTP for them
    files: ["**/*.test.ts", "src/testing/**", "src/platform/node.ts"],
    rules: {
      "obsidianmd/no-nodejs-modules": "off",
      "no-restricted-globals": "off",
      "obsidianmd/rule-custom-message": "off",
      "obsidianmd/prefer-window-timers": "off",
    },
  },
  {
    // `describe` and `it` of node:test return promises that the test runner takes care of
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
]);
