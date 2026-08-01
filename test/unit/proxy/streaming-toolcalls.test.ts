import { describe, it, expect } from 'vitest';
import { AnthropicToolCallAccumulator } from '../../../src/proxy/providers/anthropic.js';
import { OpenAIToolCallAccumulator } from '../../../src/proxy/providers/openai.js';

describe('AnthropicToolCallAccumulator (streaming, T3-03)', () => {
  it('assembles a tool_use call from content_block_start + input_json_delta + stop', () => {
    const acc = new AnthropicToolCallAccumulator();
    expect(
      acc.ingest({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
    ).toEqual([]);
    expect(
      acc.ingest({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'fetch', input: {} },
      }),
    ).toEqual([]);
    expect(acc.ingest({ type: 'input_json_delta', index: 1, partial_json: '{"url": "https://a' })).toEqual([]);
    expect(acc.ingest({ type: 'input_json_delta', index: 1, partial_json: '.com"}' })).toEqual([]);
    const done = acc.ingest({ type: 'content_block_stop', index: 1 });
    expect(done).toHaveLength(1);
    expect(done[0]).toEqual({ id: 'toolu_01', name: 'fetch', arguments: { url: 'https://a.com' } });
  });

  it('returns one call per completed tool_use block, in order', () => {
    const acc = new AnthropicToolCallAccumulator();
    acc.ingest({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'a', input: {} } });
    acc.ingest({ type: 'input_json_delta', index: 0, partial_json: '{}' });
    const first = acc.ingest({ type: 'content_block_stop', index: 0 });
    acc.ingest({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't2', name: 'b', input: {} } });
    acc.ingest({ type: 'input_json_delta', index: 1, partial_json: '{}' });
    const second = acc.ingest({ type: 'content_block_stop', index: 1 });
    expect(first[0].name).toBe('a');
    expect(second[0].name).toBe('b');
  });

  it('falls back to the start input when concatenated deltas are not valid JSON', () => {
    const acc = new AnthropicToolCallAccumulator();
    acc.ingest({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 't1', name: 'x', input: { fallback: true } },
    });
    acc.ingest({ type: 'input_json_delta', index: 0, partial_json: 'not json' });
    const done = acc.ingest({ type: 'content_block_stop', index: 0 });
    expect(done[0].arguments).toEqual({ fallback: true });
  });

  it('ignores unrelated events (text deltas, other event types)', () => {
    const acc = new AnthropicToolCallAccumulator();
    expect(acc.ingest({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })).toEqual([]);
    expect(acc.ingest({ type: 'message_stop' })).toEqual([]);
    expect(acc.ingest(null)).toEqual([]);
    expect(acc.ingest('not an event')).toEqual([]);
  });

  it('ignores input_json_delta with no pending block (out-of-order or truncated)', () => {
    const acc = new AnthropicToolCallAccumulator();
    expect(acc.ingest({ type: 'input_json_delta', index: 5, partial_json: '{}' })).toEqual([]);
    expect(acc.finish()).toEqual([]);
  });

  it('finish() emits nothing (blocks only complete at content_block_stop)', () => {
    const acc = new AnthropicToolCallAccumulator();
    acc.ingest({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'x', input: {} } });
    expect(acc.finish()).toEqual([]);
  });
});

describe('OpenAIToolCallAccumulator (streaming, T3-03)', () => {
  it('assembles a tool call from incremental arguments fragments across chunks', () => {
    const acc = new OpenAIToolCallAccumulator();
    expect(
      acc.ingest({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"query": "' } }] },
          },
        ],
      }),
    ).toEqual([]);
    expect(
      acc.ingest({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'weather"}' } }] } }],
      }),
    ).toEqual([]);
    const done = acc.ingest({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    expect(done).toHaveLength(1);
    expect(done[0]).toEqual({ id: 'call_1', name: 'search', arguments: { query: 'weather' } });
  });

  it('tracks multiple tool call indices independently', () => {
    const acc = new OpenAIToolCallAccumulator();
    acc.ingest({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'c0', type: 'function', function: { name: 'a', arguments: '{"i":' } },
              { index: 1, id: 'c1', type: 'function', function: { name: 'b', arguments: '{"j":' } },
            ],
          },
        },
      ],
    });
    acc.ingest({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '0}' } },
              { index: 1, function: { arguments: '1}' } },
            ],
          },
        },
      ],
    });
    const done = acc.ingest({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    expect(done.map((c) => c.name)).toEqual(['a', 'b']);
    expect(done[0].arguments).toEqual({ i: 0 });
    expect(done[1].arguments).toEqual({ j: 1 });
  });

  it('keeps the raw concatenated string when arguments are not valid JSON', () => {
    const acc = new OpenAIToolCallAccumulator();
    acc.ingest({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'x', arguments: '{oops' } }] } }],
    });
    const done = acc.ingest({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    expect(done[0].arguments).toBe('{oops');
  });

  it('ignores text-only chunks and unrelated events', () => {
    const acc = new OpenAIToolCallAccumulator();
    expect(acc.ingest({ choices: [{ delta: { content: 'hello' } }] })).toEqual([]);
    expect(acc.ingest({ choices: [] })).toEqual([]);
    expect(acc.ingest(null)).toEqual([]);
    expect(acc.ingest({})).toEqual([]);
  });

  it('finish() flushes a call that arrived without an explicit finish_reason', () => {
    const acc = new OpenAIToolCallAccumulator();
    acc.ingest({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'y', arguments: '{}' } }] } }],
    });
    const done = acc.finish();
    expect(done).toHaveLength(1);
    expect(done[0].name).toBe('y');
  });

  it('finish() with no tool calls returns []', () => {
    const acc = new OpenAIToolCallAccumulator();
    expect(acc.finish()).toEqual([]);
  });
});
