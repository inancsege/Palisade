/**
 * The soak test `docs/benchmark-protocol.md` §5 locked: a 1-hour run at 10 req/s whose
 * RSS-over-time slope must stay ≤ 5 MB/hour (PITFALLS P4.4).
 *
 * The point is leak detection, not throughput. A single ONNX session held across tens of
 * thousands of scans is exactly where a per-request tensor leak would show up, and it only
 * shows up over time — a short run cannot distinguish a leak from warm-up allocation.
 */

/** Pass threshold (§5). A steeper slope fails the run. */
export const MAX_RSS_SLOPE_MB_PER_HOUR = 5;

export interface RssSample {
  elapsedMs: number;
  rssBytes: number;
  scans: number;
}

export interface SoakResult {
  samples: RssSample[];
  scans: number;
  durationMs: number;
  /** Least-squares slope of RSS (MB) against elapsed time (hours). */
  slopeMbPerHour: number;
  passed: boolean;
}

/**
 * Ordinary least squares. Returns 0 for a degenerate series (fewer than 2 points, or no
 * spread in x) rather than NaN — a run too short to have a trend has no trend, and a NaN
 * would quietly render as a passing row.
 */
export function leastSquaresSlope(points: Array<{ x: number; y: number }>): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const p of points) {
    numerator += (p.x - meanX) * (p.y - meanY);
    denominator += (p.x - meanX) ** 2;
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

const BYTES_PER_MB = 1024 * 1024;

export function slopeMbPerHour(samples: RssSample[]): number {
  return leastSquaresSlope(
    samples.map((s) => ({ x: s.elapsedMs / 3_600_000, y: s.rssBytes / BYTES_PER_MB })),
  );
}

export interface SoakOptions {
  /** Scored once per request; the text is fixed so memory, not input, is the variable. */
  scan: (text: string) => Promise<unknown>;
  durationMs: number;
  ratePerSecond?: number;
  sampleEveryMs?: number;
  text?: string;
  /** Injected in tests so a soak can be exercised without burning wall-clock. */
  now?: () => number;
}

const SOAK_TEXT =
  'Summarise the attached quarterly report and list the three largest expense categories.';

/**
 * Drive `scan` at a fixed rate, sampling RSS on an interval.
 *
 * Requests are issued sequentially with the remainder of each rate slice slept off, so a
 * scan slower than the slice degrades the rate instead of queueing unbounded work — a
 * backlog would itself look like a memory leak.
 *
 * ponytail: sequential single-stream driver. If soaking concurrent load ever matters,
 * fan out N of these and sum the samples.
 */
export async function runSoak(options: SoakOptions): Promise<SoakResult> {
  const rate = options.ratePerSecond ?? 10;
  const sampleEveryMs = options.sampleEveryMs ?? 30_000;
  const text = options.text ?? SOAK_TEXT;
  const now = options.now ?? (() => Date.now());
  const sliceMs = 1000 / rate;

  const started = now();
  const samples: RssSample[] = [];
  let scans = 0;
  let nextSampleAt = 0;

  const sample = (elapsedMs: number): void => {
    samples.push({ elapsedMs, rssBytes: process.memoryUsage().rss, scans });
  };

  for (;;) {
    const elapsed = now() - started;
    if (elapsed >= options.durationMs) break;
    if (elapsed >= nextSampleAt) {
      sample(elapsed);
      nextSampleAt += sampleEveryMs;
    }

    const sliceStarted = now();
    await options.scan(text);
    scans++;

    const remaining = sliceMs - (now() - sliceStarted);
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
  }

  sample(now() - started);

  const slope = slopeMbPerHour(samples);
  return {
    samples,
    scans,
    durationMs: now() - started,
    slopeMbPerHour: slope,
    passed: slope <= MAX_RSS_SLOPE_MB_PER_HOUR,
  };
}

/** `bench/results/soak/<stamp>.csv` — the raw series behind the published slope. */
export function toCsv(result: SoakResult): string {
  return [
    'elapsed_ms,rss_bytes,rss_mb,scans',
    ...result.samples.map(
      (s) => `${s.elapsedMs},${s.rssBytes},${(s.rssBytes / BYTES_PER_MB).toFixed(2)},${s.scans}`,
    ),
    '',
  ].join('\n');
}
