import { defineConfig } from 'vitest/config';

/**
 * Two-project layout (T2-09, D20) — see `vitest.workspace.ts` for the project array.
 *
 *  - the `unit` project runs the full fast suite (`test/**`) MINUS the single model-gated
 *    real-verdict test (`test/integration/tier2-real.test.ts`) and owns the v8 coverage with the
 *    80% line gate. This is `npm test` / `npm run test:coverage` (`vitest run --project unit`). The
 *    existing non-model integration suites (cli-smoke, streaming-pipeline, proxy-scenarios,
 *    concurrent-requests) STAY in this gate — only the 700MB-model test is carved out.
 *  - the `integration` project runs ONLY `test/integration/tier2-real.test.ts` (the opt-in,
 *    model-gated real-verdict test) with NO coverage thresholds, so the heavy model test is OUT of
 *    the 80% gate WITHOUT adding it to `coverage.exclude` (which would have loosened the src gate).
 *
 * The project definitions (including the `test/integration/**` integration include) live in
 * `vitest.workspace.ts`; this root config holds the shared coverage settings the `unit` project
 * extends.
 */
export default defineConfig({
  test: {
    globals: true,
    // The `unit` project include; the single model-gated test/integration/tier2-real test is the
    // ONLY file carved out of the unit run + coverage gate (the integration project owns it).
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/tier2-real.test.ts', 'node_modules/**'],
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
