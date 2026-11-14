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
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "TSTypeReference[typeName.name='ReturnType'] > TSTypeParameterInstantiation > TSTypeQuery[exprName.left.name='JSON'][exprName.right.name='parse']",
          message:
            "ReturnType<typeof JSON.parse> is `any`. Declare the fields you read, or use `unknown`.",
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Lint checks production code with type information, so an `any` cannot spread through it
    // unnoticed. The build tsconfigs cover src only. Lint does not type-check tests, which keeps it
    // fast. These rules read the plugin packages' dist, so build them first, as scripts/ci.sh does.
    files: ["src/**/*.ts", "plugins/*/src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.build.json", "./plugins/*/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
    },
  },
  {
    files: ["**/*.cjs", "**/*.cts"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
  },
  prettier,
]);
