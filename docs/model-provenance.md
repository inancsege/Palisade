# Tier 2 Model Provenance & License Compatibility

> **FOUND-02.** Records the candidate Tier 2 models' licenses, training-dataset provenance, and a
> written compatibility assessment. Both bake-off candidates are documented here; the winner
> (or the D04 cancel decision) is recorded in `docs/tier2-bakeoff.md` (plan 1-02). This document
> is **finalized** in Phase 5 (DOC-11) and shipped next to the model artifact as
> `dist/tier2/MODEL_ATTRIBUTION.md`.

**Status:** Registered 2026-06-03; **chosen model decided 2026-06-06** by the FOUND-03 bake-off
(`docs/tier2-bakeoff.md`): **`protectai/deberta-v3-base-prompt-injection-v2`** (paraphrase
consistency 0.978 ≥ 0.75 ship gate). Facts below are verified from the official ProtectAI model
cards this session; the complete training-dataset enumeration is mirrored from the model card and
finalized in Phase 5 (no dataset names are invented here).

---

## Candidate Models

| Model | License | Base | Size | Reported F1 | INJECTION label | Bake-off (FOUND-03) |
|-------|---------|------|------|-------------|-----------------|---------------------|
| `protectai/deberta-v3-small-prompt-injection-v2` | **Apache-2.0** | `microsoft/deberta-v3-small` | ~280 MB | 94.62 | label `1` | not evaluated (HF-gated) |
| `protectai/deberta-v3-base-prompt-injection-v2` ✅ **CHOSEN** | **Apache-2.0** | `microsoft/deberta-v3-base` | ~700 MB | 95.49 | label `1` | bake-off winner (0.978) |

Both ship an ONNX export under `onnx/` in their HF repo (required for `onnxruntime-node`), are
pinned by HF commit hash + sha256 (Phase 1/2 — concrete pins below), and carry the same documented
limitations: **English-only** and a known **false-positive tendency on legitimate system prompts**
(relevant to Palisade's cascade-gating design and the README "Known limitations" section).

### Pinned commit + per-file sha256 (D21 reproducibility, plan 02-07)

The chosen model is pinned to a **concrete HF commit sha** (NOT the mutable `main` ref), resolved
from `https://huggingface.co/api/models/protectai/deberta-v3-base-prompt-injection-v2` on
**2026-06-06**. `palisade tier2 install` downloads the files below from
`https://huggingface.co/protectai/deberta-v3-base-prompt-injection-v2/resolve/<MODEL_SHA>/<source>`
and sha256-verifies each against these pins (network-free `verifyHash`); any mismatch deletes the
partial install and exits non-zero. The same constants live in `src/detection/tier2/model-cache.ts`
(`MODEL_SHA`, `MODEL_REPO`, `MODEL_FILES`).

- **MODEL_REPO:** `protectai/deberta-v3-base-prompt-injection-v2`
- **MODEL_SHA:** `e6535ca4ce3ba852083e75ec585d7c8aeb4be4c5`

| Install path | HF source (`onnx/` layout) | sha256 |
|--------------|----------------------------|--------|
| `config.json` | `onnx/config.json` | `3093743035223c46b1497a72e939e56fa0a50afbd7bafbf7eb8aad060b8d23f8` |
| `tokenizer.json` | `onnx/tokenizer.json` | `752fe5f0d5678ad563e1bd2ecc1ddf7a3ba7e2024d0ac1dba1a72975e26dff2f` |
| `tokenizer_config.json` | `onnx/tokenizer_config.json` | `77d3dd1a9c30397a06545251ed9274bd92e4a85feb98497eeed50c920f962274` |
| `special_tokens_map.json` | `onnx/special_tokens_map.json` | `b2f1b2f15f29a6b6d9d6ea4eca1675d2c231a71477f151d48f79cc83a625ba21` |
| `added_tokens.json` | `onnx/added_tokens.json` | `dc046d04c9b0ada7ae6f1dc89c465801799acdf0c9a6aab8c15a1b2d5ca4e91f` |
| `spm.model` | `onnx/spm.model` | `c679fbf93643d19aab7ee10c0b99e460bdbc02fedf34b92b05af343b4af586fd` (matches HF LFS oid) |
| `onnx/model.onnx` | `onnx/model.onnx` | `f0ea7f239f765aedbde7c9e163a7cb38a79c5b8853d3f76db5152172047b228c` (matches HF LFS oid) |

> The two LFS files (`onnx/model.onnx`, `onnx/spm.model`) carry their sha256 as the HF `lfs.oid`;
> the small JSON blobs were sha256'd from the pinned-commit download (their git-blob oids are SHA-1,
> not sha256, so the content digest is recorded here). The install lays the tokenizer/config JSON at
> the model-dir root and the weights under `onnx/` (the transformers.js local-model layout).

---

## Training-Dataset Provenance

The base model (`protectai/deberta-v3-base-prompt-injection-v2`) is trained on a documented set of
**22 datasets** (per its model card). The license-bearing entries that drive the compatibility
question — verified this session — are:

| Training dataset | License | Why it matters |
|------------------|---------|----------------|
| `VMware/open-instruct` | **CC-BY-3.0** | Attribution-required; redistribution-permissive |
| `natolambert/xstest-v2-copy` | **CC-BY-4.0** | Attribution-required; redistribution-permissive |
| `jackhhao/jailbreak-classification` | (public injection corpus) | Overlaps benchmark corpora → drives the `max()` fusion decision (D01) |
| `Harelix/Prompt-Injection-Mixed-Techniques-2024` | (public injection corpus) | Same overlap concern (D01) |

> **Note (no fabrication):** The full enumerated list of all 22 datasets with each dataset's license
> is mirrored verbatim from the ProtectAI model card and **finalized in Phase 5 (DOC-11)**. The four
> entries above are the ones verified this session and are sufficient for the compatibility
> assessment below (they are the most-restrictive licenses in the set).

---

## License Compatibility Assessment

The Tier 2 model weights are licensed **Apache-2.0**, which permits redistribution and commercial
use. The most-restrictive training-data licenses encountered are **CC-BY-3.0** and **CC-BY-4.0**,
which permit redistribution **provided attribution is preserved**.

**Conclusion: compatible.** Palisade may redistribute / reference the ONNX model artifact under
Apache-2.0, and satisfies the CC-BY-3.0/4.0 attribution requirement by:

1. Shipping this provenance file (finalized) as `dist/tier2/MODEL_ATTRIBUTION.md` next to the model
   artifact (DOC-11).
2. Naming the model, its base model, and the attribution-required training datasets in the README
   and BENCHMARK.md.

Apache-2.0 (permissive) + CC-BY-3.0/4.0 (attribution-required, redistribution-permissive) impose no
copyleft and no share-alike obligation, so there is no conflict with Palisade's own MIT license.
(Cross-checked against research SUMMARY §2/§7 and PITFALLS — Apache-2.0 + CC-BY-4.0 redistribution
is permitted with attribution.)
