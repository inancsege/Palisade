import { describe, it, expect } from 'vitest';
import { injectCanaryToken } from '../../../src/proxy/canary.js';
import { AnthropicProvider } from '../../../src/proxy/providers/anthropic.js';
import { OpenAIProvider } from '../../../src/proxy/providers/openai.js';

const anthropic = new AnthropicProvider();
const openai = new OpenAIProvider();
const TOKEN = 'palcanary-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('injectCanaryToken — Anthropic (T4-02)', () => {
  it('appends to a string system prompt', () => {
    const out = injectCanaryToken({ system: 'You are helpful.', messages: [] }, anthropic, TOKEN);
    expect(out.system).toBe(`You are helpful.\n\n${TOKEN}`);
    expect(out.messages).toEqual([]);
  });

  it('appends a text block to an array system prompt', () => {
    const out = injectCanaryToken(
      { system: [{ type: 'text', text: 'Be brief.' }], messages: [] },
      anthropic,
      TOKEN,
    );
    expect(out.system).toEqual([
      { type: 'text', text: 'Be brief.' },
      { type: 'text', text: TOKEN },
    ]);
  });

  it('creates a system prompt when none exists', () => {
    const out = injectCanaryToken({ messages: [] }, anthropic, TOKEN);
    expect(out.system).toBe(TOKEN);
  });

  it('leaves a non-text system shape untouched', () => {
    const body = { system: { type: 'text', text: 'x' }, messages: [] };
    expect(injectCanaryToken(body, anthropic, TOKEN)).toBe(body);
  });

  it('does not mutate the input body', () => {
    const body = { system: 'original', messages: [] };
    injectCanaryToken(body, anthropic, TOKEN);
    expect(body.system).toBe('original');
  });
});

describe('injectCanaryToken — OpenAI (T4-02)', () => {
  it('appends to an existing system message with string content', () => {
    const out = injectCanaryToken(
      { messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'hi' }] },
      openai,
      TOKEN,
    );
    expect(out.messages[0]).toEqual({ role: 'system', content: `Be concise.\n\n${TOKEN}` });
    expect(out.messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('appends a text part to a system message with array content', () => {
    const out = injectCanaryToken(
      { messages: [{ role: 'system', content: [{ type: 'text', text: 'Hi' }] }] },
      openai,
      TOKEN,
    );
    expect(out.messages[0].content).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'text', text: TOKEN },
    ]);
  });

  it('inserts a system message at the front when none exists', () => {
    const out = injectCanaryToken(
      { messages: [{ role: 'user', content: 'hi' }] },
      openai,
      TOKEN,
    );
    expect(out.messages).toEqual([
      { role: 'system', content: TOKEN },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('leaves bodies without a messages array untouched', () => {
    const body = { model: 'x' };
    expect(injectCanaryToken(body, openai, TOKEN)).toBe(body);
  });

  it('does not mutate the input body', () => {
    const body = { messages: [{ role: 'system', content: 'original' }] };
    injectCanaryToken(body, openai, TOKEN);
    expect(body.messages[0].content).toBe('original');
  });
});
