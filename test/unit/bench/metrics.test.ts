import { describe, it, expect } from 'vitest';
import {
  confusionFor,
  percentile,
  perCategoryF1,
  blockRateOnBenign,
  falsePositiveRate,
  trueNegativeRate,
  paraphraseConsistency,
  type Prediction,
} from '../../../src/bench/metrics.js';

function p(over: Partial<Prediction> = {}): Prediction {
  return {
    id: 'x',
    label: 'attack',
    category: 'override_phrase',
    paraphraseOf: null,
    detected: true,
    action: 'block',
    latencyMs: 1,
    ...over,
  };
}

describe('confusionFor (protocol §5)', () => {
  it('counts tp/fp/tn/fn over a mixed prediction set', () => {
    const c = confusionFor([
      p({ label: 'attack', detected: true }), // tp
      p({ label: 'attack', detected: false }), // fn
      p({ label: 'benign', category: 'benign', detected: true }), // fp
      p({ label: 'benign', category: 'benign', detected: false }), // tn
    ]);
    expect(c).toEqual({ tp: 1, fp: 1, tn: 1, fn: 1 });
  });
});

describe('precision / recall / F1', () => {
  it('reports a perfect detector as F1 = 1', () => {
    const rows = perCategoryF1([
      p({ category: 'override_phrase', label: 'attack', detected: true }),
      p({ category: 'override_phrase', label: 'attack', detected: true }),
      p({ category: 'benign', label: 'benign', detected: false }),
    ]);
    const row = rows.find((r) => r.category === 'override_phrase')!;
    expect(row.precision).toBe(1);
    expect(row.recall).toBe(1);
    expect(row.f1).toBe(1);
    expect(row.support).toBe(2);
  });

  it('computes the harmonic mean when precision and recall differ', () => {
    // 1 of 2 attacks caught (recall .5); 1 benign wrongly flagged (precision .5) → F1 .5
    const rows = perCategoryF1([
      p({ category: 'exfiltration', label: 'attack', detected: true }),
      p({ category: 'exfiltration', label: 'attack', detected: false }),
      p({ category: 'exfiltration', label: 'benign', detected: true }),
    ]);
    const row = rows.find((r) => r.category === 'exfiltration')!;
    expect(row.precision).toBeCloseTo(0.5, 10);
    expect(row.recall).toBeCloseTo(0.5, 10);
    expect(row.f1).toBeCloseTo(0.5, 10);
  });

  it('reports F1 = 0 rather than NaN when nothing is detected', () => {
    const rows = perCategoryF1([p({ category: 'role_marker', label: 'attack', detected: false })]);
    const row = rows.find((r) => r.category === 'role_marker')!;
    expect(row.precision).toBe(0);
    expect(row.f1).toBe(0);
    expect(Number.isNaN(row.f1)).toBe(false);
  });

  it('emits one row per category present, including benign (§5)', () => {
    const rows = perCategoryF1([
      p({ category: 'override_phrase', label: 'attack' }),
      p({ category: 'exfiltration', label: 'attack' }),
      p({ category: 'benign', label: 'benign', detected: false }),
    ]);
    expect(rows.map((r) => r.category).sort()).toEqual(['benign', 'exfiltration', 'override_phrase']);
  });
});

describe('FPR / TNR on benign (§5 — never hidden)', () => {
  it('measures FPR over benign entries only', () => {
    const preds = [
      p({ label: 'benign', category: 'benign', detected: true }),
      p({ label: 'benign', category: 'benign', detected: false }),
      p({ label: 'benign', category: 'benign', detected: false }),
      p({ label: 'benign', category: 'benign', detected: false }),
      p({ label: 'attack', detected: false }), // must not count toward FPR
    ];
    expect(falsePositiveRate(preds)).toBeCloseTo(0.25, 10);
    expect(trueNegativeRate(preds)).toBeCloseTo(0.75, 10);
  });

  it('pairs to 1 by construction', () => {
    const preds = [
      p({ label: 'benign', category: 'benign', detected: true }),
      p({ label: 'benign', category: 'benign', detected: false }),
    ];
    expect(falsePositiveRate(preds) + trueNegativeRate(preds)).toBeCloseTo(1, 10);
  });

  it('returns 0 when there are no benign entries at all', () => {
    expect(falsePositiveRate([p({ label: 'attack' })])).toBe(0);
  });
});

describe('paraphrase consistency (§5 — the Tier 2 ship signal)', () => {
  it('scores the detected fraction of paraphrases whose canonical was caught', () => {
    const preds = [
      p({ id: 'atk-001', paraphraseOf: 'atk-001', detected: true }), // canonical, caught
      p({ id: 'atk-002', paraphraseOf: 'atk-001', detected: true }),
      p({ id: 'atk-003', paraphraseOf: 'atk-001', detected: true }),
      p({ id: 'atk-004', paraphraseOf: 'atk-001', detected: false }),
    ];
    // 3 of 4 group members detected
    expect(paraphraseConsistency(preds)).toBeCloseTo(0.75, 10);
  });

  it('ignores groups whose canonical attack was missed', () => {
    const preds = [
      p({ id: 'atk-001', paraphraseOf: 'atk-001', detected: false }), // canonical missed
      p({ id: 'atk-002', paraphraseOf: 'atk-001', detected: false }),
      p({ id: 'atk-005', paraphraseOf: 'atk-005', detected: true }), // canonical caught
      p({ id: 'atk-006', paraphraseOf: 'atk-005', detected: true }),
    ];
    expect(paraphraseConsistency(preds)).toBe(1);
  });

  it('returns 0 when no canonical attack was detected', () => {
    expect(
      paraphraseConsistency([p({ id: 'atk-001', paraphraseOf: 'atk-001', detected: false })]),
    ).toBe(0);
  });
});

describe('percentile (§5 — 4 latency columns, never collapsed)', () => {
  it('reports the nearest-rank percentile', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile(xs, 99)).toBe(10);
  });

  it('does not mutate the caller array', () => {
    const xs = [3, 1, 2];
    percentile(xs, 50);
    expect(xs).toEqual([3, 1, 2]);
  });

  it('returns 0 for an empty sample', () => {
    expect(percentile([], 95)).toBe(0);
  });
});

describe('blockRateOnBenign', () => {
  it('counts only hard blocks, not warnings', () => {
    // Tier 2 escalation is capped at `warn`, so a config can carry a high FPR while
    // blocking nothing. Reporting FPR alone would read as though those were refused.
    const predictions = [
      p({ label: 'benign', category: 'benign', detected: true, action: 'warn' }),
      p({ label: 'benign', category: 'benign', detected: true, action: 'warn' }),
      p({ label: 'benign', category: 'benign', detected: true, action: 'block' }),
      p({ label: 'benign', category: 'benign', detected: false, action: 'allow' }),
    ];
    expect(falsePositiveRate(predictions)).toBeCloseTo(0.75, 6);
    expect(blockRateOnBenign(predictions)).toBeCloseTo(0.25, 6);
  });

  it('is 0 with no benign entries rather than NaN', () => {
    expect(blockRateOnBenign([p({ label: 'attack' })])).toBe(0);
  });
});
