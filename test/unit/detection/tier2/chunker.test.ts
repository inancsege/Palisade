import { describe, it, expect } from 'vitest';
import { chunk, maxOverWindows } from '../../../../src/detection/tier2/chunker.js';

/**
 * Stride-384 chunker tests (T2-04, D06).
 *
 * The chunker slides a 512-token window with stride 384 (128-token overlap) over a long token
 * sequence so a late-positioned injection is never truncated away (Pitfall 3). Aggregation across
 * windows is MAX (D06) — a single high-scoring window is a positive regardless of benign neighbors.
 *
 * Pure array math, no ML import.
 */

/** Build an ascending [0,1,2,...,n-1] token id array of length n. */
function seq(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

describe('chunk — empty + passthrough (short-input contract preserved)', () => {
  it('returns [] for empty input', () => {
    expect(chunk([])).toEqual([]);
  });

  it('returns exactly [tokens] when length === max (boundary passthrough)', () => {
    const tokens = seq(512);
    const windows = chunk(tokens);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toEqual(tokens);
  });

  it('returns exactly [tokens] when length < max (passthrough)', () => {
    const tokens = seq(400);
    expect(chunk(tokens)).toEqual([tokens]);
  });

  it('preserves the Slice-A trivial passthrough cases', () => {
    expect(chunk([1, 2, 3])).toEqual([[1, 2, 3]]);
    expect(chunk([7, 8], { stride: 384, max: 512 })).toEqual([[7, 8]]);
  });
});

describe('chunk — long input windowing (1000 tokens, default {stride:384, max:512})', () => {
  const tokens = seq(1000);
  const windows = chunk(tokens);

  it('every window has length <= max (512)', () => {
    for (const w of windows) {
      expect(w.length).toBeLessThanOrEqual(512);
    }
  });

  it('windows start at 0, 384, 768 (stride-384 coverage)', () => {
    // first elements are the start indices since tokens are an ascending sequence
    const starts = windows.map((w) => w[0]);
    expect(starts).toEqual([0, 384, 768]);
  });

  it('head coverage — the first window starts at index 0 and contains token[0]', () => {
    expect(windows[0][0]).toBe(0);
    expect(windows[0]).toContain(0);
  });

  it('tail coverage — the LAST window includes the final token (Pitfall 3)', () => {
    const last = windows[windows.length - 1];
    expect(last[last.length - 1]).toBe(tokens[tokens.length - 1]); // 999
  });

  it('middle coverage — consecutive windows overlap by exactly (max - stride) = 128 tokens', () => {
    for (let i = 1; i < windows.length; i += 1) {
      const prev = windows[i - 1];
      const cur = windows[i];
      // overlap = the tokens at the end of prev that also appear at the start of cur
      const prevStart = prev[0];
      const curStart = cur[0];
      // window starts advance by the stride
      expect(curStart - prevStart).toBe(384);
      // the previous window (if full-length) shares its last 128 elements with the current start
      if (prev.length === 512) {
        const overlapFromPrev = prev.slice(384); // last 128 of prev
        const overlapFromCur = cur.slice(0, overlapFromPrev.length);
        expect(overlapFromCur).toEqual(overlapFromPrev);
        expect(overlapFromPrev.length).toBe(128);
      }
    }
  });
});

describe('chunk — small deterministic case {stride:2, max:4} over [0..9]', () => {
  const tokens = seq(10);
  const windows = chunk(tokens, { stride: 2, max: 4 });

  it('produces the documented window starts and a tail-covering final window', () => {
    // starts: 0,2,4,6 then 6+4>=10 break → windows at 0,2,4,6
    expect(windows.map((w) => w[0])).toEqual([0, 2, 4, 6]);
    // last window covers the tail (token 9)
    const last = windows[windows.length - 1];
    expect(last[last.length - 1]).toBe(9);
    expect(last).toEqual([6, 7, 8, 9]);
  });
});

describe('maxOverWindows — D06 max aggregation', () => {
  it('returns the maximum window score', () => {
    expect(maxOverWindows([0.1, 0.9, 0.3])).toBe(0.9);
  });

  it('returns 0 for an empty score array', () => {
    expect(maxOverWindows([])).toBe(0);
  });

  it('handles a single window', () => {
    expect(maxOverWindows([0.42])).toBe(0.42);
  });
});
