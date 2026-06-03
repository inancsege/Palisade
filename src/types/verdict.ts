export type VerdictAction = 'allow' | 'warn' | 'block';

export type PatternCategory =
  | 'role_marker'
  | 'delimiter_escape'
  | 'override_phrase'
  | 'encoded_payload'
  | 'exfiltration'
  | 'unicode_homoglyph'
  | 'custom';

export interface PatternMatch {
  patternId: string;
  description: string;
  tier: 1 | 2 | 3;
  category: PatternCategory;
  confidence: number;
  weight: number;
  matchedText: string;
  offset: number;
  length: number;
}

export interface ThreatScore {
  overall: number;
  categoryScores: Partial<Record<PatternCategory, number>>;
  matchCount: number;
}

/**
 * Tier 2 (local ML classifier) result.
 * `calibratedConfidence` is the temperature/bias-calibrated 0..1 probability used in fusion.
 * `raw` is the uncalibrated model output (logit/probability) retained for diagnostics.
 */
export interface Tier2Result {
  calibratedConfidence: number;
  latencyMs: number;
  raw?: number;
}

/**
 * Tier 3 (hosted API fallback) result.
 * `consulted` is false when Tier 3 was wired but skipped (disabled, gated, or short-circuited).
 */
export interface Tier3Result {
  calibratedConfidence: number;
  latencyMs: number;
  consulted: boolean;
  reason?: string;
  provider?: string;
}

/**
 * Result of fusing per-tier scores. `overall` is `max()` of the present tier scores (D01);
 * `inputs` echoes the scores that were fused so the decision is auditable.
 */
export interface FusionResult {
  overall: number;
  strategy: 'max';
  inputs: { tier1: number; tier2?: number; tier3?: number };
}

export interface DetectionResult {
  action: VerdictAction;
  threatScore: ThreatScore;
  matches: PatternMatch[];
  tiersExecuted: number[];
  latencyMs: number;
  timestamp: string;
  requestId: string;
  // Additive v0.2 fields (D17): all OPTIONAL so v0.1-shaped results still satisfy this type.
  // When Tier 2/3 are absent, `fusion.overall === tier1Score === threatScore.overall`.
  tier1Score?: number;
  tier2?: Tier2Result;
  tier3?: Tier3Result;
  fusion?: FusionResult;
}
