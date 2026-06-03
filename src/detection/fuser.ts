import type { FusionResult } from '../types/verdict.js';

/**
 * Pure, stateless fuser combining per-tier scores into a single overall score.
 *
 * Strategy (D01): `overall = max(tier1, tier2, tier3)` over the tiers that are present.
 * `max()` is chosen over noisy-OR because Tier 2/3 are trained on overlapping corpora — the
 * independence premise that noisy-OR requires is empirically false. `max()` also provably
 * preserves DETH-07 monotonicity: it can never lower a strong tier1 verdict, and a disabled
 * tier (returning 0) contributes nothing above tier1.
 *
 * The Fuser receives already-computed tier numbers; it does NOT call any tier engine, read
 * policy, or log. This makes it a side-effect-free O(1) function over at most three numbers.
 */
export class Fuser {
  fuse(inputs: { tier1: number; tier2?: number; tier3?: number }): FusionResult {
    const presentScores: number[] = [inputs.tier1];
    if (inputs.tier2 !== undefined) presentScores.push(inputs.tier2);
    if (inputs.tier3 !== undefined) presentScores.push(inputs.tier3);

    const overall = Math.max(...presentScores);

    const echoed: FusionResult['inputs'] = { tier1: inputs.tier1 };
    if (inputs.tier2 !== undefined) echoed.tier2 = inputs.tier2;
    if (inputs.tier3 !== undefined) echoed.tier3 = inputs.tier3;

    return {
      overall,
      strategy: 'max',
      inputs: echoed,
    };
  }
}
