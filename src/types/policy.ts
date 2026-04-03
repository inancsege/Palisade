import type { VerdictAction } from './verdict.js';

export interface PolicyConfig {
  version: string;
  defaults: CapabilityDefaults;
  tools: Record<string, ToolPolicy>;
  detection: DetectionPolicyConfig;
}

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
  };
  tier2: {
    enabled: boolean;
    threshold: number;
    action: VerdictAction;
  };
  canary: {
    enabled: boolean;
    rotate_interval: number;
  };
}
