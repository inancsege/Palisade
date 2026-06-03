import type { ExtractedText } from '../types/proxy.js';
import type { DetectionPolicyConfig } from '../types/policy.js';
import type { DetectionResult, PatternMatch } from '../types/verdict.js';
import { Tier1Engine } from './tier1/index.js';
import { Tier2Engine } from './tier2/index.js';
import { Fuser } from './fuser.js';
import { computeThreatScore } from './tier1/scorer.js';
import { computeVerdict } from './verdict.js';
import { randomUUID } from 'node:crypto';

export class DetectionEngine {
  private tier1: Tier1Engine;
  private tier2: Tier2Engine;
  private fuser: Fuser;
  private policy: DetectionPolicyConfig;

  constructor(policy: DetectionPolicyConfig) {
    this.tier1 = new Tier1Engine(undefined, policy.tier1.max_input_length);
    // policy.tier2 may be absent in legacy/partial configs — degrade to a disabled stub.
    this.tier2 = new Tier2Engine(
      policy.tier2 ?? { enabled: false, ambiguous_band: [0.3, 0.7] },
    );
    this.fuser = new Fuser();
    this.policy = policy;
  }

  /**
   * Lifecycle hook (D08). Awaited inside `PalisadeProxy.start()` before `server.listen()`.
   * With no model present, Tier 2 warmup is a fast no-op (real ONNX warmup is Slice B).
   */
  async initialize(): Promise<void> {
    await this.tier2.initialize();
  }

  /** Release the Tier 2 session (safe pre-init). */
  async close(): Promise<void> {
    await this.tier2.close();
  }

  async detect(
    texts: ExtractedText[],
    requestId?: string,
  ): Promise<DetectionResult> {
    const id = requestId ?? randomUUID();
    const start = performance.now();
    const tiersExecuted: number[] = [];

    let matches: PatternMatch[] = [];

    // Tier 1: Pattern matching (unchanged v0.1 path).
    if (this.policy.tier1.enabled) {
      tiersExecuted.push(1);
      matches = this.tier1.scan(texts);
    }

    const threatScore = computeThreatScore(matches);
    const tier1Score = threatScore.overall;
    let action = computeVerdict(
      threatScore,
      this.policy.tier1.action,
      this.policy.tier1.block_threshold,
      this.policy.tier1.warn_threshold,
    );

    const tier2Enabled = this.policy.tier2?.enabled === true;

    // D02 cascade gating. When Tier 2 is disabled (the v0.1 default), take the v0.1 path
    // verbatim: do NOT consult Tier 2, do NOT push 2, and leave `threatScore`/`action`
    // exactly as computed above so the result is byte-identical to v0.1 (D17).
    if (tier2Enabled) {
      const band = this.policy.tier2.ambiguous_band;
      // Below the band → allow without consulting Tier 2.
      // Above the band → block-region; Tier 1 already dominates, no Tier 2.
      // Within the band → consult Tier 2 and fuse.
      if (tier1Score >= band[0] && tier1Score <= band[1]) {
        // D05: Tier 2 receives RAW (un-normalized) extracted text.
        const rawText = texts.map((t) => t.text).join('\n');
        const tier2Result = await this.tier2.scan(rawText);
        tiersExecuted.push(2);

        const fusion = this.fuser.fuse({
          tier1: tier1Score,
          tier2: tier2Result.calibratedConfidence,
        });
        // Recompute the verdict from the fused score.
        threatScore.overall = fusion.overall;
        action = computeVerdict(
          threatScore,
          this.policy.tier1.action,
          this.policy.tier1.block_threshold,
          this.policy.tier1.warn_threshold,
        );

        const latencyMs = performance.now() - start;
        return {
          action,
          threatScore,
          matches,
          tiersExecuted,
          latencyMs,
          timestamp: new Date().toISOString(),
          requestId: id,
          tier1Score,
          tier2: tier2Result,
          fusion,
        };
      }
    }

    // Tier-2-off / non-consulted path: v0.1-identical result. The additive `tier1Score`/`fusion`
    // fields are populated for auditability but carry the v0.1 value, so `threatScore`/`action`
    // are untouched (fusion.overall === tier1Score === threatScore.overall).
    const fusion = this.fuser.fuse({ tier1: tier1Score });
    const latencyMs = performance.now() - start;

    return {
      action,
      threatScore,
      matches,
      tiersExecuted,
      latencyMs,
      timestamp: new Date().toISOString(),
      requestId: id,
      tier1Score,
      fusion,
    };
  }
}
