import type { ExtractedText } from '../../src/types/proxy.js';
import type { PatternMatch } from '../../src/types/verdict.js';

export function makeText(text: string, role = 'user'): ExtractedText[] {
  return [{ source: 'test', role, text }];
}

export function makeMatch(overrides: Partial<PatternMatch> = {}): PatternMatch {
  return {
    patternId: 'test-pattern',
    description: 'Test pattern',
    tier: 1,
    category: 'override_phrase',
    confidence: 0.9,
    weight: 1.0,
    matchedText: 'test',
    offset: 0,
    length: 4,
    ...overrides,
  };
}

export function anthropicBody(userMessage: string, systemPrompt?: string) {
  return {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 100,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: [{ role: 'user', content: userMessage }],
  };
}

export function openaiBody(userMessage: string, systemMessage?: string) {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemMessage) messages.push({ role: 'system', content: systemMessage });
  messages.push({ role: 'user', content: userMessage });
  return { model: 'gpt-4', messages };
}
