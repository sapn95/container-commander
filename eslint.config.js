import js from '@eslint/js';

// The browser globals an extension actually gets. Listed explicitly rather than
// pulled from a globals package: the surface is small, and a short list here is
// itself documentation of what this code is allowed to touch.
const BROWSER = {
  browser: 'readonly',
  chrome: 'readonly',
  globalThis: 'readonly',
  document: 'readonly',
  KeyboardEvent: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

// What scripts/ and tests/ get on top of that. This half is Node, and the AMO
// uploader talks HTTP with the platform's own fetch rather than with a
// dependency — so the three web globals it needs are listed here and not
// borrowed from BROWSER, which is about what the extension may touch.
const NODE = {
  process: 'readonly',
  Buffer: 'readonly',
  fetch: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
  Response: 'readonly',
  AbortSignal: 'readonly',
};

export default [
  // dist/ is a copy of src/. Linting it reports every finding twice and
  // invites somebody to 'fix' a generated file.
  { ignores: ['dist/**', 'coverage/**'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: BROWSER },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
  {
    // .mjs too: the test helpers that stub a network are modules, and a glob
    // that missed them reported every Node global in them as undefined.
    files: ['tests/**/*.js', 'tests/**/*.mjs', 'scripts/**/*.mjs', '*.config.js'],
    languageOptions: { globals: { ...BROWSER, ...NODE } },
  },
];
