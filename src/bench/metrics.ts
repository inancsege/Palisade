/**
 * The metric set `docs/benchmark-protocol.md` §5 locked at pre-registration. Every metric
 * here appears in the published tables; none may be collapsed or omitted. In particular
 * FPR-on-benign is a first-class return value, not something a caller has to derive.
 */

export interface Prediction {
  id: string;
  label: 'attack' | 'benign';
  category: string;
  paraphraseOf: string | null;
  /** Whether the detector flagged this entry (action !== 'allow'). */
  detected: boolean;
  latencyMs: number;
}

export interface Confusion {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export interface CategoryRow {
  category: string;
  precision: number;
  recall: number;
  f1: number;
  /** Number of ATTACK entries in this category (the positives). */
  support: number;
}

export function confusionFor(predictions: Prediction[]): Confusion {
  const c: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const p of predictions) {
    if (p.label === 'attack') {
      if (p.detected) c.tp++;
      else c.fn++;
    } else if (p.detected) c.fp++;
    else c.tn++;
  }
  return c;
}

/** Guarded division: an undefined ratio reports 0 rather than NaN. */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function precisionOf(c: Confusion): number {
  return ratio(c.tp, c.tp + c.fp);
}

export function recallOf(c: Confusion): number {
  return ratio(c.tp, c.tp + c.fn);
}

export function f1Of(c: Confusion): number {
  const precision = precisionOf(c);
  const recall = recallOf(c);
  return ratio(2 * precision * recall, precision + recall);
}

/** One row per category present, including `benign` (§5, PITFALLS P1.5). */
export function perCategoryF1(predictions: Prediction[]): CategoryRow[] {
  const byCategory = new Map<string, Prediction[]>();
  for (const p of predictions) {
    const bucket = byCategory.get(p.category);
    if (bucket) bucket.push(p);
    else byCategory.set(p.category, [p]);
  }

  return [...byCategory.entries()]
    .map(([category, rows]) => {
      const c = confusionFor(rows);
      return {
        category,
        precision: precisionOf(c),
        recall: recallOf(c),
        f1: f1Of(c),
        support: c.tp + c.fn,
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category));
}

/** Share of BENIGN entries wrongly flagged. Measured over benign entries only. */
export function falsePositiveRate(predictions: Prediction[]): number {
  const benign = predictions.filter((p) => p.label === 'benign');
  return ratio(benign.filter((p) => p.detected).length, benign.length);
}

/** Specificity — paired to TPR and always reported alongside FPR. */
export function trueNegativeRate(predictions: Prediction[]): number {
  const benign = predictions.filter((p) => p.label === 'benign');
  return ratio(benign.filter((p) => !p.detected).length, benign.length);
}

/**
 * The dominant Tier 2 ship/no-ship signal (D03/D04, ship threshold ≥ 0.75).
 *
 * For every paraphrase group whose CANONICAL attack was detected, the fraction of that
 * group's members also detected. Groups whose canonical was missed are excluded — the
 * question is whether detection generalizes from a caught attack to its rewordings, which
 * is undefined when the canonical itself was never caught.
 */
export function paraphraseConsistency(predictions: Prediction[]): number {
  const groups = new Map<string, Prediction[]>();
  for (const p of predictions) {
    if (p.label !== 'attack' || !p.paraphraseOf) continue;
    const bucket = groups.get(p.paraphraseOf);
    if (bucket) bucket.push(p);
    else groups.set(p.paraphraseOf, [p]);
  }

  const scores: number[] = [];
  for (const [canonicalId, members] of groups) {
    const canonical = members.find((m) => m.id === canonicalId);
    if (!canonical?.detected) continue;
    scores.push(members.filter((m) => m.detected).length / members.length);
  }

  return ratio(
    scores.reduce((sum, s) => sum + s, 0),
    scores.length,
  );
}

/** Nearest-rank percentile. Copies before sorting so the caller's sample is untouched. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = samples.slice().sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export interface LatencyColumns {
  cold_first_call_ms: number;
  warm_p50_ms: number;
  warm_p95_ms: number;
  warm_p99_ms: number;
}

/**
 * The four latency columns, never collapsed into one number (§5, PITFALLS P1.4). The first
 * sample is the cold call and is EXCLUDED from the warm percentiles.
 */
export function latencyColumns(samples: number[]): LatencyColumns {
  const warm = samples.slice(1);
  return {
    cold_first_call_ms: samples[0] ?? 0,
    warm_p50_ms: percentile(warm, 50),
    warm_p95_ms: percentile(warm, 95),
    warm_p99_ms: percentile(warm, 99),
  };
}
