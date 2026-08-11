import { describe, it, expect } from 'vitest';
import { captureEnvironment, renderReport, type ConfigurationResult } from '../../../src/bench/report.js';

function configResult(over: Partial<ConfigurationResult> = {}): ConfigurationResult {
  return {
    configuration: 'tier1',
    categories: [
      { category: 'override_phrase', precision: 1, recall: 0.9, f1: 0.95, support: 10 },
      { category: 'benign', precision: 0, recall: 0, f1: 0, support: 0 },
    ],
    falsePositiveRate: 0.04,
    trueNegativeRate: 0.96,
    paraphraseConsistency: 0.97,
    latency: { cold_first_call_ms: 12, warm_p50_ms: 1.1, warm_p95_ms: 2.4, warm_p99_ms: 3.9 },
    tier2FiringRate: 0,
    tierDisagreementRate: 0,
    ...over,
  };
}

describe('captureEnvironment (protocol §7)', () => {
  it('records the run environment needed to reproduce a number', () => {
    const env = captureEnvironment();
    expect(env.node).toBe(process.version);
    expect(env.platform).toBe(process.platform);
    expect(env.arch).toBe(process.arch);
    expect(typeof env.cpus).toBe('number');
    expect(typeof env.totalMemoryBytes).toBe('number');
  });

  it('records the palisade version so numbers are attributable to a build', () => {
    expect(captureEnvironment().palisade).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('serializes to JSON without throwing', () => {
    expect(() => JSON.stringify(captureEnvironment())).not.toThrow();
  });
});

describe('renderReport (protocol §3/§5 — nothing hidden)', () => {
  const report = () =>
    renderReport({
      corpus: { id: 'C4', name: 'held-out adversarial set', trainOverlap: 'none', sha256: 'abc123', entries: 210 },
      evaluated: 168,
      seed: 20260603,
      results: [configResult()],
      environment: captureEnvironment(),
    });

  it('always shows the contamination column', () => {
    expect(report()).toMatch(/train_overlap/i);
    expect(report()).toContain('none');
  });

  it('shows FPR on benign as a first-class column, never hidden', () => {
    expect(report()).toMatch(/FPR/);
  });

  it('reports all four latency columns without collapsing them', () => {
    const out = report();
    for (const col of ['cold_first_call_ms', 'warm_p50_ms', 'warm_p95_ms', 'warm_p99_ms']) {
      expect(out).toContain(col);
    }
  });

  it('emits one row per category including benign', () => {
    const out = report();
    expect(out).toContain('override_phrase');
    expect(out).toContain('benign');
  });

  it('states the pinned seed and the corpus sha256 for reproducibility', () => {
    const out = report();
    expect(out).toContain('20260603');
    expect(out).toContain('abc123');
  });

  it('names paraphrase consistency against its ship threshold', () => {
    expect(report()).toMatch(/0\.75/);
  });
});

describe('environment version resolution', () => {
  it('records the transformers version despite its restricted package exports', () => {
    // `require('@huggingface/transformers/package.json')` throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED; a naive lookup would silently report null for a
    // version §7 requires.
    expect(captureEnvironment().transformersJs).toMatch(/^\d+\.\d+\.\d+/);
  });
});
