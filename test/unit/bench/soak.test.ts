import { describe, it, expect } from 'vitest';
import {
  MAX_RSS_SLOPE_MB_PER_HOUR,
  isResolvable,
  leastSquaresSlope,
  rssEnvelopeMb,
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
    // Cold sample first, then +10 MB over 30 minutes = 20 MB/hour.
    const slope = slopeMbPerHour([
      sample(0, 999),
      sample(900_000, 100),
      sample(1_800_000, 105),
      sample(2_700_000, 110),
    ]);
    expect(slope).toBeCloseTo(20, 6);
  });

  it('scores a flat series at zero, which passes the threshold', () => {
    const slope = slopeMbPerHour([
      sample(0, 999),
      sample(600_000, 200),
      sample(1_200_000, 200),
      sample(1_800_000, 200),
    ]);
    expect(slope).toBe(0);
    expect(slope).toBeLessThanOrEqual(MAX_RSS_SLOPE_MB_PER_HOUR);
  });

  it('excludes the cold sample, which is taken before the first scan', () => {
    // On a real run the pre-scan sample reads ~1.9 GB of uncollected model-load
    // allocation against a ~150 MB steady state. Including it drags the regression
    // sharply negative and manufactures a pass out of a leaking process.
    const leaking = [sample(600_000, 100), sample(1_200_000, 150), sample(1_800_000, 200)];
    expect(slopeMbPerHour([sample(0, 2000), ...leaking])).toBeGreaterThan(
      MAX_RSS_SLOPE_MB_PER_HOUR,
    );
  });
});

describe('rssEnvelopeMb / isResolvable (§5 resolution check)', () => {
  const ONE_HOUR = 3_600_000;

  it('reports the steady-state band, excluding the cold sample', () => {
    // 1900 MB is the pre-scan model-load reading and must not widen the band.
    expect(rssEnvelopeMb([sample(0, 1900), sample(1000, 140), sample(2000, 155)])).toEqual([140, 155]);
    expect(rssEnvelopeMb([])).toEqual([0, 0]);
    expect(rssEnvelopeMb([sample(0, 1900)])).toEqual([0, 0]);
  });

  it('rejects a series whose GC swing dwarfs the growth the threshold permits', () => {
    // The real 1-hour run swung 38-229 MB against the 5 MB the threshold allows, so
    // neither its pass nor its fail meant anything.
    const noisy = [sample(0, 1900), sample(ONE_HOUR / 2, 38), sample(ONE_HOUR, 229)];
    expect(isResolvable(noisy, ONE_HOUR)).toBe(false);
  });

  it('accepts a series quiet enough for the slope to mean something', () => {
    const quiet = [sample(0, 1900), sample(ONE_HOUR / 2, 150), sample(ONE_HOUR, 152)];
    expect(isResolvable(quiet, ONE_HOUR)).toBe(true);
  });

  it('scales the allowance with run length', () => {
    // A 4 MB swing is within budget over an hour, but not over six minutes.
    const swing = [sample(0, 1900), sample(1000, 150), sample(2000, 154)];
    expect(isResolvable(swing, ONE_HOUR)).toBe(true);
    expect(isResolvable(swing, ONE_HOUR / 10)).toBe(false);
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
    expect(result.resolvable).toBe(isResolvable(result.samples, result.durationMs));
    expect(Number.isFinite(result.slopeMbPerHour)).toBe(true);
  });

  it('reports the rate it achieved, not the rate it was asked for', async () => {
    let clock = 0;
    const result = await runSoak({
      // Each scan burns a full 500ms slice, so 10 req/s is not achievable.
      scan: async () => {
        clock += 500;
      },
      durationMs: 5000,
      ratePerSecond: 10,
      sampleEveryMs: 1000,
      now: () => clock,
    });
    expect(result.achievedRatePerSecond).toBeCloseTo(2, 1);
    expect(result.achievedRatePerSecond).toBeLessThan(10);
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
