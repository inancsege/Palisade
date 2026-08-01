import type { ToolCall } from '../../types/proxy.js';
import type { PatternMatch } from '../../types/verdict.js';
import type { PolicyConfig, ToolPolicy } from '../../types/policy.js';
import {
  classifyToolCall,
  type Capability,
  type EffectiveCapabilities,
} from './classifier.js';

export interface BlockedCall {
  call: ToolCall;
  capabilities: string[];
}

export interface Tier3Evaluation {
  /** True when Tier 3 ran (enabled) and had tool calls to evaluate. */
  consulted: boolean;
  action: 'allow' | 'warn' | 'block';
  matches: PatternMatch[];
  toolCount: number;
  violatedTools: string[];
  /** The offending calls, for precise response rewriting by the gate. */
  blockedCalls: BlockedCall[];
  /**
   * Every host evaluated against the egress policy (allowed AND blocked), for
   * the cross-request anomaly tracker (T4-04).
   */
  egressHosts: string[];
}

const SEVERITY = { allow: 0, warn: 1, block: 2 } as const;
const SEVERITY_NAME = ['allow', 'warn', 'block'] as const;

/**
 * Tier 3 — Behavioral Policy Engine (response-side action gate).
 *
 * Evaluates the tool calls a model requested against per-tool capability manifests
 * (`policy.tools`) plus the global defaults. Violations become tier-3 pattern matches
 * that the response gate rewrites/records. Unclassifiable tools (no manifest entry,
 * no name-derived capability) fall back to `unknown_tool`.
 */
export class Tier3Engine {
  constructor(private policy: PolicyConfig) {}

  evaluate(calls: ToolCall[]): Tier3Evaluation {
    const config = this.policy.detection.tier3;
    if (!config.enabled || calls.length === 0) {
      return { consulted: config.enabled && calls.length > 0, action: 'allow', matches: [], toolCount: calls.length, violatedTools: [], blockedCalls: [], egressHosts: [] };
    }

    const matches: PatternMatch[] = [];
    const violatedTools = new Set<string>();
    const blockedCalls: BlockedCall[] = [];
    const egressHosts = new Set<string>();
    // Severity is the stricter of the capability action and the unknown-tool action.
    let severity = 0;

    const effectiveDefaults = this.defaultsAsEffectiveCaps();

    for (const call of calls) {
      const declared = this.lookupManifest(call.name);
      const verdict = classifyToolCall(call, effectiveDefaults, declared);

      if (!verdict.evaluated) {
        matches.push(this.makeMatch('custom', 'capability.unknown_tool',
          `tool '${call.name}' is not covered by any capability manifest`, call.name));
        violatedTools.add(call.name);
        blockedCalls.push({ call, capabilities: ['unknown_tool'] });
        severity = Math.max(severity, SEVERITY[config.unknown_tool]);
        continue;
      }
      for (const host of verdict.egressHosts) egressHosts.add(host);
      if (!verdict.allowed) {
        for (const v of verdict.violations) {
          matches.push(this.makeMatch(v.capability, `capability.${v.capability}`, v.detail, v.value));
        }
        violatedTools.add(call.name);
        blockedCalls.push({ call, capabilities: [...new Set(verdict.violations.map((v) => v.capability))] });
        severity = Math.max(severity, SEVERITY[config.action]);
      }
    }

    return {
      consulted: true,
      action: SEVERITY_NAME[severity],
      matches,
      toolCount: calls.length,
      violatedTools: [...violatedTools],
      blockedCalls,
      egressHosts: [...egressHosts],
    };
  }

  private lookupManifest(name: string): ToolPolicy | undefined {
    return this.policy.tools[name] ?? this.policy.tools[name.toLowerCase()];
  }

  /**
   * The global defaults are bare strings ('read_only'); the classifier needs list
   * shapes. A bare 'read_only' default carries no allow list, so it is equivalent
   * to deny: any path access outside a declared manifest is a violation.
   */
  private defaultsAsEffectiveCaps(): EffectiveCapabilities {
    const d = this.policy.defaults;
    return {
      network_egress: d.network_egress,
      filesystem:
        d.filesystem === 'none'
          ? 'none'
          : d.filesystem === 'read_only'
            ? { read_only: [] }
            : { read_write: [] },
      shell_exec: d.shell_exec,
    };
  }

  private makeMatch(
    category: Capability | 'custom',
    patternId: string,
    description: string,
    matchedText: string,
  ): PatternMatch {
    return {
      patternId,
      description,
      tier: 3,
      category,
      confidence: 1,
      weight: 1,
      matchedText,
      offset: 0,
      length: matchedText.length,
    };
  }
}
