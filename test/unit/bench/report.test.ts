import { describe, it, expect } from 'vitest';
import {
  captureEnvironment,
  renderReport,
  type ConfigurationResult,
  type CorpusResult,
} from '../../../src/bench/report.js';

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

function corpusResult(over: Partial<CorpusResult['corpus']> = {}): CorpusResult {
  return {
    corpus: {
      id: 'C4',
      name: 'held-out adversarial set',
      trainOverlap: 'none',
      sha256: 'abc123',
      entries: 210,
      hasParaphraseGroups: true,
      ...over,
    },
    evaluated: 168,
    results: [configResult()],
  };
}

describe('renderReport (protocol §3/§5 — nothing hidden)', () => {
  const report = () =>
    renderReport({
      corpora: [corpusResult()],
      seed: 20260603,
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

  it('renders every registered corpus side-by-side with its contamination class', () => {
    const out = renderReport({
      corpora: [
        corpusResult(),
        corpusResult({ id: 'C2', name: 'gandalf', trainOverlap: 'partial', sha256: 'def456' }),
      ],
      seed: 20260603,
      environment: captureEnvironment(),
    });
    expect(out).toContain('`C4`');
    expect(out).toContain('`C2`');
    expect(out).toContain('def456');
    // §3 forbids euphemism: the contaminated corpus must be named as such.
    expect(out).toMatch(/contaminated/i);
    expect(out).toMatch(/in-distribution/i);
  });

  it('reports paraphrase consistency as n/a where a corpus has no paraphrase groups', () => {
    const out = renderReport({
      corpora: [corpusResult({ id: 'C3', hasParaphraseGroups: false })],
      seed: 20260603,
      environment: captureEnvironment(),
    });
    expect(out).toContain('n/a');
    // A corpus that cannot measure the metric must not be shown scoring 0 on it.
    expect(out).not.toContain('| 0.0000 | 0.00%');
  });

  it('marks the soak section absent rather than estimating it', () => {
    expect(report()).toMatch(/Soak test/);
    expect(report()).toMatch(/Not run for this report/);
  });

  it('renders the soak verdict against the 5 MB/hour threshold when a soak ran', () => {
    const out = renderReport({
      corpora: [corpusResult()],
      seed: 20260603,
      environment: captureEnvironment(),
      soak: {
        durationMs: 3_600_000,
        scans: 36_000,
        ratePerSecond: 10,
        slopeMbPerHour: 1.23,
        passed: true,
        csvPath: 'bench/results/soak/run.csv',
      },
    });
    expect(out).toContain('1.23 MB/hour');
    expect(out).toContain('5 MB/hour');
    expect(out).toContain('bench/results/soak/run.csv');
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
