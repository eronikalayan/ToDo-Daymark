'use strict';

// ESLint flat config (ESLint 10). Scope: the backend application source only.
// This is a correctness-oriented baseline, not a style enforcer: it is deliberately
// limited to rules that catch real defects, so that adopting it requires no
// reformatting of existing, working code (REF-005 / BE-026).
const js = require('@eslint/js');

// Node globals used by this codebase. Declared explicitly rather than pulling in
// the `globals` package, to keep the dev-dependency surface minimal.
const nodeGlobals = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly'
};

module.exports = [
  {
    // Never lint dependencies, generated output, or database files.
    ignores: ['node_modules/**', 'coverage/**', 'prisma/*.db', 'prisma/migrations/**']
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: nodeGlobals
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error'
    },
    rules: {
      ...js.configs.recommended.rules,

      // --- Correctness rules that matter for this codebase ---------------------
      // Express error middleware must keep its 4-argument signature, and several
      // handlers legitimately accept `next` without using it, so unused *arguments*
      // are allowed while unused variables and imports are still reported.
      // `ignoreRestSiblings` permits the deliberate rest-destructuring "omit" idiom
      // used in auth.controller.js (`const { maxAge, ...clearOptions } = ...`).
      'no-unused-vars': ['error', {
        args: 'none',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
        varsIgnorePattern: '^_'
      }],

      // A floating promise in a request handler silently swallows failures.
      'no-async-promise-executor': 'error',

      // `require-atomic-updates` is intentionally NOT enabled. It is not part of
      // eslint:recommended, and on this codebase it produces only false positives:
      // it flags `request.user = ...` after an await in middleware/authenticate.js,
      // but an Express `request` object is unique per request and never shared
      // between concurrent executions. The genuine non-atomic read-modify-write in
      // the codebase (BE-021, task.service.js) is a Prisma call-sequencing issue
      // that this rule cannot detect. A baseline linter must pass cleanly on correct
      // code, or the team learns to ignore it.

      // Guard against accidental assignment in conditionals and sloppy equality.
      'no-cond-assign': ['error', 'always'],
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // `console` is the current logging mechanism (BE-025 replaces it later);
      // allow it for now rather than forcing a premature change.
      'no-console': 'off'
    }
  },
  {
    // The test suite and the test runner script are Node programs too, but they
    // may legitimately use `process.exit` and long sequential assertions.
    files: ['test/**/*.js', 'scripts/**/*.js'],
    rules: {
      'no-unused-expressions': 'off'
    }
  }
];
