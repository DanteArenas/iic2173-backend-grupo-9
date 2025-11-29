import js from "@eslint/js";
import globals from "globals";

const recommended = js.configs.recommended;

export default [
  {
    ignores: ["dist", ".serverless"],
  },
  {
    ...recommended,
    files: ["**/*.js"],
    languageOptions: {
      ...recommended.languageOptions,
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...recommended.rules,
      "no-console": "off",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];
