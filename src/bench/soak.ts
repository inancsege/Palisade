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
  /** Requests actually completed per second — a slow scan degrades the requested rate. */
  achievedRatePerSecond: number;
  /** Least-squares slope of RSS (MB) against elapsed time (hours), cold sample excluded. */
  slopeMbPerHour: number;
  rssMinMb: number;
  rssMaxMb: number;
  /** Supplementary: RSS spread over the final third — a flat tail means no ongoing growth. */
  tailSpreadMb: number;
  /**
   * Whether the slope can distinguish a leak from noise at all.
   *
   * The threshold permits `MAX_RSS_SLOPE_MB_PER_HOUR × hours` of growth over the run. If the
   * observed RSS envelope swings wider than that, a regression line through the series is
   * measuring which phase of the GC cycle each sample landed in, not drift — and both a
   * "pass" and a "fail" from it would be an artifact.
   */
  resolvable: boolean;
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

/**
 * Slope over the STEADY-STATE samples: the first sample is taken before the first scan,
 * while the model-load allocations are still uncollected, and on a real run it reads an
 * order of magnitude above everything after it. Including it drags the regression sharply
 * negative and manufactures a pass. `latencyColumns` excludes its cold sample for the same
 * reason; this mirrors that.
 */
export function slopeMbPerHour(samples: RssSample[]): number {
  return leastSquaresSlope(
    samples.slice(1).map((s) => ({ x: s.elapsedMs / 3_600_000, y: s.rssBytes / BYTES_PER_MB })),
  );
}

/** Steady-state RSS band in MB (cold sample excluded). `[0, 0]` for a series too short. */
export function rssEnvelopeMb(samples: RssSample[]): [min: number, max: number] {
  const steady = samples.slice(1).map((s) => s.rssBytes / BYTES_PER_MB);
  return steady.length > 0 ? [Math.min(...steady), Math.max(...steady)] : [0, 0];
}

/**
 * Spread of the final third of the run, in MB.
 *
 * SUPPLEMENTARY evidence, not a replacement for the pre-registered slope. A process that
 * grows during warm-up and then settles produces a saturating curve, and a single
 * regression line over the whole run over-reads that as drift. The question the protocol
 * is really asking — is memory still climbing once warm? — is answered by whether the tail
 * is flat. A leak keeps climbing; an allocator high-water mark does not.
 */
export function tailSpreadMb(samples: RssSample[], durationMs: number): number {
  const from = durationMs * (2 / 3);
  const tail = samples
    .slice(1)
    .filter((s) => s.elapsedMs >= from)
    .map((s) => s.rssBytes / BYTES_PER_MB);
  return tail.length > 1 ? Math.max(...tail) - Math.min(...tail) : 0;
}

/**
 * Whether a slope over this series can distinguish a leak from noise.
 *
 * The threshold permits `MAX_RSS_SLOPE_MB_PER_HOUR × hours` of growth. If the observed RSS
 * envelope swings wider than that, a regression line is measuring which phase of the GC
 * cycle each sample landed in, and both a pass and a fail from it are artifacts.
 */
export function isResolvable(samples: RssSample[], durationMs: number): boolean {
  const [min, max] = rssEnvelopeMb(samples);
  return max - min <= MAX_RSS_SLOPE_MB_PER_HOUR * (durationMs / 3_600_000);
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

  const durationMs = now() - started;
  const slope = slopeMbPerHour(samples);
  const [rssMinMb, rssMaxMb] = rssEnvelopeMb(samples);

  return {
    samples,
    scans,
    durationMs,
    achievedRatePerSecond: durationMs > 0 ? scans / (durationMs / 1000) : 0,
    slopeMbPerHour: slope,
    rssMinMb,
    rssMaxMb,
    tailSpreadMb: tailSpreadMb(samples, durationMs),
    resolvable: isResolvable(samples, durationMs),
    passed: slope <= MAX_RSS_SLOPE_MB_PER_HOUR,
  };
}

/**
 * Rebuild a result from a committed CSV series.
 *
 * The soak costs an hour of wall-clock, so re-running it to correct how its numbers are
 * PRESENTED would be paying for a measurement twice. The series is the evidence; this
 * re-derives every summary figure from it, which also means a published soak row can be
 * reproduced from the committed CSV without access to the machine that produced it.
 */
export function fromCsv(csv: string): SoakResult {
  const rows = csv
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(','));

  const samples: RssSample[] = rows.map((cells) => ({
    elapsedMs: Number(cells[0]),
    rssBytes: Number(cells[1]),
    scans: Number(cells[3]),
  }));

  const durationMs = samples.length > 0 ? samples[samples.length - 1].elapsedMs : 0;
  const scans = samples.length > 0 ? samples[samples.length - 1].scans : 0;
  const slope = slopeMbPerHour(samples);
  const [rssMinMb, rssMaxMb] = rssEnvelopeMb(samples);

  return {
    samples,
    scans,
    durationMs,
    achievedRatePerSecond: durationMs > 0 ? scans / (durationMs / 1000) : 0,
    slopeMbPerHour: slope,
    rssMinMb,
    rssMaxMb,
    tailSpreadMb: tailSpreadMb(samples, durationMs),
    resolvable: isResolvable(samples, durationMs),
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
