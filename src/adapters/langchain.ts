import { PalisadeAdapter, type AdapterMessage } from './core.js';
import { PalisadeBlockedError } from './vercel.js';
import type { BlockedResponse } from '../types/proxy.js';

/**
 * LangChain / LangGraph `BaseChatModel` duck-typed shape. The framework SDK is
 * intentionally NOT a dependency; `wrapLangChainModel` works against any object
 * exposing `invoke(input)` returning a message with `.content` / `.tool_calls`
 * and `stream(input)` returning an async iterable of chunks with `.content`.
 */
export interface ChatModelLike {
  invoke: (input: unknown) => Promise<{ content?: unknown; tool_calls?: unknown[] }>;
  stream: (input: unknown) => AsyncIterable<{ content?: unknown }>;
}

function toAdapterMessages(input: unknown): AdapterMessage[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (Array.isArray(input)) {
    return (input as Array<Record<string, unknown>>).map((msg) => {
      const role = typeof msg.role === 'string' ? msg.role : 'user';
      const content = msg.content;
      if (typeof content === 'string') return { role, content };
      if (Array.isArray(content)) {
        return {
          role,
          content: content.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object'),
        };
      }
      return { role, content: String(content ?? '') };
    });
  }
  return [{ role: 'user', content: String(input ?? '') }];
}

function toLangChainMessages(messages: AdapterMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const role =
      m.role === 'user' ? 'human' : m.role === 'assistant' ? 'ai' : m.role === 'system' ? 'system' : m.role;
    return { role, content: m.content };
  });
}

/**
 * Wrap a LangChain / LangGraph chat model (or any duck-shaped equivalent) so
 * every chat turn passes through Palisade:
 *
 *  - `invoke` scans the inbound messages for injection and appends the canary
 *    token to the system prompt; a block verdict throws `PalisadeBlockedError`
 *    and the underlying model is never called.
 *  - After the model returns, `tool_calls` on the assistant message are gated
 *    against the Tier 3 policy (hard-block → error).
 *  - `stream` scans the token chunks for a canary leak.
 *
 * The wrapper spreads the original model so unrelated properties (providers,
 * model id, `.bind()` helpers) remain intact.
 */
export function wrapLangChainModel(
  model: ChatModelLike,
  adapter: PalisadeAdapter,
): ChatModelLike {
  const wrapped: ChatModelLike = {
    ...model,

    async invoke(input) {
      const base = toAdapterMessages(input);
      const scan = await adapter.guard({ messages: base });
      if (scan.blocked) throw new PalisadeBlockedError(scan.blockedBody as unknown as BlockedResponse);

      const guarded = scan.body ?? base;
      const payload = toLangChainMessages(guarded);
      if (payload.length === guarded.length && !bodiesDiffer(base, guarded)) {
        // No canary injection happened → pass the ORIGINAL objects through so
        // LangChain message instances survive intact.
        const raw = await (model as ChatModelLike).invoke(input);
        return gateResponse(adapter, raw);
      }
      const raw = await (model as ChatModelLike).invoke(payload);
      return gateResponse(adapter, raw);
    },

    stream(input) {
      const self = model as ChatModelLike;
      return {
        async *[Symbol.asyncIterator]() {
          const base = toAdapterMessages(input);
          const scan = await adapter.guard({ messages: base });
          if (scan.blocked) throw new PalisadeBlockedError(scan.blockedBody as unknown as BlockedResponse);

          const guarded = scan.body ?? base;
          const payload = toLangChainMessages(guarded);
          const token = adapter.canaryToken();
          let tail = '';
          const source = tokensUnchanged(base, guarded)
            ? self.stream(input)
            : self.stream(payload);
          for await (const chunk of source) {
            const text = extractChunkText(chunk);
            tail = (tail + text).slice(-64);
            if (token && tail.includes(token)) {
              const blockedBody: BlockedResponse = {
                error: {
                  type: 'canary_detected',
                  message: 'Palisade detected the canary token in the model output stream',
                  verdict: 'block',
                  threatScore: 1,
                  requestId: '',
                },
              };
              throw new PalisadeBlockedError(blockedBody);
            }
            yield chunk;
          }
        },
      };
    },
  };

  return wrapped;
}

function extractChunkText(chunk: unknown): string {
  if (!chunk || typeof chunk !== 'object') return '';
  const c = chunk as Record<string, unknown>;
  const content = c.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
          ? ((part as Record<string, unknown>).text as string)
          : '',
      )
      .join('');
  }
  return '';
}

function bodiesDiffer(a: AdapterMessage[], b: AdapterMessage[]): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function tokensUnchanged(a: AdapterMessage[], b: AdapterMessage[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function gateResponse(
  adapter: PalisadeAdapter,
  raw: { content?: unknown; tool_calls?: unknown[] },
): Promise<{ content?: unknown; tool_calls?: unknown[] }> {
  const toolCalls = raw?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return Promise.resolve(raw);

  const calls = (toolCalls as Array<Record<string, unknown>>).map((tc) => ({
    name: String(tc.name ?? ''),
    arguments: (tc.args ?? tc.input ?? {}) as never,
  }));
  const verdict = adapter.gateToolCalls(calls as never);
  if (verdict.blocked) {
    const blockedBody: BlockedResponse = {
      error: {
        type: 'prompt_injection_detected',
        message: `Palisade blocked tool calls: ${verdict.violations
          .map((v) => `${v.tool} (${v.capabilities.join(', ')})`)
          .join('; ')}`,
        verdict: 'block',
        threatScore: 0,
        requestId: '',
      },
    };
    return Promise.reject(new PalisadeBlockedError(blockedBody));
  }
  return Promise.resolve(raw);
}