import { describe, it, expect } from 'vitest';
import { calibrate } from '../../../../src/detection/tier2/calibrate.js';

/**
 * Pure calibration tests (T2-01 sub-part, D24).
 *
 * `calibrate(raw, {temperature, bias}) = sigmoid((logit(raw) - bias) / temperature)`.
 * The linchpin assertion is the IDENTITY at default calibration (bias 0, temperature 1.0):
 * `sigmoid(logit(p)) === p`, so the calibrated confidence equals the raw model score until
 * Phase 3 tunes the calibration — preserving the bake-off semantics (Pitfall 4: never softmax twice).
 *
 * No ML import here: calibration is the most-tested, model-independent seam (D20).
 */

const DEFAULT_CAL = { temperature: 1.0, bias: 0 };

describe('calibrate — identity at default calibration (D24 linchpin)', () => {
  it('returns the raw value within 1e-6 for the default {temperature:1, bias:0}', () => {
    for (const p of [0.01, 0.1, 0.5, 0.7, 0.9, 0.99]) {
      expect(calibrate(p, DEFAULT_CAL)).toBeCloseTo(p, 6);
    }
  });
});

describe('calibrate — endpoint clamp (EPS prevents ±Infinity)', () => {
  it('returns a finite value in [0,1] at raw = 0', () => {
    const out = calibrate(0, DEFAULT_CAL);
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBeGreaterThanOrEqual(0);
    expect(out).toBeLessThanOrEqual(1);
  });

  it('returns a finite value in [0,1] at raw = 1', () => {
    const out = calibrate(1, DEFAULT_CAL);
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBeGreaterThanOrEqual(0);
    expect(out).toBeLessThanOrEqual(1);
  });
});

describe('calibrate — bias and temperature behavior', () => {
  it('increasing bias lowers the calibrated value for a fixed raw (monotone in -bias)', () => {
    const raw = 0.6;
    const low = calibrate(raw, { temperature: 1.0, bias: -1 });
    const mid = calibrate(raw, { temperature: 1.0, bias: 0 });
    const high = calibrate(raw, { temperature: 1.0, bias: 1 });
    expect(low).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(high);
  });

  it('temperature > 1 pulls the calibrated value toward 0.5', () => {
    const raw = 0.9; // above 0.5 → higher temperature should pull it down toward 0.5
    const t1 = calibrate(raw, { temperature: 1.0, bias: 0 });
    const t5 = calibrate(raw, { temperature: 5.0, bias: 0 });
    expect(t5).toBeLessThan(t1);
    expect(t5).toBeGreaterThan(0.5);

    const rawLow = 0.1; // below 0.5 → higher temperature should pull it up toward 0.5
    const lowT1 = calibrate(rawLow, { temperature: 1.0, bias: 0 });
    const lowT5 = calibrate(rawLow, { temperature: 5.0, bias: 0 });
    expect(lowT5).toBeGreaterThan(lowT1);
    expect(lowT5).toBeLessThan(0.5);
  });
});

describe('calibrate — divide-by-zero guard', () => {
  it('guards temperature === 0 (falls back to 1.0) and returns a finite [0,1] result', () => {
    const out = calibrate(0.7, { temperature: 0, bias: 0 });
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBeGreaterThanOrEqual(0);
    expect(out).toBeLessThanOrEqual(1);
    // With the fallback temperature 1.0 this is identity at bias 0.
    expect(out).toBeCloseTo(0.7, 6);
  });
});

describe('calibrate — output always within [0,1]', () => {
  it('stays in [0,1] across a sampled grid of raw values and calibrations', () => {
    const cals = [
      { temperature: 1.0, bias: 0 },
      { temperature: 0.5, bias: -2 },
      { temperature: 2.0, bias: 2 },
      { temperature: 1.5, bias: 0.5 },
    ];
    for (const cal of cals) {
      for (let i = 0; i <= 20; i += 1) {
        const raw = i / 20;
        const out = calibrate(raw, cal);
        expect(out).toBeGreaterThanOrEqual(0);
        expect(out).toBeLessThanOrEqual(1);
        expect(Number.isFinite(out)).toBe(true);
      }
    }
  });
});
