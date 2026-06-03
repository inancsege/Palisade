# Tier 2 Bake-off & Cross-Platform Evidence (FOUND-03/04/06)

> Records the empirical Tier 2 gates. **FOUND-04 (cross-platform ONNX) is COMPLETE** and documented
> here with the CI run URL. **FOUND-06 (tokenizer parity)** infrastructure is green and deferred
> pending the C4 corpus. **FOUND-03 (model bake-off)** is pending the corpus + the small model's
> gated-license acceptance.

**Status:** FOUND-04 ✅ · FOUND-06 infra ✅ (corpus-pending) · FOUND-03 ⏳ (corpus-pending) · 2026-06-03

---

## FOUND-04 — Cross-platform ONNX hello-world ✅ (E1 cut signal CLEARED)

**CI run (per-platform evidence):** https://github.com/inancsege/Palisade/actions/runs/26905207650
**Workflow:** `.github/workflows/onnx-matrix.yml` (`fail-fast: false`, 3-OS matrix, node 20)
**Script:** `bench/ci/onnx-hello.mjs`
**Model:** `protectai/deberta-v3-base-prompt-injection-v2` (see note on model choice below)
**Effective `onnxruntime-node` version (drives inference):** **`1.21.0`** (nested under `@huggingface/transformers@3.8.1`; Phase 2 locks `package.json` from this — NOT the top-level `1.22.0`).

| OS | Result | Label | Score | infer_ms |
|----|--------|-------|-------|----------|
| ubuntu-latest (linux) | ✅ PASSED | INJECTION | 0.9999998 | 30 |
| windows-latest (win32) | ✅ PASSED | INJECTION | 0.9999998 | 42 |
| macos-latest (darwin) | ✅ PASSED | INJECTION | 0.9999998 | 83 |

ONNX installs and runs one inference on Windows + macOS + Linux. **The E1 cut signal is cleared —
Tier 2 is NOT cancelled; v0.2 proceeds with Tier 2.**

### Findings on the way to green (recorded for reproducibility)

1. **`onnxruntime-node@1.22.0` has a broken Linux postinstall** (`Failed to find runtimes/win-x64/native/libonnxruntime_providers_cuda.so in NuGet package`) — the documented 1.22.x install regression. Fixed by installing `@huggingface/transformers@3.8.1` alone and using its nested `onnxruntime-node@1.21.0`. macOS/Windows installed 1.22.0 fine; only Linux broke.
2. **HF returns `401` to anonymous CI downloads** (runner-IP rate limit). Fixed by wiring an `HF_TOKEN` repo secret.
3. **The small model `protectai/deberta-v3-small-prompt-injection-v2` is `gated: auto`** — requires a one-click HF license acceptance even with a valid token (manifested as `403 Forbidden`). The **base** model is **not gated**, so the hello-world uses the base model for the runtime smoke (proving the larger model loads cross-platform is a strictly stronger E1 signal). License is still Apache-2.0 — gating ≠ license.

---

## FOUND-06 — Python ↔ Node tokenizer parity (infra ✅, corpus-pending)

The parity job (`bench/ci/tokenizer-parity-{ref.py,node.mjs,assert.mjs}`) is **green** in the run
above. It currently defers gracefully because the C4 corpus is not yet built (it exits 0 with a
"corpus pending" message). It auto-activates — diffing the full token-ID arrays over the 200+ C4
inputs and failing on any mismatch — once `bench/corpus/*.jsonl` lands.

**Blocked on:** the C4 corpus (plan 01-01 Task 3, needs `OPENAI_API_KEY` for GPT-4 paraphrase) and
the small model's gated acceptance (if parity uses the small tokenizer).

---

## FOUND-03 — Small-vs-base bake-off ⏳ (pending corpus)

`bench/ci/bakeoff.mjs` is committed and ready. It runs **both** models over the C4 corpus, computes
paraphrase consistency + 4-column latency, and emits the ship decision: **lowest-latency model with
paraphrase consistency ≥ 0.75, or the D04 cancel-Tier-2 decision** if neither reaches 0.75.

**Blocked on:**
1. The C4 corpus (`OPENAI_API_KEY`).
2. Acceptance of the small model's gated license at
   https://huggingface.co/protectai/deberta-v3-small-prompt-injection-v2 (one click while logged in;
   the base model is already accessible).

The winning model + dtype + HF commit hashes, or the D04 cancel, will be recorded here when the
bake-off runs.
