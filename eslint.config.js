import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/", "src-tauri/", "node_modules/", "docs/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The codebase deliberately uses the "latest ref" pattern (assign
      // someRef.current = value during render so long-lived effects see fresh
      // props without re-running). Safe here; the rule predates useEffectEvent.
      "react-hooks/refs": "off",
      // Panels intentionally reset/fetch state in effects keyed on cwd/selection.
      "react-hooks/set-state-in-effect": "off",
      // the codebase intentionally ignores some promise results (fire-and-forget invokes)
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  }
);
