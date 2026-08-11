/**
 * The evaluator named by `docs/benchmark-protocol.md` §4:
 *
 *   "The eval split is read ONLY by `bench/evaluate.ts`. A unit test asserts no other
 *    `bench/` file reads from the eval partition (prevents train-on-test leakage)."
 *
 * The implementation lives under `src/bench/` so it is type-checked, unit-tested and
 * reachable from `palisade benchmark`; this file is the protocol-named entry point and is
 * the ONLY file under `bench/` permitted to touch the eval partition. The leakage guard in
 * `test/unit/bench/leakage.test.ts` enforces that.
 *
 * Usage:
 *   npx tsx bench/evaluate.ts            # equivalent to `palisade benchmark`
 */
import { splitCorpus } from '../src/bench/split.js';
import { loadCorpus } from '../src/bench/corpus.js';

export { splitCorpus, loadCorpus };

if (import.meta.url === `file://${process.argv[1]}`) {
  const { benchmarkCommand } = await import('../src/cli/commands/benchmark.js');
  await benchmarkCommand.parseAsync(process.argv.slice(2), { from: 'user' });
}
