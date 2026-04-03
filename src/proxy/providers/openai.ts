import type { LLMProvider } from './base.js';
import type { ExtractedText } from '../../types/proxy.js';

export class OpenAIProvider implements LLMProvider {
  static matches(upstream: string, headers: Record<string, string | string[] | undefined>): boolean {
    if (upstream.includes('openai.com')) return true;
    const auth = headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ') && !headers['x-api-key']) {
      return true;
    }
    return false;
  }

  extractTexts(body: Record<string, unknown>): ExtractedText[] {
    const texts: ExtractedText[] = [];

    if (!Array.isArray(body.messages)) return texts;

    for (let i = 0; i < body.messages.length; i++) {
      const msg = body.messages[i] as Record<string, unknown>;
      if (!msg) continue;

      const role = typeof msg.role === 'string' ? msg.role : 'unknown';

      if (typeof msg.content === 'string') {
        texts.push({ source: `messages[${i}].content`, role, text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (let j = 0; j < msg.content.length; j++) {
          const part = msg.content[j] as Record<string, unknown>;
          if (part?.type === 'text' && typeof part.text === 'string') {
            texts.push({
              source: `messages[${i}].content[${j}].text`,
              role,
              text: part.text,
            });
          }
        }
      }

      // Scan tool call arguments too (injection can hide in function args)
      if (Array.isArray(msg.tool_calls)) {
        for (let k = 0; k < msg.tool_calls.length; k++) {
          const tc = msg.tool_calls[k] as Record<string, unknown>;
          const fn = tc?.function as Record<string, unknown> | undefined;
          if (fn && typeof fn.arguments === 'string') {
            texts.push({
              source: `messages[${i}].tool_calls[${k}].function.arguments`,
              role: 'tool_call',
              text: fn.arguments,
            });
          }
        }
      }
    }

    return texts;
  }

  extractStreamingText(data: string): string | null {
    try {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta;
      if (delta?.content) return delta.content;
    } catch {
      // Not valid JSON, skip
    }
    return null;
  }
}
