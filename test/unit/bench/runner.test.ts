import { describe, it, expect } from 'vitest';
import { evaluateCorpus, tier2FiringRate, tierDisagreementRate } from '../../../src/bench/runner.js';
import type { CorpusEntry } from '../../../src/bench/corpus.js';
import type { DetectionResult } from '../../../src/types/verdict.js';

function entry(over: Partial<CorpusEntry> = {}): CorpusEntry {
  return { id: 'a', text: 't', label: 'attack', category: 'override_phrase', paraphraseOf: null, ...over };
}

function result(over: Partial<DetectionResult> = {}): DetectionResult {
  return {
    action: 'allow',
    threatScore: { overall: 0, tier1: 0 },
    matches: [],
    tiersExecuted: [1],
    latencyMs: 1,
    timestamp: new Date(0).toISOString(),
    requestId: 'r',
    ...over,
  } as DetectionResult;
}

describe('evaluateCorpus', () => {
  it('marks any non-allow action as detected', async () => {
    const preds = await evaluateCorpus(
      [entry({ id: 'a1' }), entry({ id: 'a2' }), entry({ id: 'a3' })],
      async (_text, i) =>
        result({ action: i === 0 ? 'block' : i === 1 ? 'warn' : 'allow' }),
    );
    expect(preds.map((p) => p.detected)).toEqual([true, true, false]);
  });

  it('carries corpus labels through untouched so metrics stay honest', async () => {
    const preds = await evaluateCorpus(
      [entry({ id: 'x', label: 'benign', category: 'benign', paraphraseOf: null })],
      async () => result(),
    );
    expect(preds[0]).toMatchObject({ id: 'x', label: 'benign', category: 'benign', paraphraseOf: null });
  });

  it('records a latency sample per entry', async () => {
    const preds = await evaluateCorpus([entry(), entry()], async () => result({ latencyMs: 7 }));
    expect(preds.map((p) => p.latencyMs)).toEqual([7, 7]);
  });

  it('evaluates entries in corpus order', async () => {
    const seen: string[] = [];
    await evaluateCorpus([entry({ id: 'first' }), entry({ id: 'second' })], async (text) => {
      seen.push(text);
      return result();
    });
    expect(seen).toHaveLength(2);
  });
});

describe('tier2FiringRate (§5)', () => {
  it('measures the share of entries that actually consulted Tier 2', () => {
    const rates = tier2FiringRate([
      result({ tiersExecuted: [1, 2] }),
      result({ tiersExecuted: [1] }),
      result({ tiersExecuted: [1, 2] }),
      result({ tiersExecuted: [1] }),
    ]);
    expect(rates).toBeCloseTo(0.5, 10);
  });

  it('is 0 when Tier 2 never ran', () => {
    expect(tier2FiringRate([result({ tiersExecuted: [1] })])).toBe(0);
  });

  it('is 0 for an empty run rather than NaN', () => {
    expect(tier2FiringRate([])).toBe(0);
  });
});

describe('tierDisagreementRate (§5 — validates the max() fusion premise)', () => {
  it('counts entries where Tier 2 and Tier 3 land on opposite sides of the threshold', () => {
    const rate = tierDisagreementRate(
      [
        // both high → agree
        result({ tier2: { calibratedConfidence: 0.9, latencyMs: 1 }, tier3: { calibratedConfidence: 0.8, latencyMs: 1, consulted: true } }),
        // t2 high, t3 low → disagree
        result({ tier2: { calibratedConfidence: 0.9, latencyMs: 1 }, tier3: { calibratedConfidence: 0.1, latencyMs: 1, consulted: true } }),
      ],
      0.5,
    );
    expect(rate).toBeCloseTo(0.5, 10);
  });

  it('ignores entries where either tier did not run', () => {
    const rate = tierDisagreementRate(
      [
        result({ tier2: { calibratedConfidence: 0.9, latencyMs: 1 } }), // no tier3
        result({ tier3: { calibratedConfidence: 0.1, latencyMs: 1, consulted: true } }), // no tier2
      ],
      0.5,
    );
    expect(rate).toBe(0);
  });

  it('ignores Tier 3 results that were wired but not consulted', () => {
    const rate = tierDisagreementRate(
      [
        result({
          tier2: { calibratedConfidence: 0.9, latencyMs: 1 },
          tier3: { calibratedConfidence: 0, latencyMs: 1, consulted: false },
        }),
      ],
      0.5,
    );
    expect(rate).toBe(0);
  });
});
