/**
 * Flat config for ESLint v9, migrated from the legacy .eslintrc.json.
 *
 * The .eslintrc.json is preserved verbatim as the single source of truth for
 * rules; this file re-expresses it through FlatCompat so both formats stay in
 * sync during the migration window.
 *
 * Note: --ext is not supported under flat config; file selection is handled by
 * the `files` patterns below (the npm "lint" script still passes --ext, which
 * ESLint v9 tolerates for a directory target).
 */

const { FlatCompat } = require('@eslint/eslintrc');
const js = require('@eslint/js');
const tsParser = require('@typescript-eslint/parser');
const globals = require('globals');

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'release/**',
      'landing/**',
      'design-mockups/**',
    ],
  },

  // eslint:recommended + plugin:@typescript-eslint/recommended.
  // Scoped to TS/TSX to preserve the old `--ext .ts,.tsx` behaviour: flat config
  // applies to every file by default, whereas the eslintrc invocation never
  // linted plain .js (e.g. the AudioWorklet, which uses browser worklet globals
  // that `no-undef` would otherwise flag as undefined).
  ...compat
    .extends('eslint:recommended', 'plugin:@typescript-eslint/recommended')
    .map((config) => ({ ...config, files: ['**/*.ts', '**/*.tsx'] })),

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
