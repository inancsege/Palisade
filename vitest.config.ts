import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types/**', 'src/cli/index.ts'],
      reporter: ['text', 'lcov'],
      reportOnFailure: true,
    },
  },
});
