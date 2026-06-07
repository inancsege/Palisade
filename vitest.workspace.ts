import { defineWorkspace } from 'vitest/config';

/**
 * The two-project array (T2-09, D20). Vitest 2.x reads this workspace and exposes the named
 * projects to `--project unit` / `--project integration`:
 *
 *  - `unit`        — extends the root `vitest.config.ts` (coverage + 80% gate); runs the full
 *                    `test/**` suite MINUS the model-gated `test/integration/tier2-*.test.ts` files.
 *                    This is `npm test`. The existing non-model integration suites stay in this gate.
 *  - `integration` — runs ONLY the model-gated `test/integration/tier2-*.test.ts` files with NO
 *                    coverage thresholds, so the opt-in real-model tests stay OUT of the 80% gate
 *                    WITHOUT a `coverage.exclude` entry (D20). This is `npm run test:integration`.
 *                    Currently: tier2-real (verdict correctness) + tier2-load (singleton + inflight
 *                    cap + warmup latency-ratio — success criteria 6 & 7). Both skip without
 *                    `PALISADE_MODELS_DIR`.
 */
export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      globals: true,
      include: ['test/**/*.test.ts'],
      exclude: ['test/integration/tier2-*.test.ts', 'node_modules/**'],
    },
  },
  {
    test: {
      name: 'integration',
      globals: true,
      include: ['test/integration/tier2-*.test.ts'],
    },
  },
]);
