/**
 * Slice-B PLACEHOLDER — Tier 2 stride-384 chunker (T2-04, D06).
 *
 * This is a thin, dependency-free typed stub. The real overlapping-window chunker is gated on the
 * Phase 1 bake-off model and lands in Slice B alongside `palisade tier2 install` (T2-09) and the
 * 3-shape warmup (T2-02). It imports NO ML package and makes NO `package.json` change.
 *
 * Contract the real implementation must honor (D06): split long token sequences into overlapping
 * windows with a stride of 384, capped at ~512 tokens / ~4000 chars per window, and the document
 * score is the MAX over windows. The single-window passthrough below is the trivial short-input
 * case that the real chunker must reduce to when the input already fits in one window.
 */

/** Stride/window options for the Slice-B chunker. */
export interface ChunkOptions {
  /** Overlap stride between consecutive windows (D06 default in Slice B: 384). */
  stride?: number;
  /** Maximum tokens per window (D06 cap in Slice B: ~512). */
  max?: number;
}

/**
 * Split `tokens` into overlapping windows for Tier 2 inference.
 *
 * Slice-A stub: single-window passthrough — returns `[tokens]` when non-empty, `[]` otherwise.
 * The stride-384 overlapping-window logic replaces the body in Slice B.
 *
 * @param tokens token ids (from `tokenize`).
 * @param opts   stride/cap options (ignored by the stub).
 * @returns windows of token ids — one passthrough window in Slice A.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function chunk(tokens: number[], opts?: ChunkOptions): number[][] {
  // TODO(slice-b): stride-384 overlapping windows, cap ~512 tokens / 4000 chars, score = max over
  // windows (D06, T2-04).
  return tokens.length ? [tokens] : [];
}
