import { describe, it, expect, vi } from 'vitest';
import { checkUnimplementedFeatures } from '../../../src/proxy/server.js';
import { defaultPolicy } from '../../../src/policy/defaults.js';
import type { PolicyConfig } from '../../../src/types/policy.js';

function policyWith(overrides: {
  tier2Enabled?: boolean;
  canaryEnabled?: boolean;
}): PolicyConfig {
  return {
    ...defaultPolicy,
    detection: {
      ...defaultPolicy.detection,
      tier2: { ...defaultPolicy.detection.tier2, enabled: overrides.tier2Enabled ?? false },
      canary: { ...defaultPolicy.detection.canary, enabled: overrides.canaryEnabled ?? false },
    },
  };
}

describe('checkUnimplementedFeatures', () => {
  it('should return empty array when no unimplemented features are enabled', () => {
    const mockLog = { warn: vi.fn() };
    const warnings = checkUnimplementedFeatures(defaultPolicy, mockLog);
    expect(warnings).toEqual([]);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('should NOT warn when tier2.enabled is true (Tier 2 is implemented in v0.2)', () => {
    // Tier 2 ML detection ships in v0.2 (Phase 2). Enabling it without an installed model is
    // handled by the `tier2_model_missing` fast-fail in serve, not by a "not implemented" warning.
    const mockLog = { warn: vi.fn() };
    const warnings = checkUnimplementedFeatures(policyWith({ tier2Enabled: true }), mockLog);
    expect(warnings).toEqual([]);
    expect(mockLog.warn).not.toHaveBeenCalled();
  });

  it('should warn when canary.enabled is true', () => {
    const mockLog = { warn: vi.fn() };
    const warnings = checkUnimplementedFeatures(policyWith({ canaryEnabled: true }), mockLog);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('canary');
    expect(mockLog.warn).toHaveBeenCalledOnce();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'canary' }),
      expect.stringContaining('canary'),
    );
  });

  it('should warn only for canary when both tier2 and canary are enabled (tier2 is implemented)', () => {
    const mockLog = { warn: vi.fn() };
    const warnings = checkUnimplementedFeatures(
      policyWith({ tier2Enabled: true, canaryEnabled: true }),
      mockLog,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('canary');
    expect(mockLog.warn).toHaveBeenCalledOnce();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'canary' }),
      expect.stringContaining('canary'),
    );
  });
});
