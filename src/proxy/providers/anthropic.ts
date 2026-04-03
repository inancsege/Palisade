import type { LLMProvider } from './base.js';
import type { ExtractedText } from '../../types/proxy.js';

export class AnthropicProvider implements LLMProvider {
  static matches(upstream: string, headers: Record<string, string | string[] | undefined>): boolean {
    if (upstream.includes('anthropic.com')) return true;
    if (headers['x-api-key'] && !headers['authorization']) return true;
    return false;
  }

  extractTexts(body: Record<string, unknown>): ExtractedText[] {
    const texts: ExtractedText[] = [];

    // Extract system prompt
    if (typeof body.system === 'string') {
      texts.push({ source: 'system', role: 'system', text: body.system });
    } else if (Array.isArray(body.system)) {
      for (let i = 0; i < body.system.length; i++) {
        const block = body.system[i];
        if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
          texts.push({ source: `system[${i}].text`, role: 'system', text: block.text });
        }
      }
    }

    // Extract messages
    if (Array.isArray(body.messages)) {
      for (let i = 0; i < body.messages.length; i++) {
        const msg = body.messages[i] as Record<string, unknown>;
        if (!msg) continue;

        const role = typeof msg.role === 'string' ? msg.role : 'unknown';

        if (typeof msg.content === 'string') {
          texts.push({ source: `messages[${i}].content`, role, text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (let j = 0; j < msg.content.length; j++) {
            const block = msg.content[j] as Record<string, unknown>;
            if (block?.type === 'text' && typeof block.text === 'string') {
              texts.push({
                source: `messages[${i}].content[${j}].text`,
                role,
                text: block.text,
              });
            }
          }
        }
      }
    }

    return texts;
  }

  extractStreamingText(data: string): string | null {
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
        return parsed.delta.text ?? null;
      }
    } catch {
      // Not valid JSON, skip
    }
    return null;
  }
}
