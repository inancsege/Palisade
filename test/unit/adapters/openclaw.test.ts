import { describe, it, expect } from 'vitest';
import {
  OPENCLAW_CONFIG_PATH,
  OPENCLAW_PROVIDER_ID,
  buildOpenClawConfig,
  openclawConfigJson,
} from '../../../src/adapters/openclaw.js';

/**
 * OpenClaw reads an optional JSON5 config from `~/.openclaw/openclaw.json`, with model
 * providers nested under `models.providers.<id>` using camelCase keys and an `api`
 * discriminator of `openai-completions` | `anthropic-messages`. These tests pin that
 * published shape — the preset is only useful if OpenClaw actually reads it.
 * https://docs.openclaw.ai/gateway/configuration
 */
describe('OpenClaw preset — real openclaw.json contract', () => {
  it('documents the config path OpenClaw actually reads', () => {
    expect(OPENCLAW_CONFIG_PATH).toBe('~/.openclaw/openclaw.json');
  });

  it('nests the provider under models.providers.<id>', () => {
    const config = buildOpenClawConfig({ upstream: 'openai' });
    expect(config.models.providers[OPENCLAW_PROVIDER_ID]).toBeDefined();
  });

  it('uses the openai-completions api with a /v1 base URL for OpenAI upstreams', () => {
    const provider = buildOpenClawConfig({ upstream: 'openai', proxyPort: 8340 })
      .models.providers[OPENCLAW_PROVIDER_ID];
    expect(provider.api).toBe('openai-completions');
    expect(provider.baseUrl).toBe('http://127.0.0.1:8340/v1');
  });

  it('uses the anthropic-messages api with a bare base URL for Anthropic upstreams', () => {
    const provider = buildOpenClawConfig({ upstream: 'anthropic', proxyPort: 8340 })
      .models.providers[OPENCLAW_PROVIDER_ID];
    expect(provider.api).toBe('anthropic-messages');
    expect(provider.baseUrl).toBe('http://127.0.0.1:8340');
  });

  it('uses camelCase keys, never the snake_case ones OpenClaw ignores', () => {
    const provider = buildOpenClawConfig({ upstream: 'openai' })
      .models.providers[OPENCLAW_PROVIDER_ID] as unknown as Record<string, unknown>;
    expect(provider).toHaveProperty('baseUrl');
    expect(provider).toHaveProperty('apiKey');
    expect(provider).not.toHaveProperty('base_url');
    expect(provider).not.toHaveProperty('api_key');
    expect(provider).not.toHaveProperty('provider_id');
  });

  it('declares the model in a models[] array of { id, name }', () => {
    const provider = buildOpenClawConfig({ upstream: 'openai', model: 'gpt-4o' })
      .models.providers[OPENCLAW_PROVIDER_ID];
    expect(provider.models).toEqual([{ id: 'gpt-4o', name: expect.any(String) }]);
  });

  it('selects the routed model as the agent default using provider/model form', () => {
    const config = buildOpenClawConfig({ upstream: 'openai', model: 'gpt-4o' });
    expect(config.agents.defaults.model.primary).toBe(`${OPENCLAW_PROVIDER_ID}/gpt-4o`);
  });

  it('honours an explicit baseUrl over host/port', () => {
    const provider = buildOpenClawConfig({ upstream: 'openai', baseUrl: 'http://palisade.internal:9000/' })
      .models.providers[OPENCLAW_PROVIDER_ID];
    expect(provider.baseUrl).toBe('http://palisade.internal:9000/v1');
  });

  it('strips repeated trailing slashes from an explicit baseUrl', () => {
    const provider = buildOpenClawConfig({ upstream: 'openai', baseUrl: 'http://palisade.internal:9000///' })
      .models.providers[OPENCLAW_PROVIDER_ID];
    expect(provider.baseUrl).toBe('http://palisade.internal:9000/v1');
  });

  it('emits config that parses as JSON and round-trips to the same object', () => {
    const config = buildOpenClawConfig({ upstream: 'anthropic', model: 'claude-sonnet-4' });
    expect(JSON.parse(openclawConfigJson({ upstream: 'anthropic', model: 'claude-sonnet-4' }))).toEqual(config);
  });
});
