import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Protocol §4: "The eval split is read ONLY by `bench/evaluate.ts`. A unit test asserts no
 * other `bench/` file reads from the eval partition (prevents train-on-test leakage)."
 *
 * This is the assertion. If a bake-off or corpus script starts reading the eval partition,
 * its numbers would be train-on-test and this fails.
 */

const BENCH_DIR = join(process.cwd(), 'bench');
const PERMITTED = ['evaluate.ts'];

/** Anything that reaches the held-out partition. */
const EVAL_ACCESS = [/\bevaluation\b/, /\bsplitCorpus\s*\(/, /\beval[_-]?split\b/i];

function benchFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      benchFiles(path, out);
    } else if (/\.(ts|mjs|js)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe('eval-split leakage guard (protocol §4)', () => {
  it('finds the bench scripts it is meant to police', () => {
    expect(benchFiles(BENCH_DIR).length).toBeGreaterThan(0);
  });

  it('permits only bench/evaluate.ts to read the eval partition', () => {
    const offenders: string[] = [];

    for (const path of benchFiles(BENCH_DIR)) {
      const rel = relative(BENCH_DIR, path);
      if (PERMITTED.includes(rel)) continue;

      const source = readFileSync(path, 'utf-8');
      if (EVAL_ACCESS.some((re) => re.test(source))) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  it('still names bench/evaluate.ts as the permitted evaluator', () => {
    // Guards against the allowlist silently drifting away from the protocol.
    expect(PERMITTED).toEqual(['evaluate.ts']);
  });
});
