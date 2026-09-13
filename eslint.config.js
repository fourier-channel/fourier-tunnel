// What this linter is FOR, and why it is gated.
//
// On 2026-09-13 `await sleep(750)` ran in production for weeks. `sleep` was
// never declared, never imported, and is not a Node global. It threw
// ReferenceError on every backfilled image -- AFTER the image had been
// uploaded, tagged and posted -- so a run of 266 pictures reported
// "0 done, 266 failed" while the booru filled up correctly, and the 750ms
// pacing it existed to provide never once happened.
//
// No test suite catches that. The line only runs against a live homeserver, and
// a unit test that could reach it would have to fake the whole bridge. A linter
// catches it by reading the file. That is the entire argument for this file.
//
// IT IS IN THE GATE (coherence.gate.yaml), not a convenience script. A lint
// nobody runs is not a check: fourier-sampling's eslint rotted to 22 errors
// while every session wrote it off as somebody else's business, which is the
// memory `lint-was-ungated-and-rotted`. Ungated, this would have rotted the
// same way and this comment would be its epitaph.
//
// DELIBERATELY NARROW. This is not a style pass and must not become one --
// formatting arguments in the gate are how a gate starts getting skipped. The
// rules below are the ones whose violation is a BUG, not a preference.

"use strict";

const NODE_GLOBALS = {
  require: "readonly",
  module: "writable",
  exports: "writable",
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  fetch: "readonly",
  FormData: "readonly",
  Blob: "readonly",
  structuredClone: "readonly",
  globalThis: "readonly",
};

module.exports = [
  {
    files: ["**/*.js"],
    ignores: ["node_modules/**"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: NODE_GLOBALS,
    },
    linterOptions: {
      // An unused disable comment is a rule someone silenced and then fixed.
      // Left behind, it silences the NEXT occurrence too.
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // THE ONE THAT MATTERS. `sleep` was undefined for weeks.
      "no-undef": "error",

      // The same defect one step earlier: a name that exists but holds nothing
      // useful, and a value computed and dropped. Both are how a half-finished
      // edit survives review.
      "no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_" }],

      // Silent corruption, all of them: a duplicate key or method quietly wins
      // over the one above it, and a duplicate case never runs.
      "no-dupe-keys": "error",
      "no-dupe-class-members": "error",
      "no-duplicate-case": "error",
      "no-dupe-else-if": "error",

      // `await` inside a non-async function is a syntax error; these are its
      // subtler cousins -- code that reads as sequenced and is not.
      "require-atomic-updates": "error",
      "no-async-promise-executor": "error",
      "no-promise-executor-return": "error",

      // An unreachable statement or a fallthrough is a claim about control flow
      // that is false. Both have cost this org real incidents in other repos.
      "no-unreachable": "error",
      "no-fallthrough": "error",

      // Comparing with == across types is how "0" and 0 and "" stop agreeing.
      eqeqeq: ["error", "smart"],

      // A catch that binds nothing and does nothing is the silent-failure shape
      // the operator ruled against on 2026-09-13.
      "no-empty": ["error", { allowEmptyCatch: false }],

      "no-self-compare": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-sparse-arrays": "error",
      "no-cond-assign": ["error", "always"],
      "no-return-assign": ["error", "always"],
    },
  },
  {
    // Test files get the runner's own globals. Nothing is relaxed beyond that:
    // an undefined identifier in a test is the same bug wearing a lab coat.
    files: ["**/*.test.js"],
    languageOptions: { globals: { ...NODE_GLOBALS, describe: "readonly", it: "readonly", before: "readonly", after: "readonly", beforeEach: "readonly", afterEach: "readonly" } },
  },
];
