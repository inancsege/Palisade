/**
 * Slice-B PLACEHOLDER — Tier 2 tokenizer (T2-03, D05).
 *
 * This is a thin, dependency-free typed stub. The real tokenizer is gated on the Phase 1
 * bake-off model (FOUND-03, blocked on the C4 corpus credit) and lands in Slice B alongside
 * `palisade tier2 install` (T2-09) and the 3-shape warmup (T2-02). It deliberately imports NO ML
 * package (`@huggingface/transformers` / `onnxruntime-node`) and makes NO `package.json` change —
 * those deps are locked from the proven effective version in Slice B, not guessed now.
 *
 * Contract the real implementation must honor (D05): tokenize the RAW input text — NOT the
 * v0.1-normalized text — so the token distribution matches the model's training distribution.
 * Tier 1 keeps running on normalized text; Tier 2 sees raw.
 */

/**
 * Tokenize `text` into the model's input token ids.
 *
 * Slice-A stub: returns an empty array (no model, no vocabulary). The chosen model's
 * `AutoTokenizer` replaces the body in Slice B.
 *
 * @param text RAW (un-normalized) input text per D05.
 * @returns token ids — empty in Slice A.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function tokenize(text: string): number[] {
  // TODO(slice-b): @huggingface/transformers AutoTokenizer for the chosen model — raw text,
  // NOT v0.1-normalized (D05); parity-verified in FOUND-06 (T2-03).
  return [];
}
