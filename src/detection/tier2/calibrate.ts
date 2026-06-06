/**
 * Pure confidence calibration for Tier 2 (T2-01 sub-part, D24).
 *
 * `calibratedConfidence = sigmoid((logit(raw) - bias) / temperature)`.
 *
 * The pipeline's INJECTION-label `score` is already a softmaxed probability in [0,1]; `logit(raw)`
 * re-derives the log-odds so temperature/bias scaling happens in logit space (the correct space for
 * temperature scaling on a 2-class classifier). With the shipped defaults (bias 0, temperature 1.0)
 * this is the IDENTITY — `sigmoid(logit(raw)) === raw` — so the calibrated value equals the raw model
 * score until Phase 3 tunes it, preserving the bake-off semantics.
 *
 * Never apply softmax to `raw` (it is already a probability) — that is the calibration-applied-twice
 * bug (Pitfall 4). This file imports NO ML package: it is the most-tested, model-independent seam (D20).
 */

/** Clamp epsilon: keeps `logit` finite at the {0, 1} endpoints (avoids ±Infinity). */
const EPS = 1e-7;

/** Inverse sigmoid (log-odds), clamped to [EPS, 1-EPS] so 0 and 1 map to finite values. */
function logit(p: number): number {
  const c = Math.min(1 - EPS, Math.max(EPS, p));
  return Math.log(c / (1 - c));
}

/** Standard logistic sigmoid, always in (0, 1). */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Calibrate a raw model probability into a [0,1] confidence via temperature scaling + bias shift.
 *
 * @param raw the model's softmaxed INJECTION-label probability in [0,1].
 * @param cal `{ temperature, bias }` from `policy.detection.tier2.calibration`.
 * @returns the calibrated confidence in [0,1]. Identity at `{temperature:1, bias:0}`.
 */
export function calibrate(raw: number, cal: { temperature: number; bias: number }): number {
  // Guard divide-by-zero: a temperature of 0 (or NaN/falsy) falls back to the identity scale.
  const t = cal.temperature || 1.0;
  return sigmoid((logit(raw) - cal.bias) / t);
}
