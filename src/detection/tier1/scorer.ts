import type { PatternCategory, PatternMatch, ThreatScore } from '../../types/verdict.js';

/**
 * Aggregate pattern matches into a ThreatScore.
 *
 * Formula:
 *   overall = min(1.0, weightedSum + categoryBonus)
 *
 *   weightedSum = sum(confidence * weight) capped at 1.0
 *   categoryBonus = 0.1 * (distinctCategoriesHit - 1)
 *
 * Multi-vector attacks (hitting multiple categories) score higher.
 */
export function computeThreatScore(matches: PatternMatch[]): ThreatScore {
  if (matches.length === 0) {
    return { overall: 0, categoryScores: {}, matchCount: 0 };
  }

  const categoryScores: Partial<Record<PatternCategory, number>> = {};

  for (const match of matches) {
    const current = categoryScores[match.category] ?? 0;
    categoryScores[match.category] = Math.min(1.0, current + match.confidence * 0.5);
  }

  // Weighted sum: each match contributes confidence * weight, accumulative (no averaging)
  let weightedSum = 0;
  for (const match of matches) {
    weightedSum += match.confidence * match.weight;
  }
  weightedSum = Math.min(1.0, weightedSum);

  // Take max single-match confidence into account (a strong single hit should dominate)
  const maxConfidence = Math.max(...matches.map((m) => m.confidence));
  weightedSum = Math.max(weightedSum, maxConfidence * 0.9);

  // Category bonus: multi-vector attacks are more suspicious
  const distinctCategories = Object.keys(categoryScores).length;
  const categoryBonus = 0.1 * Math.max(0, distinctCategories - 1);

  const overall = Math.min(1.0, weightedSum + categoryBonus);

  return {
    overall,
    categoryScores,
    matchCount: matches.length,
  };
}
