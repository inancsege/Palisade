import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPolicy } from '../../../src/policy/loader.js';
import type { PolicyConfig } from '../../../src/types/policy.js';

/**
 * Backward-compatibility regression suite (D2-11, D18; ROADMAP success criterion 3).
 *
 * Every v0.1-shaped policy fixture under `test/policy/fixtures/v01/` MUST validate and merge
 * under the v0.2 schema. The suite enumerates fixtures DYNAMICALLY via `readdirSync`, so dropping
 * a new fixture into the directory auto-extends coverage and a fixture can never be silently
 * skipped. If a v0.2 schema change ever stopped accepting a v0.1 policy, `loadPolicy` throws and
 * the corresponding case fails — that is the tamper gate for T-02-04-T.
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../policy/fixtures/v01');

function v01Fixtures(): string[] {
  return readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
}

describe('v0.1 policy backward-compat regression (fixtures/v01)', () => {
  const fixtures = v01Fixtures();

  it('discovers the v0.1 fixture corpus (>=3, including the example mirror)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
    expect(fixtures).toContain('example-mirror.yaml');
    expect(fixtures).toContain('baseline.yaml');
    expect(fixtures).toContain('full.yaml');
  });

  it.each(v01Fixtures())(
    'validates and merges v0.1 fixture %s under the v0.2 schema without throwing',
    (fixture) => {
      const path = join(FIXTURE_DIR, fixture);

      let merged: PolicyConfig | undefined;
      expect(() => {
        merged = loadPolicy(path);
      }).not.toThrow();

      // Proof the v0.2 schema accepted the v0.1 policy and merged it to a complete shape:
      // tier1.enabled is always defined post-merge, and the additive v0.2 tier2 defaults exist.
      expect(merged).toBeDefined();
      expect(merged!.detection.tier1.enabled).toBeDefined();
      expect(typeof merged!.detection.tier1.enabled).toBe('boolean');
      // Additive v0.2 fields are populated by mergePolicyWithDefaults even for a v0.1 file.
      expect(merged!.detection.tier2.ambiguous_band).toEqual([0.3, 0.7]);
      expect(merged!.version).toBe('1');
    },
  );
});
