import obsidianmd from "eslint-plugin-obsidianmd";

// Lint handwritten client/server source and directory metadata, not bundles.
// No rule suppressions: warnings fail CI as well as errors.
export default [
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {parserOptions: {projectService:true, tsconfigRootDir:import.meta.dirname}},
    rules: {"@typescript-eslint/no-unnecessary-type-assertion":"error"},
  },
];
