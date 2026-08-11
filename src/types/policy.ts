import type { VerdictAction } from './verdict.js';

export interface PolicyConfig {
  version: string;
  defaults: CapabilityDefaults;
  tools: Record<string, ToolPolicy>;
  detection: DetectionPolicyConfig;
}

/**
 * What `mergePolicyWithDefaults` genuinely accepts. A plain `Partial<PolicyConfig>` is too
 * strict: the merge spreads defaults at every nested level, so a policy file may supply
 * `detection.tier2.enabled` alone without restating the rest of the tier. This type says
 * that, instead of forcing callers to hand over fully-formed sub-objects.
 */
export type PartialPolicyConfig = {
  version?: string;
  defaults?: Partial<CapabilityDefaults>;
  tools?: Record<string, ToolPolicy>;
  detection?: { [K in keyof DetectionPolicyConfig]?: Partial<DetectionPolicyConfig[K]> };
};

export interface CapabilityDefaults {
  network_egress: 'allow' | 'deny';
  filesystem: 'none' | 'read_only' | 'read_write';
  shell_exec: 'allow' | 'deny';
}

export interface ToolPolicy {
  network_egress?: NetworkEgressPolicy;
  filesystem?: FilesystemPolicy;
  shell_exec?: ShellExecPolicy;
}

export type NetworkEgressPolicy = 'allow' | 'deny' | { allow: string[] };

export type FilesystemPolicy = 'none' | { read_only: string[] } | { read_write: string[] };

export type ShellExecPolicy = 'allow' | 'deny' | { allow: string[]; deny?: string[] };

export interface DetectionPolicyConfig {
  tier1: {
    enabled: boolean;
    action: VerdictAction;
    block_threshold: number;
    warn_threshold: number;
    max_input_length: number;
  };
  tier2: {
    enabled: boolean;
    threshold: number;
    action: VerdictAction;
    model_path?: string;
    ambiguous_band: [number, number];
    calibration: { temperature: number; bias: number };
    max_input_chars: number;
  };
  canary: {
    enabled: boolean;
    rotate_interval: number;
  };
  tier3: {
    enabled: boolean;
    action: VerdictAction;
    block_response: boolean;
    unknown_tool: 'warn' | 'block';
  };
}
