import type { VerdictAction, PatternMatch, ThreatScore } from '../types/verdict.js';

const BLOCK_THRESHOLD = 0.7;
const WARN_THRESHOLD = 0.5;

export function computeVerdict(
  score: ThreatScore,
  policyAction: VerdictAction,
): VerdictAction {
  if (score.matchCount === 0) return 'allow';

  if (policyAction === 'block') {
    if (score.overall >= BLOCK_THRESHOLD) return 'block';
    if (score.overall >= WARN_THRESHOLD) return 'warn';
    return 'allow';
  }

  if (policyAction === 'warn') {
    if (score.overall >= WARN_THRESHOLD) return 'warn';
    return 'allow';
  }

  // policyAction === 'allow' means detection is logging only
  return 'allow';
}
