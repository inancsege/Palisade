import { describe, it, expect } from 'vitest';
import { computeThreatScore } from '../../../src/detection/tier1/scorer.js';
import { makeMatch } from '../../helpers/factories.js';

describe('computeThreatScore', () => {
  it('should return 0 for empty matches', () => {
    const score = computeThreatScore([]);
    expect(score.overall).toBe(0);
    expect(score.matchCount).toBe(0);
  });

  it('should return high score for high-confidence match', () => {
    const score = computeThreatScore([makeMatch({ confidence: 0.95 })]);
    expect(score.overall).toBeGreaterThan(0.8);
    expect(score.matchCount).toBe(1);
  });

  it('should boost score for multi-category hits', () => {
    const singleCategory = computeThreatScore([
      makeMatch({ confidence: 0.4, weight: 0.5, category: 'override_phrase' }),
      makeMatch({ confidence: 0.4, weight: 0.5, category: 'override_phrase', patternId: 'p2' }),
    ]);

    const multiCategory = computeThreatScore([
      makeMatch({ confidence: 0.4, weight: 0.5, category: 'override_phrase' }),
      makeMatch({ confidence: 0.4, weight: 0.5, category: 'role_marker', patternId: 'p2' }),
    ]);

    expect(multiCategory.overall).toBeGreaterThan(singleCategory.overall);
  });

  it('should produce category breakdown', () => {
    const score = computeThreatScore([
      makeMatch({ category: 'role_marker' }),
      makeMatch({ category: 'exfiltration', patternId: 'p2' }),
    ]);

    expect(score.categoryScores.role_marker).toBeDefined();
    expect(score.categoryScores.exfiltration).toBeDefined();
  });

  it('should cap overall score at 1.0', () => {
    const matches = Array.from({ length: 10 }, (_, i) =>
      makeMatch({ confidence: 0.95, patternId: `p${i}` }),
    );
    const score = computeThreatScore(matches);
    expect(score.overall).toBeLessThanOrEqual(1.0);
  });

  it('should not decrease score when adding low-confidence matches', () => {
    const highOnly = computeThreatScore([makeMatch({ confidence: 0.85, weight: 0.9 })]);
    const withLow = computeThreatScore([
      makeMatch({ confidence: 0.85, weight: 0.9 }),
      makeMatch({ confidence: 0.3, weight: 0.5, patternId: 'low-conf' }),
    ]);
    expect(withLow.overall).toBeGreaterThanOrEqual(highOnly.overall);
  });

  it('should maintain monotonicity across 10 incremental low-confidence additions', () => {
    const base = [makeMatch({ confidence: 0.8, weight: 0.9 })];
    let prevScore = computeThreatScore(base).overall;
    for (let i = 1; i <= 10; i++) {
      const matches = [
        ...base,
        ...Array.from({ length: i }, (_, j) =>
          makeMatch({ confidence: 0.2, weight: 0.5, patternId: `low-${j}` }),
        ),
      ];
      const score = computeThreatScore(matches).overall;
      expect(score).toBeGreaterThanOrEqual(prevScore);
      prevScore = score;
    }
  });

  it('should score single match with confidence 0.85 above maxConfidence floor', () => {
    const score = computeThreatScore([makeMatch({ confidence: 0.85, weight: 1.0 })]);
    // maxConfidence floor: 0.85 * 0.9 = 0.765
    expect(score.overall).toBeGreaterThanOrEqual(0.765);
  });

  it('should accumulate categoryScores at confidence * 0.5 capped at 1.0', () => {
    const score = computeThreatScore([
      makeMatch({ confidence: 0.8, category: 'role_marker', patternId: 'p1' }),
      makeMatch({ confidence: 0.8, category: 'role_marker', patternId: 'p2' }),
    ]);
    // Each contributes 0.8 * 0.5 = 0.4, total = 0.8
    expect(score.categoryScores.role_marker).toBeGreaterThanOrEqual(0.8);
    expect(score.categoryScores.role_marker).toBeLessThanOrEqual(1.0);
  });

  it('should score HTML comment injection pattern (conf=0.78, weight=0.8) >= 0.7', () => {
    const score = computeThreatScore([
      makeMatch({
        confidence: 0.78,
        weight: 0.8,
        category: 'delimiter_escape',
        patternId: 'delimiter:html-comment-injection',
      }),
    ]);
    expect(score.overall).toBeGreaterThanOrEqual(0.7);
  });
});
