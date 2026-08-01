import type { LLMProvider } from './base.js';
import type { ExtractedText, ToolCall } from '../../types/proxy.js';

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

  extractToolCalls(body: Record<string, unknown>): ToolCall[] {
    const calls: ToolCall[] = [];
    const choices = body.choices;
    if (!Array.isArray(choices)) return calls;

    for (const choice of choices) {
      if (!choice || typeof choice !== 'object' || !('message' in choice)) continue;
      const message = (choice as Record<string, unknown>).message as
        | Record<string, unknown>
        | undefined;
      const toolCalls = message?.tool_calls;
      if (!Array.isArray(toolCalls)) continue;

      for (const tc of toolCalls) {
        if (!tc || typeof tc !== 'object') continue;
        const fn = (tc as Record<string, unknown>).function as
          | Record<string, unknown>
          | undefined;
        if (!fn || typeof fn.name !== 'string') continue;

        let args: unknown = fn.arguments;
        if (typeof fn.arguments === 'string') {
          try {
            args = JSON.parse(fn.arguments);
          } catch {
            // Malformed JSON: keep the raw string so the classifier can still inspect it.
            args = fn.arguments;
          }
        }

        const id = (tc as Record<string, unknown>).id;
        calls.push({ id: typeof id === 'string' ? id : undefined, name: fn.name, arguments: args });
      }
    }
    return calls;
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
