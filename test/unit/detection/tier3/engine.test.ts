import { describe, it, expect } from 'vitest';
import { Tier3Engine } from '../../../../src/detection/tier3/index.js';
import { defaultPolicy } from '../../../../src/policy/defaults.js';
import type { PolicyConfig } from '../../../../src/types/policy.js';
import type { ToolCall } from '../../../../src/types/proxy.js';

function policyWith(overrides: {
  tier3?: Partial<PolicyConfig['detection']['tier3']>;
  tools?: PolicyConfig['tools'];
  defaults?: PolicyConfig['defaults'];
}): PolicyConfig {
  return {
    ...defaultPolicy,
    defaults: { ...defaultPolicy.defaults, ...overrides.defaults },
    tools: overrides.tools ?? {},
    detection: {
      ...defaultPolicy.detection,
      tier3: { ...defaultPolicy.detection.tier3, enabled: true, ...overrides.tier3 },
    },
  };
}

function call(name: string, args: unknown): ToolCall {
  return { name, arguments: args };
}

const WEATHER_TOOL = {
  'weather-lookup': {
    network_egress: { allow: ['api.openweathermap.org'] },
  },
};

describe('Tier3Engine.evaluate (T3-05)', () => {
  it('is not consulted when disabled', () => {
    const engine = new Tier3Engine({ ...defaultPolicy, detection: { ...defaultPolicy.detection, tier3: { ...defaultPolicy.detection.tier3, enabled: false } } });
    const r = engine.evaluate([call('fetch', { url: 'https://evil.com' })]);
    expect(r.consulted).toBe(false);
    expect(r.action).toBe('allow');
    expect(r.matches).toEqual([]);
  });

  it('is not consulted when there are no tool calls', () => {
    const engine = new Tier3Engine(policyWith({}));
    const r = engine.evaluate([]);
    expect(r.consulted).toBe(false);
    expect(r.action).toBe('allow');
  });

  it('allows a call that complies with its manifest', () => {
    const engine = new Tier3Engine(policyWith({ tools: WEATHER_TOOL }));
    const r = engine.evaluate([
      call('weather-lookup', { url: 'https://api.openweathermap.org/data/2.5/weather' }),
    ]);
    expect(r.consulted).toBe(true);
    expect(r.action).toBe('allow');
    expect(r.matches).toEqual([]);
    expect(r.violatedTools).toEqual([]);
  });

  it('blocks a call violating its manifest with a tier-3 match', () => {
    const engine = new Tier3Engine(policyWith({ tools: WEATHER_TOOL }));
    const r = engine.evaluate([call('weather-lookup', { url: 'https://evil.example.com/x' })]);
    expect(r.action).toBe('block');
    expect(r.matches).toHaveLength(1);
    const m = r.matches[0];
    expect(m.tier).toBe(3);
    expect(m.category).toBe('network_egress');
    expect(m.confidence).toBe(1);
    expect(m.matchedText).toBe('evil.example.com');
    expect(m.patternId).toBe('capability.network_egress');
    expect(r.violatedTools).toEqual(['weather-lookup']);
  });

  it('collects violations across multiple tools and capabilities', () => {
    const engine = new Tier3Engine(
      policyWith({
        tools: {
          'code-runner': { shell_exec: { allow: ['python3'] } },
          fetch: { network_egress: { allow: ['good.com'] } },
        },
      }),
    );
    const r = engine.evaluate([
      call('code-runner', { command: 'curl -s https://evil.com' }),
      call('fetch', { url: 'https://bad.com' }),
      call('code-runner', { command: 'python3 ok.py' }),
    ]);
    expect(r.matches).toHaveLength(2);
    expect(r.matches.map((m) => m.category).sort()).toEqual(['network_egress', 'shell_exec']);
    expect(r.violatedTools).toEqual(['code-runner', 'fetch']);
    expect(r.toolCount).toBe(3);
  });

  it('honors a warn policy action', () => {
    const engine = new Tier3Engine(policyWith({ tier3: { action: 'warn' }, tools: WEATHER_TOOL }));
    const r = engine.evaluate([call('weather-lookup', { url: 'https://evil.com' })]);
    expect(r.action).toBe('warn');
    expect(r.matches).toHaveLength(1);
  });

  it('honors a log-only (allow) policy action but still reports matches', () => {
    const engine = new Tier3Engine(policyWith({ tier3: { action: 'allow' }, tools: WEATHER_TOOL }));
    const r = engine.evaluate([call('weather-lookup', { url: 'https://evil.com' })]);
    expect(r.action).toBe('allow');
    expect(r.matches).toHaveLength(1);
  });

  it('blocks unclassifiable tools when unknown_tool is block (fail closed via defaults)', () => {
    const engine = new Tier3Engine(policyWith({ unknown_tool: 'block' }));
    const r = engine.evaluate([call('get-weather', { city: 'Paris' })]);
    expect(r.action).toBe('block');
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].patternId).toBe('capability.unknown_tool');
    expect(r.matches[0].category).toBe('custom');
  });

  it('warns on unclassifiable tools when unknown_tool is warn', () => {
    const engine = new Tier3Engine(policyWith({ unknown_tool: 'warn' }));
    const r = engine.evaluate([call('get-weather', { city: 'Paris' })]);
    expect(r.action).toBe('warn');
    expect(r.matches).toHaveLength(1);
  });

  it('evaluates name-derived capabilities against defaults when undeclared', () => {
    const engine = new Tier3Engine(policyWith({}));
    const r = engine.evaluate([call('fetch', { url: 'https://evil.com' })]);
    expect(r.action).toBe('block');
    expect(r.matches[0].category).toBe('network_egress');
  });

  it('resolves manifest lookups case-insensitively', () => {
    const engine = new Tier3Engine(policyWith({ tools: WEATHER_TOOL }));
    const r = engine.evaluate([call('Weather-Lookup', { url: 'https://evil.com' })]);
    expect(r.action).toBe('block');
    expect(r.matches[0].category).toBe('network_egress');
  });

  it('applies global defaults to undeclared capabilities of declared tools', () => {
    // weather-lookup declares only network_egress; a shell_exec-style arg is checked
    // against the global default only if the name hints at shell — it does not here.
    const engine = new Tier3Engine(policyWith({ tools: WEATHER_TOOL }));
    const r = engine.evaluate([call('weather-lookup', { url: 'https://api.openweathermap.org/x' })]);
    expect(r.action).toBe('allow');
  });
});
