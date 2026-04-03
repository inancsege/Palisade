import type { ProviderType } from '../../types/proxy.js';
import type { LLMProvider } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';

export function detectProvider(
  upstream: string,
  headers: Record<string, string | string[] | undefined>,
): { type: ProviderType; provider: LLMProvider } {
  if (AnthropicProvider.matches(upstream, headers)) {
    return { type: 'anthropic', provider: new AnthropicProvider() };
  }
  if (OpenAIProvider.matches(upstream, headers)) {
    return { type: 'openai', provider: new OpenAIProvider() };
  }
  // Default to OpenAI-compatible format
  return { type: 'unknown', provider: new OpenAIProvider() };
}

export { AnthropicProvider } from './anthropic.js';
export { OpenAIProvider } from './openai.js';
export type { LLMProvider } from './base.js';
