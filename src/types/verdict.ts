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
  matchedText: string;
  offset: number;
  length: number;
}

export interface ThreatScore {
  overall: number;
  categoryScores: Partial<Record<PatternCategory, number>>;
  matchCount: number;
}

export interface DetectionResult {
  action: VerdictAction;
  threatScore: ThreatScore;
  matches: PatternMatch[];
  tiersExecuted: number[];
  latencyMs: number;
  timestamp: string;
  requestId: string;
}
