import type { VerdictAction, ThreatScore } from '../types/verdict.js';

const SEVERITY: Record<VerdictAction, number> = { allow: 0, warn: 1, block: 2 };

/** The stricter of two actions. */
export function mostSevere(a: VerdictAction, b: VerdictAction): VerdictAction {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** The more permissive of two actions — used to cap what a tier is allowed to escalate to. */
export function leastSevere(a: VerdictAction, b: VerdictAction): VerdictAction {
  return SEVERITY[a] <= SEVERITY[b] ? a : b;
}

export function computeVerdict(
  score: ThreatScore,
  policyAction: VerdictAction,
  blockThreshold = 0.7,
  warnThreshold = 0.5,
  /**
   * Whether a tier beyond Tier 1 contributed a score of its own.
   *
   * `matchCount` counts TIER 1 pattern hits, so the early return below reads "no patterns
   * matched, therefore no evidence". Once Tier 2 has been consulted and returned a
   * non-zero confidence that premise is false, and applying the guard anyway discards the
   * Tier 2 score entirely — which is precisely the case Tier 2 exists to cover, since the
   * attacks it catches are the ones Tier 1 scored 0 on. Defaults to false so the
   * Tier-2-disabled path stays byte-identical to v0.1 (D17).
   */
  hasHigherTierEvidence = false,
): VerdictAction {
  if (score.matchCount === 0 && !hasHigherTierEvidence) return 'allow';

  if (policyAction === 'block') {
    if (score.overall >= blockThreshold) return 'block';
    if (score.overall >= warnThreshold) return 'warn';
    return 'allow';
  }

  if (policyAction === 'warn') {
    if (score.overall >= warnThreshold) return 'warn';
    return 'allow';
  }

  // policyAction === 'allow' means detection is logging only
  return 'allow';
}
