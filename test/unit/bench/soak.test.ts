import { describe, it, expect } from 'vitest';
import {
  MAX_RSS_SLOPE_MB_PER_HOUR,
  leastSquaresSlope,
  runSoak,
  slopeMbPerHour,
  toCsv,
  type RssSample,
} from '../../../src/bench/soak.js';

const sample = (elapsedMs: number, rssMb: number, scans = 0): RssSample => ({
  elapsedMs,
  rssBytes: rssMb * 1024 * 1024,
  scans,
});

describe('leastSquaresSlope', () => {
  it('recovers the slope of a clean line', () => {
    const points = [0, 1, 2, 3, 4].map((x) => ({ x, y: 3 * x + 10 }));
    expect(leastSquaresSlope(points)).toBeCloseTo(3, 10);
  });

  it('reports a flat series as zero drift', () => {
    expect(leastSquaresSlope([0, 1, 2, 3].map((x) => ({ x, y: 42 })))).toBe(0);
  });

  it('returns 0 rather than NaN for degenerate input', () => {
    // A run too short to have a trend has no trend. NaN here would render as a passing row.
    expect(leastSquaresSlope([])).toBe(0);
    expect(leastSquaresSlope([{ x: 1, y: 1 }])).toBe(0);
    expect(leastSquaresSlope([{ x: 1, y: 1 }, { x: 1, y: 9 }])).toBe(0);
  });
});

describe('slopeMbPerHour (protocol §5)', () => {
  it('converts a growing RSS series into MB per hour', () => {
    // +10 MB over 30 minutes = 20 MB/hour.
    expect(slopeMbPerHour([sample(0, 100), sample(900_000, 105), sample(1_800_000, 110)])).toBeCloseTo(
      20,
      6,
    );
  });

  it('scores a flat series at zero, which passes the threshold', () => {
    const slope = slopeMbPerHour([sample(0, 200), sample(600_000, 200), sample(1_200_000, 200)]);
    expect(slope).toBe(0);
    expect(slope).toBeLessThanOrEqual(MAX_RSS_SLOPE_MB_PER_HOUR);
  });
});

describe('runSoak', () => {
  it('drives the scanner at the requested rate and samples RSS across the run', async () => {
    let clock = 0;
    let scans = 0;
    const result = await runSoak({
      // Advancing the injected clock per scan lets a 1-hour soak be exercised in
      // milliseconds; real wall-clock here would make the suite unrunnable.
      scan: async () => {
        scans++;
        clock += 100;
      },
      durationMs: 5000,
      ratePerSecond: 10,
      sampleEveryMs: 1000,
      now: () => clock,
    });

    expect(scans).toBe(50);
    expect(result.scans).toBe(50);
    expect(result.samples.length).toBeGreaterThanOrEqual(5);
    expect(result.samples[0].elapsedMs).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(5000);
  });

  it('derives the verdict from the slope it measured', async () => {
    let clock = 0;
    const result = await runSoak({
      scan: async () => {
        clock += 100;
      },
      durationMs: 3000,
      ratePerSecond: 10,
      sampleEveryMs: 500,
      now: () => clock,
    });
    // Asserting a real-RSS outcome here would test the machine's GC, not this code: the
    // injected clock compresses 3 virtual seconds into a few real milliseconds, so any
    // ordinary V8 allocation extrapolates to an enormous MB/hour. What must hold is that
    // the verdict agrees with the slope actually measured.
    expect(result.passed).toBe(result.slopeMbPerHour <= MAX_RSS_SLOPE_MB_PER_HOUR);
    expect(Number.isFinite(result.slopeMbPerHour)).toBe(true);
  });

  it('emits a CSV carrying the raw series behind the published slope', async () => {
    let clock = 0;
    const result = await runSoak({
      scan: async () => {
        clock += 100;
      },
      durationMs: 1000,
      ratePerSecond: 10,
      sampleEveryMs: 500,
      now: () => clock,
    });

    const csv = toCsv(result).trim().split('\n');
    expect(csv[0]).toBe('elapsed_ms,rss_bytes,rss_mb,scans');
    expect(csv.length).toBe(result.samples.length + 1);
    expect(csv[1].split(',')).toHaveLength(4);
  });
});
