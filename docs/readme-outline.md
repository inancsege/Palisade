# README Revamp — Section Outline (FOUND-08)

> Section skeleton for the Phase 5 publication-grade README. Structure is locked here; **all
> numbers are marked `[pending Phase 3]`** and filled after the benchmark runs. Credibility-first:
> contamination explicit, limitations co-located with numbers.

| § | Section | Maps to | Content | Numbers |
|---|---------|---------|---------|---------|
| 1 | **Hero + one-liner** | DOC-01 | Banner, "transparent prompt-injection detection proxy", threat model in one paragraph | — |
| 2 | **Threat model & limitations (up top)** | DOC-01 | What Palisade catches / does NOT catch (novel attacks, multi-turn, multimodal, English-only Tier 2) — co-located, not buried | — |
| 3 | **Where do my prompts go?** | DOC-02 (D10) | Per-tier data-flow table: Tier 1 local-only, Tier 2 local ONNX, Tier 3 hosted (opt-in, off by default) | — |
| 4 | **Headline results (3×3)** | DOC-03 | Inline 3×3 table — Tier 1 vs T1+2 vs T1+2+3 — citing **C4 (`train_overlap: none`) only**; contamination column visible | `[pending Phase 3]` |
| 5 | **Architecture diagram** | DOC-04 | Mermaid cascade diagram (regex → ONNX → Lakera) with the ambiguous-band gating | — |
| 6 | **Install & quickstart** | DOC-05 | Two-flow snippet: Tier 1 default install; Tier 2 opt-in via `palisade tier2 install` | — |
| 7 | **Reproduce these numbers** | DOC-06 | `git clone && npm run benchmark`; `--emit-env`; tolerance note | `[pending Phase 3]` |
| 8 | **Methodology & contamination** | DOC-07 | Link to `BENCHMARK.md`; explicit "contaminated" vs "in-distribution" framing; per-corpus table | `[pending Phase 3]` |
| 9 | **Known limitations** | DOC-08 | Co-located with the numbers: novel attacks, multi-turn, multimodal, English-only Tier 2, vendor-latency caveats | `[pending Phase 3/5]` |
| 10 | **Hardware footer** | DOC-06 | Spec of the machine that produced the published numbers | `[pending Phase 3]` |

**Downstream:** the full methodology report ships as `BENCHMARK.md` (Phase 5); finalized
`MODEL-PROVENANCE.md` → `dist/tier2/MODEL_ATTRIBUTION.md` (DOC-11). The headline table (§4) draws
**only** from `train_overlap: none` corpora per `docs/benchmark-protocol.md` §3.
