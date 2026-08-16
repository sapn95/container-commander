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
  URL: 'readonly',
  URLSearchParams: 'readonly',
  console: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
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
    files: ['tests/**/*.js', 'scripts/**/*.mjs', '*.config.js'],
    languageOptions: { globals: { ...BROWSER, process: 'readonly', Buffer: 'readonly' } },
  },
];
