import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/types/**',
        'src/cli/index.ts',
        'src/cli/commands/claude.ts',
      ],
      reporter: ['text', 'lcov'],
      reportOnFailure: true,
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
      },
    },
  },
});
