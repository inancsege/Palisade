import type { PolicyConfig } from '../types/policy.js';

export const defaultPolicy: PolicyConfig = {
  version: '1',
  defaults: {
    network_egress: 'deny',
    filesystem: 'read_only',
    shell_exec: 'deny',
  },
  tools: {},
  detection: {
    tier1: { enabled: true, action: 'block' },
    tier2: { enabled: false, threshold: 0.75, action: 'warn' },
    canary: { enabled: false, rotate_interval: 3600 },
  },
};
