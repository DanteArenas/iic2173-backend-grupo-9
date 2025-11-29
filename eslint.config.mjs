import js from "@eslint/js";
import globals from "globals";

const recommended = js.configs.recommended;
const sharedRules = {
  ...recommended.rules,
  "no-console": "off",
  "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
};

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.serverless/**",
      "**/coverage/**",
      "db/**",
      "docs/**",
      "sql/**",
    ],
  },
  {
    ...recommended,
    files: ["**/*.js"],
    languageOptions: {
      ...recommended.languageOptions,
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: sharedRules,
  },
  {
    ...recommended,
    files: [
      "boletas-serverless/**/*.js",
      "src/job_master/**/*.js",
      "src/rec-worker/**/*.js",
    ],
    languageOptions: {
      ...recommended.languageOptions,
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: sharedRules,
  },
];
