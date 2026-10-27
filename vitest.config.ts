import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.int.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
