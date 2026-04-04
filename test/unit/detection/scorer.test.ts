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
      makeMatch({ confidence: 0.7, category: 'override_phrase' }),
      makeMatch({ confidence: 0.7, category: 'override_phrase', patternId: 'p2' }),
    ]);

    const multiCategory = computeThreatScore([
      makeMatch({ confidence: 0.7, category: 'override_phrase' }),
      makeMatch({ confidence: 0.7, category: 'role_marker', patternId: 'p2' }),
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
});
