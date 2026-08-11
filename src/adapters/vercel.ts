import type {
  LanguageModelV2CallOptions,
  LanguageModelV2Content,
  LanguageModelV2Middleware,
  LanguageModelV2Prompt,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import type { BlockedResponse, ToolCall } from '../types/proxy.js';
import { PalisadeAdapter, type AdapterMessage } from './core.js';

/**
 * Error thrown when the adapter decides a request/response must be blocked.
 * Carries the same `{ error }` payload shape as the proxy's `BlockedResponse`.
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

/**
 * Flatten a `LanguageModelV2Prompt` into the scannable messages Palisade's engine
 * takes. System messages carry a plain string; every other role carries an array of
 * typed parts, of which only `text` parts hold injectable content.
 */
function promptToAdapterMessages(prompt: LanguageModelV2Prompt): AdapterMessage[] {
  return prompt.map((message): AdapterMessage => {
    if (message.role === 'system') {
      return { role: 'system', content: message.content };
    }
    // `content` is a union of part-array types across roles; widen once so the
    // text filter resolves against a single signature.
    const parts = message.content as ReadonlyArray<{ type: string; text?: unknown }>;
    const text = parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => ({ type: 'text', text: part.text as string }));
    return { role: message.role, content: text };
  });
}

/**
 * Append the canary to the system message, or prepend one when the prompt has none.
 * Applied directly to the SDK prompt rather than round-tripping through
 * `AdapterMessage`, so file/image/tool parts survive untouched.
 */
function injectCanaryIntoPrompt(prompt: LanguageModelV2Prompt, token: string): LanguageModelV2Prompt {
  const systemIndex = prompt.findIndex((m) => m.role === 'system');
  if (systemIndex === -1) {
    return [{ role: 'system', content: token }, ...prompt];
  }
  return prompt.map((message, i) =>
    i === systemIndex && message.role === 'system'
      ? { ...message, content: `${message.content}\n\n${token}` }
      : message,
  );
}

/** Match the proxy's convention: parse the JSON argument string, keep the raw text if malformed. */
function parseToolInput(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function toolCallsFromContent(content: LanguageModelV2Content[]): ToolCall[] {
  return content
    .filter((part): part is Extract<LanguageModelV2Content, { type: 'tool-call' }> => part.type === 'tool-call')
    .map((part) => ({
      id: part.toolCallId,
      name: part.toolName,
      arguments: parseToolInput(part.input),
    }));
}

/**
 * Vercel AI SDK `LanguageModelV2Middleware`. Pass the returned object to
 * `wrapLanguageModel({ model, middleware: createPalisadeMiddleware(adapter) })`.
 *
 *  - `transformParams` — scans `params.prompt` for injection; on a clean verdict
 *    injects the canary token into the system message and returns the rewritten
 *    call options. A block verdict throws `PalisadeBlockedError` and the model is
 *    never invoked.
 *  - `wrapGenerate`    — gates `tool-call` parts in the result `content` array
 *    against the Tier 3 policy.
 *  - `wrapStream`      — pipes the provider stream through a `TransformStream` that
 *    scans text deltas for a leaked canary and gates streamed tool calls, erroring
 *    the stream the moment either fires.
 */
export function createPalisadeMiddleware(adapter: PalisadeAdapter): LanguageModelV2Middleware {
  function gate(calls: ToolCall[]): PalisadeBlockedError | null {
    if (calls.length === 0) return null;
    const verdict = adapter.gateToolCalls(calls);
    return verdict.blocked ? new PalisadeBlockedError(blockedToolCallBody(verdict.violations)) : null;
  }

  return {
    async transformParams({ params }): Promise<LanguageModelV2CallOptions> {
      const result = await adapter.guard({ messages: promptToAdapterMessages(params.prompt) });
      if (result.blocked) throw new PalisadeBlockedError(result.blockedBody!);

      const token = adapter.canaryToken();
      if (!token) return params;
      return { ...params, prompt: injectCanaryIntoPrompt(params.prompt, token) };
    },

    async wrapGenerate({ doGenerate }) {
      const result = await doGenerate();
      const blocked = gate(toolCallsFromContent(result.content));
      if (blocked) throw blocked;
      return result;
    },

    async wrapStream({ doStream }) {
      const { stream, ...rest } = await doStream();
      const scanner = adapter.createCanaryScanner();

      const guard = new TransformStream<LanguageModelV2StreamPart, LanguageModelV2StreamPart>({
        transform(chunk, controller) {
          if (chunk.type === 'text-delta') {
            if (scanner.push(chunk.delta)) {
              controller.error(new PalisadeBlockedError(canaryLeakBody()));
              return;
            }
          } else if (chunk.type === 'tool-call') {
            const blocked = gate([
              { id: chunk.toolCallId, name: chunk.toolName, arguments: parseToolInput(chunk.input) },
            ]);
            if (blocked) {
              controller.error(blocked);
              return;
            }
          }
          controller.enqueue(chunk);
        },
      });

      return { stream: stream.pipeThrough(guard), ...rest };
    },
  };
}
