import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
    globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "contracts/**",
    "swap-solver/**",
    "scripts/**",
  ]),
  {
    rules: {
      // Allow leading-underscore naming to mark intentionally-unused params.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // React Compiler diagnostics (eslint-plugin-react-hooks v7) — these are
      // PERFORMANCE / optimization advisories, not runtime-correctness rules, so
      // they are warnings (advisory) rather than CI-blocking errors. The genuine
      // correctness rules — react-hooks/rules-of-hooks and exhaustive-deps — remain
      // at their default ERROR level (rules-of-hooks already caught and we fixed a
      // real conditional-hook bug). Track these warnings for a future component
      // refactor; do NOT suppress rules-of-hooks.
      "react-hooks/set-state-in-effect": "warn", // cascading-render perf advisory
      "react-hooks/static-components": "warn", // component-defined-in-render advisory
      "react-hooks/preserve-manual-memoization": "warn", // memo the compiler can't keep
      "react-hooks/purity": "warn", // impure call in render (e.g. Date.now())
    },
  },
]);

export default eslintConfig;
