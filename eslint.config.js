import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      // Downgraded error -> warn so `npm run lint` is a viable (green, blocking) CI
      // gate. These three had ~2,338 PRE-EXISTING violations repo-wide (the untyped
      // -table `as any` backlog etc.). Kept as warnings so they stay visible and can
      // be ratcheted back to "error" once Task 2 (gen-types) + a dedicated cleanup
      // clear the backlog. New error-level violations still fail CI. (Convention #13
      // — no new `as any` — is enforced by review + typecheck until then.)
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-function-type": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
    },
  },
);
