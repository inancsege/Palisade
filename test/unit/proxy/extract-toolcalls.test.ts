import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '../../../src/proxy/providers/anthropic.js';
import { OpenAIProvider } from '../../../src/proxy/providers/openai.js';
import type { ToolCall } from '../../../src/types/proxy.js';

describe('AnthropicProvider.extractToolCalls (response-side, T3-02)', () => {
  const provider = new AnthropicProvider();

  it('extracts a single tool_use block with parsed input', () => {
    const calls = provider.extractToolCalls({
      content: [
        { type: 'text', text: 'Let me check the weather.' },
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'weather-lookup',
          input: { city: 'Istanbul', units: 'celsius' },
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      id: 'toolu_01',
      name: 'weather-lookup',
      arguments: { city: 'Istanbul', units: 'celsius' },
    });
  });

  it('extracts multiple tool_use blocks in order', () => {
    const calls = provider.extractToolCalls({
      content: [
        { type: 'tool_use', id: 'toolu_01', name: 'fetch', input: { url: 'https://a.com' } },
        { type: 'tool_use', id: 'toolu_02', name: 'code-runner', input: { cmd: 'python3 x.py' } },
      ],
    });
    expect(calls.map((c) => c.name)).toEqual(['fetch', 'code-runner']);
  });

  it('ignores non-tool_use blocks (text, image, thinking)', () => {
    const calls = provider.extractToolCalls({
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', source: { type: 'base64', data: 'x' } },
        { type: 'thinking', thinking: 'hmm' },
      ],
    });
    expect(calls).toEqual([]);
  });

  it('returns [] for string content, missing content, or empty content', () => {
    expect(provider.extractToolCalls({ content: 'just text' })).toEqual([]);
    expect(provider.extractToolCalls({})).toEqual([]);
    expect(provider.extractToolCalls({ content: [] })).toEqual([]);
  });

  it('keeps primitive input values as arguments', () => {
    const calls = provider.extractToolCalls({
      content: [{ type: 'tool_use', id: 't1', name: 'echo', input: 'hello' }],
    });
    expect(calls[0].arguments).toBe('hello');
  });
});

describe('OpenAIProvider.extractToolCalls (response-side, T3-02)', () => {
  const provider = new OpenAIProvider();

  it('extracts tool_calls with parsed JSON arguments', () => {
    const calls = provider.extractToolCalls({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"query":"weather"}' } },
            ],
          },
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      id: 'call_1',
      name: 'search',
      arguments: { query: 'weather' },
    });
  });

  it('extracts tool_calls from every choice', () => {
    const calls = provider.extractToolCalls({
      choices: [
        { message: { tool_calls: [{ id: 'c1', function: { name: 'a', arguments: '{}' } }] } },
        { message: { tool_calls: [{ id: 'c2', function: { name: 'b', arguments: '{}' } }] } },
      ],
    });
    expect(calls.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('keeps the raw string when arguments JSON is malformed (never throws)', () => {
    const calls = provider.extractToolCalls({
      choices: [
        {
          message: {
            tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{not json' } }],
          },
        },
      ],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments).toBe('{not json');
  });

  it('returns [] for missing choices or a message without tool_calls', () => {
    expect(provider.extractToolCalls({})).toEqual([]);
    expect(provider.extractToolCalls({ choices: [{ message: { content: 'hi' } }] })).toEqual([]);
    expect(provider.extractToolCalls({ choices: [] })).toEqual([]);
  });
});
