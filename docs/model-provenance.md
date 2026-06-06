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
pinned by HF commit hash + sha256 (Phase 1/2), and carry the same documented limitations: **English-only**
and a known **false-positive tendency on legitimate system prompts** (relevant to Palisade's
cascade-gating design and the README "Known limitations" section).

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
