import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '../../../src/proxy/providers/anthropic.js';
import { OpenAIProvider } from '../../../src/proxy/providers/openai.js';
import { detectProvider } from '../../../src/proxy/providers/index.js';

describe('AnthropicProvider', () => {
  const provider = new AnthropicProvider();

  it('should match anthropic.com upstream', () => {
    expect(AnthropicProvider.matches('https://api.anthropic.com', {})).toBe(true);
  });

  it('should match x-api-key header', () => {
    expect(AnthropicProvider.matches('https://custom.proxy.com', { 'x-api-key': 'sk-ant-123' })).toBe(true);
  });

  it('should extract system prompt (string)', () => {
    const texts = provider.extractTexts({
      system: 'You are a helpful assistant',
      messages: [],
    });
    expect(texts).toHaveLength(1);
    expect(texts[0].role).toBe('system');
    expect(texts[0].text).toBe('You are a helpful assistant');
  });

  it('should extract system prompt (content blocks)', () => {
    const texts = provider.extractTexts({
      system: [{ type: 'text', text: 'Block one' }, { type: 'text', text: 'Block two' }],
      messages: [],
    });
    expect(texts).toHaveLength(2);
    expect(texts[0].text).toBe('Block one');
    expect(texts[1].text).toBe('Block two');
  });

  it('should extract messages with string content', () => {
    const texts = provider.extractTexts({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
    });
    expect(texts).toHaveLength(2);
    expect(texts[0].role).toBe('user');
    expect(texts[1].role).toBe('assistant');
  });

  it('should extract messages with content blocks', () => {
    const texts = provider.extractTexts({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Look at this' },
            { type: 'image', source: { type: 'base64', data: '...' } },
          ],
        },
      ],
    });
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe('Look at this');
  });
});

describe('OpenAIProvider', () => {
  const provider = new OpenAIProvider();

  it('should match openai.com upstream', () => {
    expect(OpenAIProvider.matches('https://api.openai.com', {})).toBe(true);
  });

  it('should match Authorization Bearer header', () => {
    expect(OpenAIProvider.matches('https://custom.proxy.com', { authorization: 'Bearer sk-123' })).toBe(true);
  });

  it('should extract messages', () => {
    const texts = provider.extractTexts({
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' },
      ],
    });
    expect(texts).toHaveLength(2);
    expect(texts[0].role).toBe('system');
    expect(texts[0].text).toBe('You are helpful');
  });

  it('should extract tool call arguments', () => {
    const texts = provider.extractTexts({
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_1', function: { name: 'search', arguments: '{"query":"test"}' } },
          ],
        },
      ],
    });
    expect(texts).toHaveLength(1);
    expect(texts[0].role).toBe('tool_call');
    expect(texts[0].text).toBe('{"query":"test"}');
  });
});

describe('detectProvider', () => {
  it('should detect Anthropic from upstream URL', () => {
    const result = detectProvider('https://api.anthropic.com', {});
    expect(result.type).toBe('anthropic');
  });

  it('should detect OpenAI from upstream URL', () => {
    const result = detectProvider('https://api.openai.com', {});
    expect(result.type).toBe('openai');
  });

  it('should default to unknown for custom endpoints', () => {
    const result = detectProvider('https://my-llm.example.com', {});
    expect(result.type).toBe('unknown');
  });
});
