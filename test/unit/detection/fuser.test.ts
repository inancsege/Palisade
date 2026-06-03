import { describe, it, expect } from 'vitest';
import { Fuser } from '../../../src/detection/fuser.js';
import type { DetectionResult } from '../../../src/types/verdict.js';

describe('Fuser', () => {
  const fuser = new Fuser();

  it('degrades to tier1 when no tier2/tier3 present', () => {
    const result = fuser.fuse({ tier1: 0.4 });
    expect(result.overall).toBe(0.4);
    expect(result.strategy).toBe('max');
    expect(result.inputs).toEqual({ tier1: 0.4 });
  });

  it('takes tier2 when it exceeds tier1', () => {
    const result = fuser.fuse({ tier1: 0.4, tier2: 0.8 });
    expect(result.overall).toBe(0.8);
    expect(result.inputs).toEqual({ tier1: 0.4, tier2: 0.8 });
  });

  it('never lowers a strong tier1 (DETH-07 monotonicity)', () => {
    const result = fuser.fuse({ tier1: 0.9, tier2: 0.2 });
    expect(result.overall).toBe(0.9);
  });

  it('takes the max across all three tiers', () => {
    const result = fuser.fuse({ tier1: 0.4, tier2: 0.6, tier3: 0.95 });
    expect(result.overall).toBe(0.95);
    expect(result.inputs).toEqual({ tier1: 0.4, tier2: 0.6, tier3: 0.95 });
  });

  it('a disabled tier (score 0) does not raise overall above tier1', () => {
    // Byte-identical-when-off proof at the fuser layer (D17): tier2 returning 0 contributes nothing.
    const result = fuser.fuse({ tier1: 0.4, tier2: 0 });
    expect(result.overall).toBe(0.4);
    expect(result.inputs).toEqual({ tier1: 0.4, tier2: 0 });
  });

  it('accepts a v0.1-shaped DetectionResult (additive-only schema, compile-time)', () => {
    // Compile-time assertion: a result with ONLY the v0.1 fields must still satisfy DetectionResult.
    // If any new field were required, this object literal would fail to type-check.
    const v01Result: DetectionResult = {
      action: 'allow',
      threatScore: { overall: 0.1, categoryScores: {}, matchCount: 0 },
      matches: [],
      tiersExecuted: [1],
      latencyMs: 1.2,
      timestamp: '2026-06-03T00:00:00.000Z',
      requestId: 'req-1',
    };
    expect(v01Result.tier1Score).toBeUndefined();
    expect(v01Result.tier2).toBeUndefined();
    expect(v01Result.tier3).toBeUndefined();
    expect(v01Result.fusion).toBeUndefined();
  });

  it('monotonicity property: fuse({tier1}).overall === tier1 exactly (no float drift)', () => {
    for (let i = 0; i < 1000; i++) {
      const tier1 = Math.random();
      const result = fuser.fuse({ tier1 });
      expect(result.overall).toBe(tier1);
    }
  });
});
