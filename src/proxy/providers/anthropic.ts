import type { LLMProvider, StreamingToolCallAccumulator } from './base.js';
import type { ExtractedText, ToolCall } from '../../types/proxy.js';

interface PendingToolBlock {
  id?: string;
  name?: string;
  startInput: unknown;
  jsonFragments: string[];
}

function buildToolCall(pending: PendingToolBlock): ToolCall {
  const concatenated = pending.jsonFragments.join('');
  let args: unknown = pending.startInput;
  if (concatenated.length > 0) {
    try {
      args = JSON.parse(concatenated);
    } catch {
      // Deltas are not valid JSON on their own (e.g. mid-stream abort): keep start input.
    }
  }
  return { id: pending.id, name: pending.name ?? 'unknown', arguments: args };
}

/**
 * Assembles Anthropic SSE tool_use blocks. `content_block_start` seeds the block,
 * `input_json_delta` fragments concatenate into the input JSON, and the block is
 * returned as a ToolCall at `content_block_stop`.
 */
export class AnthropicToolCallAccumulator implements StreamingToolCallAccumulator {
  private pending = new Map<number, PendingToolBlock>();

  ingest(event: unknown): ToolCall[] {
    if (!event || typeof event !== 'object') return [];
    const e = event as Record<string, unknown>;
    const done: ToolCall[] = [];

    if (e.type === 'content_block_start') {
      const block = e.content_block as Record<string, unknown> | undefined;
      if (block?.type === 'tool_use') {
        const index = typeof e.index === 'number' ? e.index : 0;
        this.pending.set(index, {
          id: typeof block.id === 'string' ? block.id : undefined,
          name: typeof block.name === 'string' ? block.name : undefined,
          startInput: block.input,
          jsonFragments: [],
        });
      }
    } else if (e.type === 'input_json_delta') {
      const pending = this.pending.get(e.index as number);
      if (pending && typeof e.partial_json === 'string') {
        pending.jsonFragments.push(e.partial_json);
      }
    } else if (e.type === 'content_block_stop') {
      const pending = this.pending.get(e.index as number);
      if (pending) {
        this.pending.delete(e.index as number);
        done.push(buildToolCall(pending));
      }
    }

    return done;
  }

  finish(): ToolCall[] {
    // Anthropic blocks only complete at content_block_stop; incomplete blocks
    // (e.g. mid-stream abort) are dropped so partial tool calls never reach a client.
    return [];
  }
}

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

  extractToolCalls(body: Record<string, unknown>): ToolCall[] {
    const calls: ToolCall[] = [];
    const content = body.content;
    if (!Array.isArray(content)) return calls;

    for (const block of content) {
      if (!block || typeof block !== 'object' || !('type' in block)) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      calls.push({
        id: typeof b.id === 'string' ? b.id : undefined,
        name: b.name,
        arguments: b.input,
      });
    }
    return calls;
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
