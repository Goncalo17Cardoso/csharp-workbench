import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/unit/**/*.test.ts'], exclude: ['**/*.int.test.ts', '**/node_modules/**'] },
});
