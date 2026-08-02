import { describe, it, expect } from 'vitest';
import {
  buildOpenClawPreset,
  openclawYaml,
} from '../../../src/adapters/openclaw.js';

describe('OpenClaw gateway preset (T6-05)', () => {
  it('builds a preset pointing an OpenAI-compatible provider at the Palisade proxy', () => {
    const preset = buildOpenClawPreset({
      provider: 'openai',
      proxyHost: '127.0.0.1',
      proxyPort: 8340,
      model: 'gpt-4o',
      apiKey: 'sk-test',
    });
    expect(preset.provider_id).toBe('openai_compatible');
    expect(preset.base_url).toBe('http://127.0.0.1:8340/v1');
    expect(preset.model).toBe('gpt-4o');
    expect(preset.api_key).toBe('sk-test');
  });

  it('uses baseUrl verbatim (appending /v1 for openai) when no host/port given', () => {
    const preset = buildOpenClawPreset({
      provider: 'openai',
      baseUrl: 'http://gateway.internal:9000',
      model: 'custom-model',
      apiKey: 'sk-test',
    });
    expect(preset.base_url).toBe('http://gateway.internal:9000/v1');
    expect(preset.model).toBe('custom-model');
  });

  it('keeps the anthropic transport for Claude routes', () => {
    const preset = buildOpenClawPreset({
      provider: 'anthropic',
      baseUrl: 'http://localhost:8340',
      model: 'claude-opus-4',
      apiKey: 'proxy-key',
    });
    expect(preset.provider_id).toBe('anthropic');
    expect(preset.base_url).toBe('http://localhost:8340');
  });

  it('adds a default api_key placeholder when none is supplied', () => {
    const preset = buildOpenClawPreset({
      provider: 'openai',
      baseUrl: 'http://localhost:8340',
    });
    expect(preset.api_key).toBeDefined();
    expect(typeof preset.api_key).toBe('string');
  });

  it('renders a connections.yaml fragment for ~/.openclaw', () => {
    const yaml = openclawYaml({
      provider: 'openai',
      baseUrl: 'http://localhost:8340',
      model: 'gpt-4o',
      apiKey: 'sk-proxy',
    });
    expect(yaml).toContain('provider_id: openai_compatible');
    expect(yaml).toContain('base_url: http://localhost:8340/v1');
    expect(yaml).toContain('model: gpt-4o');
    expect(yaml).toContain('api_key: sk-proxy');
  });
});