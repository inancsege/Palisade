import { readFileSync } from 'node:fs';
import { parse as parseYAML } from 'yaml';
import * as ajvModule from 'ajv';
import { policySchema } from './schema.js';
import { defaultPolicy } from './defaults.js';
import { PolicyError } from '../utils/errors.js';
import type { PolicyConfig } from '../types/policy.js';

const AjvClass = (ajvModule as Record<string, unknown>).Ajv ??
  (ajvModule as Record<string, unknown>).default ??
  ajvModule;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ajv = new (AjvClass as any)({ allErrors: true, strict: false });
const validate = ajv.compile(policySchema);

export function loadPolicy(filePath: string): PolicyConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new PolicyError(
      `Failed to read policy file: ${(err as Error).message}`,
      filePath,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYAML(raw);
  } catch (err) {
    throw new PolicyError(
      `Failed to parse YAML: ${(err as Error).message}`,
      filePath,
    );
  }

  return validateAndMerge(parsed, filePath);
}

export function validatePolicy(policy: unknown): Array<{ path: string; message: string }> {
  validate(policy);
  if (!validate.errors) return [];
  return validate.errors.map((e: { instancePath?: string; message?: string }) => ({
    path: e.instancePath || '/',
    message: e.message ?? 'Validation error',
  }));
}

export function validateAndMerge(parsed: unknown, filePath?: string): PolicyConfig {
  const errors = validatePolicy(parsed);
  if (errors.length > 0) {
    throw new PolicyError(
      `Invalid policy: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      filePath,
      errors,
    );
  }

  const merged = mergePolicyWithDefaults(parsed as Partial<PolicyConfig>);

  // Cross-field validation: block_threshold must be > warn_threshold
  if (merged.detection.tier1.block_threshold <= merged.detection.tier1.warn_threshold) {
    throw new PolicyError(
      `Invalid policy: detection.tier1.block_threshold (${merged.detection.tier1.block_threshold}) must be greater than warn_threshold (${merged.detection.tier1.warn_threshold})`,
      filePath,
    );
  }

  // Cross-field validation: ambiguous_band must be monotonic and within T1 thresholds (D18, D02).
  // The "consult Tier 2" window is the cascade-gating band: T1 below band.low → allow,
  // T1 inside the band → consult Tier 2, T1 at or above tier1.block_threshold → block (T2 never
  // consulted). The band must therefore be a valid sub-interval of [0, block_threshold]: low must
  // be >= 0 and high must not exceed block_threshold (the T1 block ceiling). The default band
  // [0.3, 0.7] aligns with the D02 cascade split (0.3 allow/consult boundary) and the default
  // block_threshold (0.7) — it sits below warn_threshold by design, because the cascade allow/consult
  // boundary is independent of the T1 warn verdict line.
  const [bandLow, bandHigh] = merged.detection.tier2.ambiguous_band;
  const { block_threshold } = merged.detection.tier1;
  if (bandLow >= bandHigh) {
    throw new PolicyError(
      `Invalid policy: detection.tier2.ambiguous_band low (${bandLow}) must be less than high (${bandHigh})`,
      filePath,
    );
  }
  if (bandLow < 0 || bandHigh > block_threshold) {
    throw new PolicyError(
      `Invalid policy: detection.tier2.ambiguous_band [${bandLow}, ${bandHigh}] must sit within the Tier 1 cascade window [0, ${block_threshold}] (low >= 0, high <= block_threshold)`,
      filePath,
    );
  }

  return merged;
}

export function mergePolicyWithDefaults(partial: Partial<PolicyConfig>): PolicyConfig {
  return {
    version: partial.version ?? defaultPolicy.version,
    defaults: {
      ...defaultPolicy.defaults,
      ...partial.defaults,
    },
    tools: {
      ...defaultPolicy.tools,
      ...partial.tools,
    },
    detection: {
      tier1: { ...defaultPolicy.detection.tier1, ...partial.detection?.tier1 },
      tier2: { ...defaultPolicy.detection.tier2, ...partial.detection?.tier2 },
      canary: { ...defaultPolicy.detection.canary, ...partial.detection?.canary },
    },
  };
}
