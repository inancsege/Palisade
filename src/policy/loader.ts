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

  return mergePolicyWithDefaults(parsed as Partial<PolicyConfig>);
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
