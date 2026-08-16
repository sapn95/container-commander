import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      // The pure layer carries the whole risk of this extension — deciding
      // whether to move somebody's tab into another identity — so it is held
      // far above the repository floor. Every metric has a bound, functions
      // included: without one, a whole function can be added and never called
      // while the statement percentage barely moves.
      thresholds: {
        'src/lib/**': { statements: 95, branches: 90, functions: 95, lines: 95 },
        'src/**': { statements: 80, branches: 80, functions: 80, lines: 80 },
      },
    },
  },
});
