/**
 * Tier 2 model cache — PURE path / fs / crypto logic (NO ML import, D20).
 *
 * Owns the cross-platform cache-root resolution, the install-presence check, the network-free
 * sha256 tamper helper, and the pinned model identity (commit sha + per-file digests). The
 * `palisade tier2 install` command (a thin network shell) and the `serve` fast-fail both build on
 * the exports here so the verifiable integrity logic stays unit-tested without a 700MB download.
 *
 * Reproducibility (D21): the model is pinned to a concrete HF commit sha — NOT the mutable `main`
 * branch — and every downloaded file is verified against a recorded sha256 before it is trusted.
 * The same sha + per-file digests are mirrored in `docs/model-provenance.md`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** The chosen Tier 2 model repo (FOUND-03 bake-off winner; Apache-2.0; INJECTION = label 1). */
export const MODEL_REPO = 'protectai/deberta-v3-base-prompt-injection-v2';

/**
 * The PINNED HF commit sha (40-char hex) the model is installed from — resolved from
 * `https://huggingface.co/api/models/<repo>` at plan-02-07 execution (2026-06-06), NOT the mutable
 * `main` ref (BLOCKER 2 / D21). The cache subdir name is this hex constant, never user input, so
 * there is no path-traversal surface (ASVS V12).
 */
export const MODEL_SHA = 'e6535ca4ce3ba852083e75ec585d7c8aeb4be4c5';

/**
 * A single required model file: the install-target relative `path` (mirroring the transformers.js
 * local-model layout) and the `source` path within the HF repo, pinned to its `sha256`.
 *
 * The repo ships a self-contained `onnx/` directory (config + tokenizer + weights). The install
 * lays the tokenizer/config JSON at the model-dir ROOT and the weights under `onnx/` so
 * `pipeline('text-classification', modelDir, ...)` resolves both. Digests were computed from the
 * `resolve/<MODEL_SHA>/<source>` download (the two LFS files — `onnx/model.onnx`, `onnx/spm.model`
 * — match their HF `lfs.oid sha256`).
 */
export interface ModelFile {
  /** Path under the installed model dir (what `verifyHash` + `isInstalled` see). */
  path: string;
  /** Path within the HF repo to fetch from `resolve/<MODEL_SHA>/<source>`. */
  source: string;
  /** Pinned sha256 (lowercase hex) of the file's bytes. */
  sha256: string;
}

/**
 * The per-file sha256 pins (BLOCKER 3 tamper gate). `onnx/model.onnx` + `config.json` are the two
 * `isInstalled` gates the rest of the system keys off.
 */
export const MODEL_FILES: ModelFile[] = [
  {
    path: 'config.json',
    source: 'onnx/config.json',
    sha256: '3093743035223c46b1497a72e939e56fa0a50afbd7bafbf7eb8aad060b8d23f8',
  },
  {
    path: 'tokenizer.json',
    source: 'onnx/tokenizer.json',
    sha256: '752fe5f0d5678ad563e1bd2ecc1ddf7a3ba7e2024d0ac1dba1a72975e26dff2f',
  },
  {
    path: 'tokenizer_config.json',
    source: 'onnx/tokenizer_config.json',
    sha256: '77d3dd1a9c30397a06545251ed9274bd92e4a85feb98497eeed50c920f962274',
  },
  {
    path: 'special_tokens_map.json',
    source: 'onnx/special_tokens_map.json',
    sha256: 'b2f1b2f15f29a6b6d9d6ea4eca1675d2c231a71477f151d48f79cc83a625ba21',
  },
  {
    path: 'added_tokens.json',
    source: 'onnx/added_tokens.json',
    sha256: 'dc046d04c9b0ada7ae6f1dc89c465801799acdf0c9a6aab8c15a1b2d5ca4e91f',
  },
  {
    path: 'spm.model',
    source: 'onnx/spm.model',
    sha256: 'c679fbf93643d19aab7ee10c0b99e460bdbc02fedf34b92b05af343b4af586fd',
  },
  {
    path: 'onnx/model.onnx',
    source: 'onnx/model.onnx',
    sha256: 'f0ea7f239f765aedbde7c9e163a7cb38a79c5b8853d3f76db5152172047b228c',
  },
];

/**
 * Resolve the cross-platform cache ROOT for installed models. Precedence (highest first):
 *   1. `PALISADE_MODELS_DIR` — explicit override (testable / CI-friendly), returned verbatim.
 *   2. `XDG_CACHE_HOME` → `<xdg>/palisade/models`.
 *   3. `homedir()/.cache/palisade/models` — the default (works on Windows: `C:\Users\<u>\.cache`).
 */
export function resolveCacheRoot(): string {
  const override = process.env.PALISADE_MODELS_DIR;
  if (override && override.length > 0) return override;
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.cache');
  return join(base, 'palisade', 'models');
}

/** The install directory for a given commit sha: `<cacheRoot>/<sha>`. */
export function modelDirFor(sha: string): string {
  return join(resolveCacheRoot(), sha);
}

/**
 * True only when the model dir holds BOTH the ONNX weights (`onnx/model.onnx`) AND `config.json` —
 * the minimal set `pipeline('text-classification', dir)` needs and the `serve` fast-fail keys off.
 * A partial install (only one present) reads as not-installed so the operator re-runs `install`.
 */
export function isInstalled(sha: string): boolean {
  const dir = modelDirFor(sha);
  return existsSync(join(dir, 'onnx', 'model.onnx')) && existsSync(join(dir, 'config.json'));
}

/**
 * PURE, network-free, fs-free sha256 tamper check (BLOCKER 3 / ASVS V6, threat T-02-07-T). Returns
 * true iff `sha256(buf)` equals `expectedSha256` (case-insensitive hex compare). The ONLY integrity
 * gate for the ~700MB download; unit-tested directly (match → true, mismatch → false).
 */
export function verifyHash(buf: Buffer, expectedSha256: string): boolean {
  const actual = createHash('sha256').update(buf).digest('hex');
  return actual === expectedSha256.toLowerCase();
}

/** Build the HF `resolve` URL for a repo-relative source path at the pinned commit. */
export function resolveUrl(source: string): string {
  return `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_SHA}/${source}`;
}
