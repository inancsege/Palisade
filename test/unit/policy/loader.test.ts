import { describe, it, expect } from 'vitest';
import { validatePolicy, mergePolicyWithDefaults, validateAndMerge } from '../../../src/policy/loader.js';
import { defaultPolicy } from '../../../src/policy/defaults.js';

describe('validatePolicy', () => {
  it('should accept a valid minimal policy', () => {
    const errors = validatePolicy({ version: '1' });
    expect(errors).toHaveLength(0);
  });

  it('should accept a full policy', () => {
    const errors = validatePolicy({
      version: '1',
      defaults: {
        network_egress: 'deny',
        filesystem: 'read_only',
        shell_exec: 'deny',
      },
      tools: {
        'weather-lookup': {
          network_egress: { allow: ['api.weather.com'] },
          filesystem: 'none',
          shell_exec: 'deny',
        },
      },
      detection: {
        tier1: { enabled: true, action: 'block' },
        tier2: { enabled: false, threshold: 0.75, action: 'warn' },
        canary: { enabled: false, rotate_interval: 3600 },
      },
    });
    expect(errors).toHaveLength(0);
  });

  it('should reject missing version', () => {
    const errors = validatePolicy({});
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject invalid version', () => {
    const errors = validatePolicy({ version: '99' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject invalid detection action', () => {
    const errors = validatePolicy({
      version: '1',
      detection: { tier1: { action: 'invalid' } },
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('mergePolicyWithDefaults', () => {
  it('should fill in defaults for empty partial', () => {
    const merged = mergePolicyWithDefaults({ version: '1' });
    expect(merged.defaults.network_egress).toBe('deny');
    expect(merged.detection.tier1.enabled).toBe(true);
    expect(merged.detection.tier2.enabled).toBe(false);
  });

  it('should override defaults with provided values', () => {
    const merged = mergePolicyWithDefaults({
      version: '1',
      defaults: { network_egress: 'allow', filesystem: 'none', shell_exec: 'allow' },
    });
    expect(merged.defaults.network_egress).toBe('allow');
  });

  it('should preserve tools', () => {
    const merged = mergePolicyWithDefaults({
      version: '1',
      tools: {
        'my-tool': { shell_exec: 'deny' },
      },
    });
    expect(merged.tools['my-tool']).toBeDefined();
    expect(merged.tools['my-tool'].shell_exec).toBe('deny');
  });
});

describe('validateAndMerge', () => {
  it('should throw PolicyError for invalid input', () => {
    expect(() => validateAndMerge({})).toThrow();
  });

  it('should return merged config for valid input', () => {
    const result = validateAndMerge({ version: '1' });
    expect(result.version).toBe('1');
    expect(result.detection.tier1.action).toBe('block');
  });
});
