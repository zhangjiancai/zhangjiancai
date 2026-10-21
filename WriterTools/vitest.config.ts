import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/engine/**/*.test.ts'],
    setupFiles: ['tests/support/setup-vitest.ts'],
  },
});
