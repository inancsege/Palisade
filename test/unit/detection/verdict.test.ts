import { describe, it, expect } from 'vitest';
import { computeVerdict } from '../../../src/detection/verdict.js';
import type { ThreatScore } from '../../../src/types/verdict.js';

function makeScore(overall: number, matchCount = 1): ThreatScore {
  return { overall, categoryScores: {}, matchCount };
}

describe('computeVerdict', () => {
  it('should return allow for zero matches', () => {
    expect(computeVerdict(makeScore(0.9, 0), 'block')).toBe('allow');
  });

  it('should block when score >= blockThreshold', () => {
    expect(computeVerdict(makeScore(0.8), 'block', 0.7, 0.5)).toBe('block');
  });

  it('should warn when score >= warnThreshold but < blockThreshold', () => {
    expect(computeVerdict(makeScore(0.6), 'block', 0.7, 0.5)).toBe('warn');
  });

  it('should allow when score < warnThreshold', () => {
    expect(computeVerdict(makeScore(0.3), 'block', 0.7, 0.5)).toBe('allow');
  });

  it('should use custom thresholds when provided', () => {
    // With lower block threshold, score 0.6 should now block
    expect(computeVerdict(makeScore(0.6), 'block', 0.5, 0.3)).toBe('block');
  });

  it('should cap at warn when policyAction is warn', () => {
    expect(computeVerdict(makeScore(0.9), 'warn', 0.7, 0.5)).toBe('warn');
  });

  it('should return allow when policyAction is allow', () => {
    expect(computeVerdict(makeScore(0.9), 'allow', 0.7, 0.5)).toBe('allow');
  });

  it('should use default thresholds (0.7/0.5) when not provided', () => {
    expect(computeVerdict(makeScore(0.6), 'block')).toBe('warn');
    expect(computeVerdict(makeScore(0.8), 'block')).toBe('block');
  });
});
