import type { VerdictAction, ThreatScore } from '../types/verdict.js';

export function computeVerdict(
  score: ThreatScore,
  policyAction: VerdictAction,
  blockThreshold = 0.7,
  warnThreshold = 0.5,
): VerdictAction {
  if (score.matchCount === 0) return 'allow';

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
