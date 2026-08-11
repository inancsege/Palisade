import { describe, it, expect } from 'vitest';
import { policyForConfiguration, requireModelFor } from '../../../src/bench/runner.js';
import { defaultPolicy } from '../../../src/policy/defaults.js';

/**
 * `Tier2Engine.hasModel()` returns false when `model_path` is unset, and `scan()` then
 * quietly returns confidence 0. Setting `tier2.enabled = true` alone therefore produces a
 * `tier1+2` row in which Tier 2 NEVER RAN — an invented number, which is precisely what the
 * pre-registered protocol exists to prevent. These tests pin the guard.
 */
describe('Tier 2 model wiring for benchmark configurations', () => {
  it('sets model_path so Tier 2 actually loads, not just `enabled`', () => {
    const policy = policyForConfiguration(defaultPolicy.detection, 'tier1+2', '/models/deberta');
    expect(policy.tier2.enabled).toBe(true);
    expect(policy.tier2.model_path).toBe('/models/deberta');
  });

  it('leaves model_path unset for the tier1-only configuration', () => {
    const policy = policyForConfiguration(defaultPolicy.detection, 'tier1', '/models/deberta');
    expect(policy.tier2.enabled).toBe(false);
  });

  it('refuses to score a Tier 2 configuration when no model is installed', () => {
    expect(() => requireModelFor('tier1+2', null)).toThrowError(/model/i);
    expect(() => requireModelFor('tier1+2+3', null)).toThrowError(/model/i);
  });

  it('allows a tier1-only run with no model installed', () => {
    expect(() => requireModelFor('tier1', null)).not.toThrow();
  });

  it('allows a Tier 2 configuration once a model path is available', () => {
    expect(() => requireModelFor('tier1+2', '/models/deberta')).not.toThrow();
  });
});

describe('degraded-run guard', () => {
  it('fails when Tier 2 fired but every inference silently returned a zero result', async () => {
    const { assertTier2NotDegraded } = await import('../../../src/bench/runner.js');
    const fired = [
      { tiersExecuted: [1, 2], tier2: { calibratedConfidence: 0, latencyMs: 0 } },
      { tiersExecuted: [1], tier2: undefined },
    ] as never;
    expect(() => assertTier2NotDegraded('tier1+2', fired)).toThrowError(/degrad|zero|fail/i);
  });

  it('passes when Tier 2 produced real inferences', async () => {
    const { assertTier2NotDegraded } = await import('../../../src/bench/runner.js');
    const fired = [
      { tiersExecuted: [1, 2], tier2: { calibratedConfidence: 0.02, latencyMs: 31.4 } },
    ] as never;
    expect(() => assertTier2NotDegraded('tier1+2', fired)).not.toThrow();
  });

  it('does not fire when Tier 2 legitimately never entered the band', async () => {
    const { assertTier2NotDegraded } = await import('../../../src/bench/runner.js');
    const none = [{ tiersExecuted: [1], tier2: undefined }] as never;
    expect(() => assertTier2NotDegraded('tier1+2', none)).not.toThrow();
  });

  it('never applies to a tier1-only run', async () => {
    const { assertTier2NotDegraded } = await import('../../../src/bench/runner.js');
    const fired = [{ tiersExecuted: [1, 2], tier2: { calibratedConfidence: 0, latencyMs: 0 } }] as never;
    expect(() => assertTier2NotDegraded('tier1', fired)).not.toThrow();
  });
});
