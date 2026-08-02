import type { BlockedResponse } from '../types/proxy.js';
import { PalisadeAdapter, type AdapterMessage } from './core.js';

/**
 * Error thrown when the adapter decides a request/response must be blocked.
 * Carries the same `{ error }` payload shape as the proxy's `BlockedResponse`,
 * and the middleware-dispatchable `status`/`statusText` fields the Vercel AI SDK
 * expects from `JSONResponseError`.
 */
export class PalisadeBlockedError extends Error {
  readonly statusCode: number;
  readonly cause: { body: BlockedResponse };

  constructor(body: BlockedResponse, statusCode = 403) {
    super(`Palisade blocked the request: ${body.error.message}`);
    this.name = 'PalisadeBlockedError';
    this.statusCode = statusCode;
    this.cause = { body };
  }
}

/**
 * A minimal stand-in for the Vercel AI SDK's `LanguageModelV1Message` — the SDK
 * is intentionally NOT a dependency; this adapter is duck-typed against the
 * documented `wrapLanguageModel({ model, middleware })` contract. `input` may be
 * a raw prompt string or an array of `{ role, content }` messages.
 */
export interface AISDKMessage {
  role: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

export interface PalisadeMiddleware {
  transformParams: (args: { params: { input?: unknown; [k: string]: unknown } }) => Promise<{
    input?: unknown;
    [k: string]: unknown;
  }>;
  wrapGenerate: (args: {
    doGenerate: (params: unknown) => Promise<unknown>;
  }) => (params: unknown) => Promise<unknown>;
  wrapStream: (args: {
    doStream: (params: unknown) => Promise<AsyncIterable<unknown>>;
  }) => (params: unknown) => AsyncIterable<unknown>;
}

function isPromptString(value: unknown): value is string {
  return typeof value === 'string';
}

function isMessagesShape(value: unknown): value is AISDKMessage[] {
  return Array.isArray(value) && value.every((m) => !!m && typeof (m as AISDKMessage).role === 'string');
}

function toAdapterMessages(messages: AISDKMessage[]): AdapterMessage[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content };
    }
    const parts = Array.isArray(m.content)
      ? m.content.filter((p) => typeof p === 'object' && p && p.type === 'text' && typeof p.text === 'string')
      : [];
    return {
      role: m.role,
      content: parts.length > 0
        ? parts.map((p) => ({ type: 'text', text: (p as { text: string }).text }))
        : '',
    };
  });
}

function fromAdapterMessages(messages: AdapterMessage[]): AISDKMessage[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    return { role: m.role, content: m.content as Array<{ type?: string; text?: string }> };
  });
}

function streamChunkText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk && typeof chunk === 'object') {
    const obj = chunk as Record<string, unknown>;
    const candidate = (obj.textDelta ?? obj.text ?? obj.content) as unknown;
    if (typeof candidate === 'string') return candidate;
  }
  return '';
}

/**
 * Vercel AI SDK `LanguageModelV2Middleware`. Pass the returned object to
 * `wrapLanguageModel({ model, middleware: palisadeMiddleware })`.
 *
 *  - `transformParams`  — scan the incoming messages for injection; when clean,
 *    inject the canary token into the system prompt (canary enabled) and return
 *    the rewritten parameters. On a block verdict, throws `PalisadeBlockedError`.
 *  - `wrapGenerate`     — after the model completes, gate emitted tool calls
 *    against the Tier 3 policy; a hard-block verdict is surfaced as an error.
 *  - `wrapStream`       — scans the text stream for a leaked canary token; the
 *    request errors as soon as the token appears (exfiltration in streaming).
 *
 * The canary token is drawn with a time-limited window so a token rotated out
 * mid-stream is still recognized (CanaryStore grace period).
 */
export function createPalisadeMiddleware(adapter: PalisadeAdapter): PalisadeMiddleware {
  return {
    async transformParams({ params }) {
      const input = params.input;
      if (isPromptString(input)) {
        const result = await adapter.guard({
          messages: [{ role: 'user', content: input }],
        });
        if (result.blocked) throw new PalisadeBlockedError(result.blockedBody!);
        return { ...params };
      }
      if (isMessagesShape(input)) {
        const result = await adapter.guard({ messages: toAdapterMessages(input) });
        if (result.blocked) throw new PalisadeBlockedError(result.blockedBody!);
        return { ...params, input: fromAdapterMessages(result.body!) };
      }
      // Unrecognized shapes pass through — the SDK yields structured prompts.
      return { ...params };
    },

    wrapGenerate({ doGenerate }) {
      return async (params) => {
        const response = (await doGenerate(params)) as { toolCalls?: unknown[] } | null;
        const toolCalls = response?.toolCalls;
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          const calls = (toolCalls as Array<Record<string, unknown>>).map((tc) => ({
            name: String(tc.name ?? ''),
            arguments: tc.input ?? tc.arguments ?? {},
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
            throw new PalisadeBlockedError(blockedBody);
          }
        }
        return response;
      };
    },

    wrapStream({ doStream }) {
      return (params) =>
        (async function* guarded(): AsyncGenerator<unknown> {
          const stream = (await doStream(params)) as AsyncIterable<unknown>;
          const token = adapter.canaryToken();
          // Rolling tail so a token split across chunk boundaries is caught.
          let tail = '';
          for await (const chunk of stream) {
            tail = (tail + streamChunkText(chunk)).slice(-64);
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
        })();
    },
  };
}