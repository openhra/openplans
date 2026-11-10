import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "**/node_modules/**",
    "**/dist/**",
    "**/coverage/**",
    "**/.git/**",
    "**/.claude-plan/**",
    "**/.venv/**",
    "**/__pycache__/**",
    "**/fixtures/**/*",
    "!**/fixtures/**/",
    "!**/fixtures/**/*.{js,mjs,cjs,ts,mts,cts}",
    "**/__snapshots__/**",
    "src/domain/subsidy/generated.ts",
    "src/domain/ichra/generated.ts",
    "public-scaffold/**",
    "brand/**",
    "docs/PLAN.md",
    "docs/lanes/**",
    "docs/kit/**",
  ]),
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.nodeBuiltin,
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-nested-ternary": "error",
      "no-unused-vars": ["error", { ignoreRestSiblings: true }],
    },
  },
  {
    files: ["**/*.{ts,mts,cts}"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ["**/*.cjs", "**/*.cts"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
  },
  prettier,
]);
