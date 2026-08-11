import type { BlockedResponse, ToolCall } from '../types/proxy.js';
import { PalisadeAdapter, type AdapterMessage } from './core.js';
import { PalisadeBlockedError } from './vercel.js';

/**
 * LangChain / LangGraph chat-model guard.
 *
 * `@langchain/core` is an OPTIONAL peer dependency — nothing here imports it at runtime.
 * The wrapper is a `Proxy` over the real model, which matters for three reasons a plain
 * object spread cannot satisfy:
 *
 *  - `BaseChatModel` keeps `invoke`/`stream`/`bindTools`/`pipe` on the PROTOTYPE, so
 *    `{ ...model }` copies none of them and LangGraph's `createReactAgent` (which calls
 *    `bindTools`) breaks immediately.
 *  - `instanceof BaseChatModel` must still hold; a Proxy forwards the prototype.
 *  - Methods that return a new runnable (`bindTools`, `withConfig`, …) are re-wrapped, so
 *    a model re-bound AFTER wrapping is still guarded instead of silently escaping.
 *
 * Methods are returned unbound so `this` resolves to the proxy at the call site — that is
 * what keeps composite helpers (`batch`, `pipe`) routing back through the guarded `invoke`.
 */

/** LangChain message types (`_getType()`) mapped onto Palisade's role vocabulary. */
const LC_TYPE_TO_ROLE: Record<string, string> = {
  human: 'user',
  ai: 'assistant',
  system: 'system',
  tool: 'tool',
  function: 'function',
};

/** Runnable-returning methods whose result must stay guarded. */
const REWRAPPED_METHODS = new Set([
  'bind',
  'bindTools',
  'withConfig',
  'withRetry',
  'withFallbacks',
  'withStructuredOutput',
  'withListeners',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

/** A LangChain `BaseMessage` is identified by its `_getType()` method, not a `role` field. */
function messageRole(message: Record<string, unknown>): string {
  if (typeof message._getType === 'function') {
    const type = (message._getType as () => string)();
    return LC_TYPE_TO_ROLE[type] ?? type;
  }
  if (typeof message.role === 'string') return message.role;
  return 'user';
}

function messageContent(content: unknown): AdapterMessage['content'] {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is Record<string, unknown> => isRecord(part) && typeof part.text === 'string')
      .map((part) => ({ type: 'text', text: part.text as string }));
  }
  return '';
}

/**
 * Normalize any `BaseLanguageModelInput` Palisade may be handed: a bare string, a single
 * message, or an array mixing `BaseMessage` instances, `[role, content]` tuples, plain
 * `{ role, content }` dicts and bare strings.
 */
function toAdapterMessages(input: unknown): AdapterMessage[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];

  if (Array.isArray(input)) {
    return input.map((entry): AdapterMessage => {
      if (typeof entry === 'string') return { role: 'user', content: entry };
      if (Array.isArray(entry)) {
        const [role, content] = entry as [string, unknown];
        return { role: LC_TYPE_TO_ROLE[role] ?? role, content: messageContent(content) };
      }
      if (isRecord(entry)) return { role: messageRole(entry), content: messageContent(entry.content) };
      return { role: 'user', content: String(entry ?? '') };
    });
  }

  if (isRecord(input)) return [{ role: messageRole(input), content: messageContent(input.content) }];
  return [{ role: 'user', content: String(input ?? '') }];
}

/** Append text to a message's content, whether it is a string or an array of parts. */
function appendToContent(content: unknown, token: string): unknown {
  if (typeof content === 'string') return `${content}\n\n${token}`;
  if (Array.isArray(content)) return [...content, { type: 'text', text: token }];
  return token;
}

/**
 * Clone a message instance with new content, preserving its prototype and every other own
 * property (`additional_kwargs`, `response_metadata`, `id`, …). This keeps provider
 * features that ride on system-message metadata — Anthropic `cache_control`, for one —
 * working after canary injection, without importing `@langchain/core` at runtime.
 */
function cloneWithContent(message: Record<string, unknown>, content: unknown): unknown {
  return Object.assign(Object.create(Object.getPrototypeOf(message) as object), message, { content });
}

/**
 * Inject the canary into the input's system message, or prepend one when there is none.
 * A `['system', token]` tuple is used for the prepend case because LangChain coerces
 * message-likes, so no framework class needs to be constructed here.
 */
function injectCanary(input: unknown, token: string): unknown {
  if (typeof input === 'string') {
    return [
      ['system', token],
      ['human', input],
    ];
  }
  if (!Array.isArray(input)) return input;

  const systemIndex = input.findIndex((entry) => {
    if (Array.isArray(entry)) return (entry as [string, unknown])[0] === 'system';
    return isRecord(entry) && messageRole(entry) === 'system';
  });

  if (systemIndex === -1) return [['system', token], ...input];

  return input.map((entry, i) => {
    if (i !== systemIndex) return entry;
    if (Array.isArray(entry)) {
      const [role, content] = entry as [string, unknown];
      return [role, appendToContent(content, token)];
    }
    const message = entry as Record<string, unknown>;
    return cloneWithContent(message, appendToContent(message.content, token));
  });
}

/** LangChain `tool_calls` are `{ name, args, id }` — already the shape Palisade gates on. */
function toolCallsFrom(result: unknown): ToolCall[] {
  if (!isRecord(result) || !Array.isArray(result.tool_calls)) return [];
  return result.tool_calls.filter(isRecord).map((call) => ({
    id: typeof call.id === 'string' ? call.id : undefined,
    name: String(call.name ?? ''),
    arguments: call.args ?? {},
  }));
}

function blockedToolCallBody(violations: Array<{ tool: string; capabilities: string[] }>): BlockedResponse {
  return {
    error: {
      type: 'prompt_injection_detected',
      message: `Palisade blocked tool calls: ${violations
        .map((v) => `${v.tool} (${v.capabilities.join(', ')})`)
        .join('; ')}`,
      verdict: 'block',
      threatScore: 0,
      requestId: '',
    },
  };
}

function canaryLeakBody(): BlockedResponse {
  return {
    error: {
      type: 'canary_detected',
      message: 'Palisade detected the canary token in the model output stream',
      verdict: 'block',
      threatScore: 1,
      requestId: '',
    },
  };
}

/** Scan the input and return the payload to forward, or throw when the verdict is block. */
async function guardInput(adapter: PalisadeAdapter, input: unknown): Promise<unknown> {
  const scan = await adapter.guard({ messages: toAdapterMessages(input) });
  if (scan.blocked) throw new PalisadeBlockedError(scan.blockedBody!);

  const token = adapter.canaryToken();
  return token ? injectCanary(input, token) : input;
}

/**
 * Wrap a LangChain / LangGraph chat model so every turn passes through Palisade:
 *
 *  - `invoke` scans the inbound messages, injects the canary into the system message, and
 *    gates `tool_calls` on the returned message against the Tier 3 policy.
 *  - `stream` scans the inbound messages, then scans streamed text for a canary leak.
 *  - every other member is forwarded to the real model untouched.
 *
 * Known limitation: streamed tool calls arrive as partial `tool_call_chunks` and are NOT
 * gated mid-stream — only `invoke` results are. Route through `palisade serve` if you need
 * streaming tool-call enforcement for LangChain.
 */
export function wrapLangChainModel<T extends object>(model: T, adapter: PalisadeAdapter): T {
  const guardedInvoke = async (input: unknown, ...rest: unknown[]): Promise<unknown> => {
    const payload = await guardInput(adapter, input);
    const result = await (model as { invoke: (i: unknown, ...r: unknown[]) => Promise<unknown> }).invoke(
      payload,
      ...rest,
    );

    const calls = toolCallsFrom(result);
    if (calls.length > 0) {
      const verdict = adapter.gateToolCalls(calls);
      if (verdict.blocked) throw new PalisadeBlockedError(blockedToolCallBody(verdict.violations));
    }
    return result;
  };

  const guardedStream = async (input: unknown, ...rest: unknown[]): Promise<AsyncIterable<unknown>> => {
    const payload = await guardInput(adapter, input);
    const source = await (model as { stream: (i: unknown, ...r: unknown[]) => Promise<AsyncIterable<unknown>> }).stream(
      payload,
      ...rest,
    );
    const scanner = adapter.createCanaryScanner();

    return (async function* scanned(): AsyncGenerator<unknown> {
      for await (const chunk of source) {
        const text = messageContent(isRecord(chunk) ? chunk.content : '');
        const flat = typeof text === 'string' ? text : text.map((part) => part.text ?? '').join('');
        if (scanner.push(flat)) throw new PalisadeBlockedError(canaryLeakBody());
        yield chunk;
      }
    })();
  };

  return new Proxy(model, {
    get(target, prop, receiver) {
      if (prop === 'invoke') return guardedInvoke;
      if (prop === 'stream') return guardedStream;

      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;

      if (REWRAPPED_METHODS.has(prop as string)) {
        return function rewrapped(this: unknown, ...args: unknown[]) {
          const next = (value as (...a: unknown[]) => unknown).apply(this ?? target, args);
          return isRecord(next) ? wrapLangChainModel(next, adapter) : next;
        };
      }
      // Returned unbound: `this` becomes the proxy at the call site, so helpers that
      // delegate internally (batch, pipe) route back through the guarded invoke/stream.
      return value;
    },
  }) as T;
}
