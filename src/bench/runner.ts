import { DetectionEngine } from '../detection/engine.js';
import type { DetectionPolicyConfig } from '../types/policy.js';
import type { DetectionResult } from '../types/verdict.js';
import type { CorpusEntry } from './corpus.js';
import type { Prediction } from './metrics.js';

/**
 * Scores one corpus entry. Injected rather than hard-wired so the metric plumbing is
 * testable without loading a 700MB ONNX model.
 */
export type Detect = (text: string, index: number) => Promise<DetectionResult>;

/**
 * Run a detector over a corpus, preserving the corpus's own labels. Entries are evaluated
 * sequentially and in order: the latency samples feed the 4-column percentiles, and
 * concurrent scoring would make them meaningless.
 */
export async function evaluateCorpus(entries: CorpusEntry[], detect: Detect): Promise<Prediction[]> {
  const predictions: Prediction[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const result = await detect(entry.text, i);
    predictions.push({
      id: entry.id,
      label: entry.label,
      category: entry.category,
      paraphraseOf: entry.paraphraseOf,
      detected: result.action !== 'allow',
      latencyMs: result.latencyMs,
    });
  }
  return predictions;
}

/** Share of scored entries that actually consulted Tier 2 (i.e. landed in the band). */
export function tier2FiringRate(results: DetectionResult[]): number {
  if (results.length === 0) return 0;
  return results.filter((r) => r.tiersExecuted.includes(2)).length / results.length;
}

/**
 * Share of entries where Tier 2 and Tier 3 land on OPPOSITE sides of the decision
 * threshold. Validates the `max()` fusion premise (PITFALLS P6.1): if the tiers rarely
 * disagree, fusion is doing no work; if they disagree often, `max()` is load-bearing and
 * worth scrutinising. Entries where either tier did not run are excluded — a tier that
 * never spoke cannot disagree.
 */
export function tierDisagreementRate(results: DetectionResult[], threshold: number): number {
  let compared = 0;
  let disagreed = 0;
  for (const r of results) {
    if (!r.tier2 || !r.tier3?.consulted) continue;
    compared++;
    if (r.tier2.calibratedConfidence >= threshold !== r.tier3.calibratedConfidence >= threshold) {
      disagreed++;
    }
  }
  return compared === 0 ? 0 : disagreed / compared;
}

/**
 * Fail when Tier 2 was consulted but every inference came back as the zero result.
 *
 * `Tier2Engine.scan()` is deliberately fail-open: an uninitialized classifier, a load error
 * or a timeout degrades to `{ calibratedConfidence: 0, latencyMs: 0 }` and only a warn is
 * logged. That is right for a proxy in production and WRONG for a benchmark, where it would
 * silently publish a `tier1+2` row whose Tier 2 contributed nothing. A run where Tier 2
 * never entered the ambiguous band is fine — that is a real measurement, not a degradation.
 */
export function assertTier2NotDegraded(
  configuration: TierConfiguration,
  results: DetectionResult[],
): void {
  if (configuration === 'tier1') return;
  const fired = results.filter((r) => r.tiersExecuted.includes(2));
  if (fired.length === 0) return;
  if (fired.every((r) => !r.tier2 || r.tier2.latencyMs === 0)) {
    throw new Error(
      `Configuration '${configuration}' consulted Tier 2 ${fired.length} time(s) but every ` +
        `inference returned the degraded zero result — the model did not run. Did you call ` +
        `DetectionEngine.initialize()? Refusing to publish a Tier 2 row from a degraded run.`,
    );
  }
}

/** Build a `Detect` backed by a real `DetectionEngine` for the given tier configuration. */
export function engineDetect(engine: DetectionEngine): Detect {
  return (text) => engine.detect([{ source: 'bench', role: 'user', text }]);
}

/** The three configurations the protocol compares side by side (§1). */
export type TierConfiguration = 'tier1' | 'tier1+2' | 'tier1+2+3';

/**
 * Derive the detection policy for one configuration by disabling the tiers it excludes.
 * Everything else — thresholds, band, calibration — is left exactly as the base policy
 * defines it, so the comparison isolates tier composition and nothing else.
 *
 * `modelPath` is REQUIRED for any Tier 2 configuration: `Tier2Engine.hasModel()` keys off
 * `model_path`, and with it unset `scan()` silently returns confidence 0. Setting only
 * `enabled` would yield a `tier1+2` row in which Tier 2 never ran.
 */
export function policyForConfiguration(
  base: DetectionPolicyConfig,
  configuration: TierConfiguration,
  modelPath: string | null,
): DetectionPolicyConfig {
  const tier2Enabled = configuration !== 'tier1';
  return {
    ...base,
    tier1: { ...base.tier1, enabled: true },
    tier2: {
      ...base.tier2,
      enabled: tier2Enabled,
      ...(tier2Enabled && modelPath ? { model_path: modelPath } : {}),
    },
    tier3: { ...base.tier3, enabled: configuration === 'tier1+2+3' },
  };
}

/**
 * Fail loudly when a Tier 2 configuration is requested without an installed model.
 *
 * Emitting a `tier1+2` row from a run where Tier 2 no-opped would be a fabricated number.
 * The protocol's whole purpose is that published figures are traceable to a real run, so
 * this refuses rather than degrading quietly.
 */
export function requireModelFor(configuration: TierConfiguration, modelPath: string | null): void {
  if (configuration === 'tier1' || modelPath) return;
  throw new Error(
    `Configuration '${configuration}' needs the Tier 2 model, which is not installed. ` +
      `Run 'palisade tier2 install' first, or restrict the run with --configurations tier1.`,
  );
}
