import { defineConfig } from 'vitest/config';

// Vitest 4+ no longer skips dist/ by default, so compiled copies of the
// tests (apps/server/dist/**/*.test.js) would run twice. Only run sources.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
  },
});
