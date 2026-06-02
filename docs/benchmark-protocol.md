# Palisade v0.2 — Pre-Registered Benchmark Protocol

> **Pre-registration document (FOUND-01).** This file is committed to git **before** any
> `src/detection/tier2/` code exists. Its entire value is the tamper-evident ordering proof
> that the evaluation protocol was fixed *before* any result was measured. Verify with:
>
> ```
> git log --reverse -- docs/benchmark-protocol.md src/detection/tier2/
> ```
>
> The first line MUST be this document's commit. Pre-registration cannot be done retroactively
> (PITFALLS P1.2 / P10.1, research SUMMARY D21).

**Status:** Locked. Numbers are produced in Phase 3; this document fixes *what* will be measured and *how*, not the outcomes.
**Pinned RNG seed (locked forever):** `20260603`
**Registered:** 2026-06-03

---

## 1. Purpose & Scope

Palisade v0.2 adds a three-tier cascade detector (Tier 1 regex → Tier 2 local ONNX classifier →
Tier 3 hosted Lakera Guard). This protocol pre-registers the benchmark that will compare
**Tier 1 alone vs Tier 1+2 vs Tier 1+2+3** so the published numbers are credible and reproducible.

The headline number reported in the README MUST be drawn **only** from corpora marked
`train_overlap: none` (see §3). All other corpora are reported side-by-side for transparency.

---

## 2. Corpora (4 — hard cap)

The 4-corpus cap is a deliberate exclusion criterion to prevent corpus-curation from eating the
timeline (PITFALLS P10.4). Each corpus carries a `train_overlap` field in its MANIFEST:
`none` | `partial` | `full`.

| # | Corpus | License | Lang | Role | sha256 | train_overlap |
|---|--------|---------|------|------|--------|---------------|
| C1 | `deepset/prompt-injections` (116-row test split) | Apache-2.0 | German | Cross-lingual signal | `<pending — pinned when corpus snapshot lands (Phase 3)>` | **partial** |
| C2 | `Lakera/gandalf_ignore_instructions` (112-row test split) | MIT | English | Canonical ignore-instructions corpus | `<pending — Phase 3>` | **partial** |
| C3 | AgentDojo `important_instructions` attack strings | Apache-2.0 | English | Agentic-pattern coverage | `<pending — Phase 3>` | **none** (verify per model) |
| C4 | **Held-out adversarial set** (~200 entries, curated post-Apr-2024) | This repo (MIT) | English | **Headline number source** | owned by `bench/corpus/MANIFEST.yaml` | **none** |

C4 is the only `train_overlap: none` corpus authored by this project; it is the headline source
and is **dual-purpose** — it is also the 200+ fixed inputs consumed by the FOUND-06 tokenizer-parity
test in plan 1-02.

### FP control set (benign — false-positive measurement)

- JBB-Behaviors benign half (100 prompts, MIT).
- Palisade v0.1's 67-case false-positive regression suite (`test/fixtures/benign/*.txt`), extended
  with base64-of-benign cases for the D15 base64 rescan.

---

## 3. Contamination Disclosure (the core credibility mechanic)

Public prompt-injection classifiers are trained on overlapping public corpora. Reporting an
accuracy number on a corpus the model was trained on is reporting an **in-distribution** result,
not a generalization result. This protocol makes contamination explicit:

- Every corpus MANIFEST records `train_overlap: {none, partial, full}`.
- The README **headline number cites `train_overlap: none` corpora only** (C4 in v0.2).
- All 4 corpora are reported **side-by-side** in the methodology table, with the contamination
  column always visible.
- The words **"contaminated"** and **"in-distribution"** are used explicitly in the README and
  BENCHMARK.md — no euphemisms.
- Contamination dedup: any C4 candidate within simhash / 3-gram Jaccard ≥ 0.85 of a known training
  string is **excluded** from the headline set (recorded in the MANIFEST).

---

## 4. Per-Corpus Split

- **20% calibration / 80% eval**, partitioned with the pinned RNG seed `20260603` (recorded in
  each MANIFEST).
- The **calibration split** fits the Tier 2 decision threshold and the fusion calibration **only**.
- The **eval split** is read **only** by `bench/evaluate.ts`. A unit test asserts no other `bench/`
  file reads from the eval partition (prevents train-on-test leakage).

---

## 5. Reported Metrics (locked)

Every metric below appears in the published tables. None may be collapsed or omitted.

- **Per-category F1** — one row per `PatternCategory` plus a `benign` row (PITFALLS P1.5).
- **FPR-on-benign** — a first-class column in every table (never hidden).
- **TNR-on-benign** (specificity) — paired to TPR.
- **Paraphrase consistency** — the dominant ship/no-ship signal for Tier 2; **ship threshold ≥ 0.75**
  on the held-out set (D03/D04 — below threshold cancels Tier 2 per D04).
- **Latency — 4 columns, never collapsed:** `cold_first_call_ms`, `warm_p50_ms`, `warm_p95_ms`,
  `warm_p99_ms` (PITFALLS P1.4).
- **Tier 2 firing rate** — % of traffic landing in the ambiguous band that consults Tier 2.
- **Tier 2 / Tier 3 disagreement rate** — validates the `max()` fusion premise (PITFALLS P6.1).
- **Soak-test RSS slope** — 1-hour run at 10 req/s; pass threshold ≤ 5 MB/hour (PITFALLS P4.4).

No "X% accuracy" claim is published without paired precision / recall / FPR.

---

## 6. Exclusion Criteria (pre-committed)

- **4-corpus hard cap** — no corpus is added after registration (P10.4).
- **Contamination dedup** — C4 entries with simhash / 3-gram Jaccard ≥ 0.85 vs a known training
  string are excluded from the headline set.
- **Time-box** — if any single corpus takes > 4 hours to fetch + clean, drop to 3 corpora, document
  the drop, and proceed (P10.4 / cut-signal discipline).
- **Tier 2 abort (D04)** — if neither candidate model reaches paraphrase consistency ≥ 0.75 on the
  held-out set, Tier 2 is cancelled from v0.2 and only Tier 3 + base64 + benchmark ship.

---

## 7. Reproducibility

- sha256-pin the model commit, the tokenizer commit, and every corpus snapshot URL.
- `palisade benchmark --emit-env` writes an `environment.json` per run (OS, Node, package versions,
  effective `onnxruntime-node` version, hardware).
- README footer records the hardware spec used for the published numbers.
- A "Reproduce these numbers" section ships in the README so a third party can
  `git clone && npm run benchmark` and land within tolerance.

---

## 8. Pre-Registration Integrity Statement

This document is committed to git as the **first** Phase-1 commit, before any
`src/detection/tier2/` path is created in any phase. The ordering is the external,
tamper-evident proof of pre-registration. Anyone can verify it:

```
git log --reverse -- docs/benchmark-protocol.md src/detection/tier2/
```

The first commit listed is this protocol. If a `src/detection/tier2/` commit ever predates it,
the pre-registration claim is void. The integrity anchor commit SHA is recorded in
`.planning/phases/01-foundations/01-01-SUMMARY.md`.
