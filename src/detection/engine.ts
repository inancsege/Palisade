import type { ExtractedText } from '../types/proxy.js';
import type { DetectionPolicyConfig } from '../types/policy.js';
import type { DetectionResult, PatternMatch } from '../types/verdict.js';
import { Tier1Engine } from './tier1/index.js';
import { Tier2Engine } from './tier2/index.js';
import { Fuser } from './fuser.js';
import { computeThreatScore } from './tier1/scorer.js';
import { computeVerdict, leastSevere, mostSevere } from './verdict.js';
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
      //
      // The default floor is 0, not 0.3, because Tier 1 does not produce a graded score:
      // it either matches a pattern (scoring well above the block threshold) or matches
      // nothing (scoring exactly 0). Measured on the calibration split, only 4 of 62
      // attacks and ZERO benign entries landed in [0.3, 0.7] — so a floor of 0.3 gated
      // Tier 2 out of the only cases it could help with, namely the attacks Tier 1 scored
      // at 0. The floor is what makes this a cascade rather than a decoration; raising it
      // above 0 restores the old behaviour of Tier 2 almost never firing.
      if (tier1Score >= band[0] && tier1Score <= band[1]) {
        // D05: Tier 2 receives RAW (un-normalized) extracted text.
        const rawText = texts.map((t) => t.text).join('\n');
        const tier2Result = await this.tier2.scan(rawText);
        tiersExecuted.push(2);

        const fusion = this.fuser.fuse({
          tier1: tier1Score,
          tier2: tier2Result.calibratedConfidence,
        });
        // Recompute the verdict from the fused score. Tier 2 having produced a non-zero
        // confidence is evidence in its own right, so the verdict must not be vetoed by
        // Tier 1's match count being 0 — that is the whole point of consulting Tier 2 on
        // inputs Tier 1 found nothing in.
        const tier1Action = action;
        threatScore.overall = fusion.overall;
        const fusedAction = computeVerdict(
          threatScore,
          this.policy.tier1.action,
          this.policy.tier1.block_threshold,
          this.policy.tier1.warn_threshold,
          tier2Result.calibratedConfidence > 0,
        );

        // Tier 2 escalation is capped at `tier2.action` (default 'warn'). On the measured
        // corpora, letting Tier 2 block on its own lifts recall a long way but takes the
        // false-positive rate from ~1.7% to ~15% — one legitimate request in seven. The
        // cap keeps the hard-block decision with Tier 1's precise pattern evidence and
        // surfaces Tier 2's broader, noisier signal as a warning. Tier 1's own verdict is
        // never softened by this: the result is the stricter of the two.
        action = mostSevere(tier1Action, leastSevere(fusedAction, this.policy.tier2.action));

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
