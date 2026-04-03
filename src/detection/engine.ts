import type { ExtractedText } from '../types/proxy.js';
import type { DetectionPolicyConfig } from '../types/policy.js';
import type { DetectionResult, PatternMatch } from '../types/verdict.js';
import { Tier1Engine } from './tier1/index.js';
import { computeThreatScore } from './tier1/scorer.js';
import { computeVerdict } from './verdict.js';
import { randomUUID } from 'node:crypto';

export class DetectionEngine {
  private tier1: Tier1Engine;
  private policy: DetectionPolicyConfig;

  constructor(policy: DetectionPolicyConfig) {
    this.tier1 = new Tier1Engine();
    this.policy = policy;
  }

  async detect(
    texts: ExtractedText[],
    requestId?: string,
  ): Promise<DetectionResult> {
    const id = requestId ?? randomUUID();
    const start = performance.now();
    const tiersExecuted: number[] = [];

    let matches: PatternMatch[] = [];

    // Tier 1: Pattern matching
    if (this.policy.tier1.enabled) {
      tiersExecuted.push(1);
      matches = this.tier1.scan(texts);
    }

    const threatScore = computeThreatScore(matches);
    const action = computeVerdict(threatScore, this.policy.tier1.action);

    // Short-circuit: if Tier 1 already blocks, skip Tier 2
    // (Tier 2 integration point for v0.2)

    const latencyMs = performance.now() - start;

    return {
      action,
      threatScore,
      matches,
      tiersExecuted,
      latencyMs,
      timestamp: new Date().toISOString(),
      requestId: id,
    };
  }
}
