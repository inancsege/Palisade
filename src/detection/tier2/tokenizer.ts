/**
 * Tier 2 tokenizer (T2-03, D05).
 *
 * Loads the model's `AutoTokenizer` once via `loadTokenizer(modelDir)` and exposes:
 *   - `tokenize(rawText)` -> integer token ids, so the stride-384 chunker knows token boundaries
 *   - `decodeWindow(ids)` -> text, the window-id -> text seam `runInference` feeds to the classifier
 *
 * D05: Tier 2 tokenizes the RAW (un-normalized) input text — NOT the v0.1-normalized text — so the
 * token distribution matches the model's training distribution. Tier 1 keeps running on normalized
 * text; Tier 2 sees raw. `add_special_tokens: false` lets the chunker window the bare ids; each
 * decoded window is re-tokenized (and re-gets [CLS]/[SEP]) by the inference pipeline.
 *
 * The model is never loaded in unit tests: `@huggingface/transformers` is mocked, and `tokenize`/
 * `decodeWindow` return the unloaded defaults ([] / '') until `loadTokenizer` runs — keeping the
 * 700MB model out of unit CI (D20).
 */

import { AutoTokenizer, type PreTrainedTokenizer } from '@huggingface/transformers';

/** Singleton tokenizer instance; `null` until `loadTokenizer` resolves. */
let _tok: PreTrainedTokenizer | null = null;

/**
 * Load the model's tokenizer from a local model directory (reads `tokenizer.json` +
 * `tokenizer_config.json`). Call once during `initialize()` before any `tokenize`/`decodeWindow`.
 *
 * @param modelDir absolute path to the installed model dir.
 */
export async function loadTokenizer(modelDir: string): Promise<void> {
  _tok = await AutoTokenizer.from_pretrained(modelDir);
}

/**
 * Tokenize `text` into the model's input token ids (RAW text per D05, no special tokens).
 *
 * @param text RAW (un-normalized) input text.
 * @returns token ids — empty when the tokenizer is not loaded (engine guards still hold).
 */
export function tokenize(text: string): number[] {
  if (!_tok) return [];
  // encode returns a plain number[] of ids; the chunker windows them, the pipeline re-adds CLS/SEP.
  return _tok.encode(text, { add_special_tokens: false });
}

/**
 * Decode a window of token ids back to text for the inference pipeline.
 *
 * @param ids token ids from one chunker window.
 * @returns the decoded text — empty string when the tokenizer is not loaded.
 */
export function decodeWindow(ids: number[]): string {
  if (!_tok) return '';
  return _tok.decode(ids, { skip_special_tokens: true });
}

/**
 * Reset the singleton tokenizer to the unloaded state. Test-only seam so each test starts from a
 * known unloaded state ([] / '') without the shared module-level `_tok` leaking across cases.
 */
export function __resetTokenizerForTests(): void {
  _tok = null;
}
