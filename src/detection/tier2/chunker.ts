/**
 * Tier 2 stride-384 chunker (T2-04, D06).
 *
 * Splits a long token sequence into overlapping 512-token windows with a stride of 384
 * (128-token overlap = max - stride) so a late-positioned injection is never truncated away
 * (Pitfall 3). A short input that already fits in one window passes straight through. The document
 * score is the MAX over per-window scores (D06): the threat model is "is there an injection
 * ANYWHERE in this text?", so a single high-scoring window is a positive regardless of how many
 * benign windows surround it (mean would dilute a localized injection below threshold).
 *
 * Pure array math — this file imports NO ML package. The window-id -> text decode (`decodeWindow`)
 * lives in `tokenizer.ts`, keeping the chunker model-independent and fully unit-testable (D20).
 */

/** Stride/window options for the chunker. */
export interface ChunkOptions {
  /** Overlap stride between consecutive window starts (D06 default: 384). */
  stride?: number;
  /** Maximum tokens per window (D06 cap: 512). */
  max?: number;
}

/** Default tokens per window (the model's max sequence length). */
const DEFAULT_MAX = 512;
/** Default stride between window starts; 512 - 384 = 128 tokens of overlap. */
const DEFAULT_STRIDE = 384;

/**
 * Split `tokens` into overlapping windows for Tier 2 inference.
 *
 * - empty input -> `[]`
 * - `tokens.length <= max` -> `[tokens]` (single-window passthrough)
 * - otherwise -> stride-`stride` windows of up to `max` tokens, the last covering the tail.
 *
 * @param tokens token ids (from `tokenize`).
 * @param opts   stride/cap overrides (defaults: stride 384, max 512).
 * @returns windows of token ids.
 */
export function chunk(tokens: number[], opts?: ChunkOptions): number[][] {
  const max = opts?.max ?? DEFAULT_MAX;
  const stride = opts?.stride ?? DEFAULT_STRIDE;

  if (tokens.length === 0) return [];
  if (tokens.length <= max) return [tokens];

  const windows: number[][] = [];
  for (let start = 0; start < tokens.length; start += stride) {
    windows.push(tokens.slice(start, start + max));
    // The last window reaches the end of the sequence — stop so we don't emit empty tail windows.
    if (start + max >= tokens.length) break;
  }
  return windows;
}

/**
 * Aggregate per-window scores into the document score (D06: MAX over windows).
 *
 * @param scores per-window injection scores.
 * @returns the maximum score, or 0 for an empty array.
 */
export function maxOverWindows(scores: number[]): number {
  return scores.reduce((acc, s) => Math.max(acc, s), 0);
}
