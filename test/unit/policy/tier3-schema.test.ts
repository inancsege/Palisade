import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  validatePolicy,
  mergePolicyWithDefaults,
  loadPolicy,
} from '../../../src/policy/loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLE_POLICY_PATH = resolve(__dirname, '../../../policy.example.yaml');

describe('tier3 policy schema (v0.3 extension)', () => {
  describe('backwards compatibility (v0.1/v0.2 policies)', () => {
    it('validates a policy without a tier3 section', () => {
      const errors = validatePolicy({
        version: '1',
        detection: { tier1: { enabled: true } },
      });
      expect(errors).toHaveLength(0);
    });

    it('validates a fully-specified v0.3 tier3 block', () => {
      const errors = validatePolicy({
        version: '1',
        detection: {
          tier3: { enabled: true, action: 'block', block_response: true, unknown_tool: 'warn' },
        },
      });
      expect(errors).toHaveLength(0);
    });

    it('loads the shipped policy.example.yaml under the v0.3 schema', () => {
      const policy = loadPolicy(EXAMPLE_POLICY_PATH);
      expect(policy.detection.tier3.enabled).toBe(false);
      expect(policy.detection.tier3.action).toBe('block');
      expect(policy.detection.tier3.block_response).toBe(false);
      expect(policy.detection.tier3.unknown_tool).toBe('block');
    });

    it('rejects an invalid tier3 action enum value', () => {
      const errors = validatePolicy({
        version: '1',
        detection: { tier3: { action: 'explode' } },
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an invalid unknown_tool enum value', () => {
      const errors = validatePolicy({
        version: '1',
        detection: { tier3: { unknown_tool: 'allow' } },
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a non-boolean block_response', () => {
      const errors = validatePolicy({
        version: '1',
        detection: { tier3: { block_response: 'yes' } },
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a non-boolean enabled', () => {
      const errors = validatePolicy({
        version: '1',
        detection: { tier3: { enabled: 'yes' } },
      });
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects an unknown key under tier3 (additionalProperties:false preserved)', () => {
      const errors = validatePolicy({
        version: '1',
        detection: { tier3: { bogus: 1 } },
      });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe('defaults flow through mergePolicyWithDefaults', () => {
    it('fills in tier3 defaults when no tier3 section is supplied', () => {
      const merged = mergePolicyWithDefaults({ version: '1' });
      expect(merged.detection.tier3.enabled).toBe(false);
      expect(merged.detection.tier3.action).toBe('block');
      expect(merged.detection.tier3.block_response).toBe(false);
      expect(merged.detection.tier3.unknown_tool).toBe('block');
    });

    it('lets a partial tier3 override only the supplied fields', () => {
      const merged = mergePolicyWithDefaults({
        version: '1',
        detection: { tier3: { enabled: true } },
      });
      expect(merged.detection.tier3.enabled).toBe(true);
      // unsupplied fields still fall back to defaults
      expect(merged.detection.tier3.action).toBe('block');
      expect(merged.detection.tier3.block_response).toBe(false);
      expect(merged.detection.tier3.unknown_tool).toBe('block');
    });
  });
});
