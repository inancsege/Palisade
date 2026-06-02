# LinkedIn Post — Draft Skeleton (FOUND-08)

> Structure for the Phase 5 LinkedIn launch post. **Credibility-first, not accuracy-first.** Leads
> with limitations framing; every number is `[pending Phase 3/5]`. Narrative: "transparent
> reverse-proxy, three-tier defense, reproducible benchmark, honest about contamination."

## 1. Hook (limitations-first, not hype)
- Open with the honest framing: most prompt-injection "accuracy" numbers are measured on data the
  model was trained on. Lead with *how we avoided that*, not a big number.

## 2. What it is
- Palisade: a transparent reverse-proxy that scans LLM API traffic for prompt injection across
  three tiers — regex (Tier 1) → local ONNX classifier (Tier 2) → hosted Lakera Guard (Tier 3,
  opt-in, off by default).

## 3. The credibility beat (the actual story)
- We **pre-registered** the benchmark protocol in git *before* writing any Tier 2 code — link the
  commit (`git log --reverse` ordering proof).
- We report the headline number **only** on a held-out corpus authored after the models' training
  cutoff (`train_overlap: none`), and show the contaminated corpora side-by-side. `[pending Phase 3]`

## 4. Headline number (with caveats inline)
- One figure from C4, paired with precision / recall / FPR — never a bare "X% accuracy".
  `[pending Phase 3]`

## 5. Reproducibility
- `git clone && npm run benchmark` reproduces the table; `environment.json` + pinned shas.

## 6. Known limitations (stated plainly)
- Novel attacks, multi-turn, multimodal, English-only Tier 2. `[pending Phase 3/5]`

## 7. Call to action
- Link the repo + BENCHMARK.md; invite scrutiny of the methodology.
