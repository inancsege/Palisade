import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  validatePolicy,
  mergePolicyWithDefaults,
  validateAndMerge,
  loadPolicy,
} from '../../../src/policy/loader.js';
import { PolicyError } from '../../../src/utils/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_POLICY_PATH = resolve(__dirname, '../../../policy.example.yaml');

describe('tier2 policy schema (v0.2 extension)', () => {
  describe('backwards compatibility (v0.1 policies)', () => {
    it('validates a v0.1 tier2 shape with only enabled/threshold/action', () => {
      const errors = validatePolicy({
        version: '1',
        detection: { tier2: { enabled: false, threshold: 0.75, action: 'warn' } },
      });
      expect(errors).toHaveLength(0);
    });

    it('validates a fully-specified v0.2 tier2 block', () => {
      const errors = validatePolicy({
        version: '1',
        detection: {
          tier2: {
            enabled: false,
            threshold: 0.75,
            action: 'warn',
            ambiguous_band: [0.3, 0.7],
            calibration: { temperature: 1.0, bias: 0 },
            max_input_chars: 4000,
            model_path: '/x',
          },
        },
      });
      expect(errors).toHaveLength(0);
    });

    it('loads the shipped policy.example.yaml under the v0.2 schema', () => {
      const policy = loadPolicy(EXAMPLE_POLICY_PATH);
      // v0.1 example sets tier2.{enabled,threshold,action}; v0.2 defaults fill the rest.
      expect(policy.detection.tier2.action).toBe('block');
      expect(policy.detection.tier2.threshold).toBe(0.75);
      expect(policy.detection.tier2.ambiguous_band).toEqual([0.3, 0.7]);
      expect(policy.detection.tier2.calibration).toEqual({ temperature: 1.0, bias: 0 });
      expect(policy.detection.tier2.max_input_chars).toBe(4000);
    });

    it('rejects an unknown key under tier2 (additionalProperties:false preserved)', () => {
      const errors = validatePolicy({
        version: '1',
        detection: { tier2: { bogus: 1 } },
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an ambiguous_band with the wrong number of elements', () => {
      const errors = validatePolicy({
        version: '1',
        detection: { tier2: { ambiguous_band: [0.3] } },
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an ambiguous_band value outside 0..1', () => {
      const errors = validatePolicy({
        version: '1',
        detection: { tier2: { ambiguous_band: [0.3, 1.5] } },
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a non-positive calibration temperature', () => {
      const errors = validatePolicy({
        version: '1',
        detection: { tier2: { calibration: { temperature: 0, bias: 0 } } },
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an unknown key under calibration', () => {
      const errors = validatePolicy({
        version: '1',
        detection: { tier2: { calibration: { temperature: 1.0, bias: 0, bogus: 1 } } },
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('defaults flow through mergePolicyWithDefaults', () => {
    it('fills in tier2 v0.2 defaults while keeping v0.1 fields', () => {
      const merged = mergePolicyWithDefaults({ version: '1' });
      expect(merged.detection.tier2.ambiguous_band).toEqual([0.3, 0.7]);
      expect(merged.detection.tier2.calibration).toEqual({ temperature: 1.0, bias: 0 });
      expect(merged.detection.tier2.max_input_chars).toBe(4000);
      expect(merged.detection.tier2.enabled).toBe(false);
      expect(merged.detection.tier2.threshold).toBe(0.75);
      expect(merged.detection.tier2.action).toBe('warn');
    });

    it('lets a partial tier2 override only the supplied fields', () => {
      const merged = mergePolicyWithDefaults({
        version: '1',
        detection: { tier2: { enabled: true, max_input_chars: 8000 } },
      });
      expect(merged.detection.tier2.enabled).toBe(true);
      expect(merged.detection.tier2.max_input_chars).toBe(8000);
      // unsupplied fields still fall back to defaults
      expect(merged.detection.tier2.ambiguous_band).toEqual([0.3, 0.7]);
      expect(merged.detection.tier2.calibration).toEqual({ temperature: 1.0, bias: 0 });
    });
  });

  describe('cross-field ambiguous_band validation (post-merge)', () => {
    it('accepts the default cascade band [0.3, 0.7] under default T1 thresholds', () => {
      const result = validateAndMerge({ version: '1' });
      expect(result.detection.tier2.ambiguous_band).toEqual([0.3, 0.7]);
    });

    it('accepts a monotonic band within the T1 cascade window', () => {
      const result = validateAndMerge({
        version: '1',
        detection: { tier2: { ambiguous_band: [0.4, 0.7] } },
      });
      expect(result.detection.tier2.ambiguous_band).toEqual([0.4, 0.7]);
    });

    it('throws PolicyError for a non-monotonic band (low >= high)', () => {
      expect(() =>
        validateAndMerge({
          version: '1',
          detection: { tier2: { ambiguous_band: [0.7, 0.3] } },
        }),
      ).toThrow(PolicyError);
      expect(() =>
        validateAndMerge({
          version: '1',
          detection: { tier2: { ambiguous_band: [0.7, 0.3] } },
        }),
      ).toThrow(/ambiguous_band/);
    });

    it('throws PolicyError for equal band endpoints', () => {
      expect(() =>
        validateAndMerge({
          version: '1',
          detection: { tier2: { ambiguous_band: [0.5, 0.5] } },
        }),
      ).toThrow(/ambiguous_band/);
    });

    it('throws PolicyError when band high exceeds tier1.block_threshold', () => {
      // default block_threshold = 0.7; high 0.8 sits above the T1 block ceiling
      expect(() =>
        validateAndMerge({
          version: '1',
          detection: { tier2: { ambiguous_band: [0.5, 0.8] } },
        }),
      ).toThrow(/ambiguous_band/);
    });

    it('respects custom tier1.block_threshold when validating the band ceiling', () => {
      // widen the T1 window so a [0.4, 0.85] band is legal (high <= block_threshold)
      const result = validateAndMerge({
        version: '1',
        detection: {
          tier1: { warn_threshold: 0.4, block_threshold: 0.85 },
          tier2: { ambiguous_band: [0.4, 0.85] },
        },
      });
      expect(result.detection.tier2.ambiguous_band).toEqual([0.4, 0.85]);
    });

    it('rejects a band whose high exceeds a lowered custom block_threshold', () => {
      // lower block_threshold to 0.6 so the default-ish [0.3, 0.7] high (0.7) is now out of range
      expect(() =>
        validateAndMerge({
          version: '1',
          detection: {
            tier1: { warn_threshold: 0.4, block_threshold: 0.6 },
            tier2: { ambiguous_band: [0.3, 0.7] },
          },
        }),
      ).toThrow(/ambiguous_band/);
    });

    it('includes the offending band values in the error message', () => {
      try {
        validateAndMerge({
          version: '1',
          detection: { tier2: { ambiguous_band: [0.7, 0.3] } },
        });
        throw new Error('expected validateAndMerge to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(PolicyError);
        expect((err as Error).message).toContain('ambiguous_band');
        expect((err as Error).message).toContain('0.7');
        expect((err as Error).message).toContain('0.3');
      }
    });
  });
});
