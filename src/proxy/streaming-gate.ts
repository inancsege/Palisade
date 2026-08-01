import type { LLMProvider } from './providers/base.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import type { PatternMatch } from '../types/verdict.js';
import type { ToolCall } from '../types/proxy.js';
import { blockNotice, type GateViolation, type ResponseGate } from './response-gate.js';
import { computeThreatScore } from '../detection/tier1/scorer.js';

export interface StreamingGateSummary {
  action: 'allow' | 'warn' | 'block';
  matches: PatternMatch[];
  violations: GateViolation[];
  threatScore: number;
}

const SEVERITY = { allow: 0, warn: 1, block: 2 } as const;
const SEVERITY_NAME = ['allow', 'warn', 'block'] as const;

/**
 * Per-SSE-event hook for the streaming response path. The pipe calls `process`
 * with each JSON `data:` payload and writes the returned payloads verbatim
 * (`data: <payload>\n\n`). Returning `[]` holds the event back.
 */
export interface StreamingGate {
  process(dataPayload: string): string[];
  /** Called on clean stream completion; returns any payloads held until the end. */
  flush(): string[];
  summary(): StreamingGateSummary;
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

interface HeldAnthropicBlock {
  index: number;
  payloads: string[];
  id?: string;
  name?: string;
  startInput: unknown;
  jsonFragments: string[];
}

function buildHeldCall(held: HeldAnthropicBlock): ToolCall {
  const concatenated = held.jsonFragments.join('');
  let args: unknown = held.startInput;
  if (concatenated.length > 0) {
    try {
      args = JSON.parse(concatenated);
    } catch {
      // Fall back to the start input when fragments do not concatenate to JSON.
    }
  }
  return { id: held.id, name: held.name ?? 'unknown', arguments: args };
}

function textBlockPayloads(index: number, text: string): string[] {
  return [
    JSON.stringify({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
    JSON.stringify({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } }),
    JSON.stringify({ type: 'content_block_stop', index }),
  ];
}

function stopPayload(index: number): string {
  return JSON.stringify({ type: 'content_block_stop', index });
}

class AnthropicStreamingGate implements StreamingGate {
  private held = new Map<number, HeldAnthropicBlock>();
  private matches: PatternMatch[] = [];
  private violations: GateViolation[] = [];
  private worstSeverity = 0;
  private sawEnd = false;
  private endPayload: string | null = null;

  constructor(private responseGate: ResponseGate) {}

  process(dataPayload: string): string[] {
    const event = parseJson(dataPayload);
    if (!event || typeof event !== 'object') return [dataPayload];
    const e = event as Record<string, unknown>;
    const index = typeof e.index === 'number' ? e.index : 0;

    if (e.type === 'message_stop') {
      // Hold the end marker until flush: any blocks still held at the end of the
      // stream must be resolved (and terminated) BEFORE the client sees message_stop.
      this.sawEnd = true;
      this.endPayload = dataPayload;
      return [];
    }

    if (e.type === 'content_block_start') {
      const block = e.content_block as Record<string, unknown> | undefined;
      if (block?.type === 'tool_use') {
        this.held.set(index, {
          index,
          payloads: [dataPayload],
          id: typeof block.id === 'string' ? block.id : undefined,
          name: typeof block.name === 'string' ? block.name : undefined,
          startInput: block.input,
          jsonFragments: [],
        });
        return [];
      }
      return [dataPayload];
    }

    if (e.type === 'input_json_delta') {
      const held = this.held.get(index);
      if (held) {
        held.payloads.push(dataPayload);
        if (typeof e.partial_json === 'string') held.jsonFragments.push(e.partial_json);
        return [];
      }
      return [dataPayload];
    }

    if (e.type === 'content_block_stop') {
      const held = this.held.get(index);
      if (!held) return [dataPayload];
      held.payloads.push(dataPayload);
      this.held.delete(index);
      return this.resolveBlock(held);
    }

    return [dataPayload];
  }

  private resolveBlock(held: HeldAnthropicBlock, withStop = false): string[] {
    const call = buildHeldCall(held);
    const evaluation = this.responseGate.evaluateCalls([call]);
    if (evaluation.action === 'allow') {
      // The real content_block_stop is already in held.payloads when the block
      // completed normally; `withStop` synthesizes one for truncated streams.
      return withStop ? [...held.payloads, stopPayload(held.index)] : held.payloads;
    }

    this.record(evaluation);
    if (evaluation.action === 'block') {
      // Replace the tool_use block with a text notice at the same index.
      return textBlockPayloads(held.index, blockNotice(evaluation.blockedCalls));
    }
    // warn: log-only, the block still flows through.
    return withStop ? [...held.payloads, stopPayload(held.index)] : held.payloads;
  }

  private record(evaluation: ReturnType<ResponseGate['evaluateCalls']>): void {
    this.matches.push(...evaluation.matches);
    this.violations.push(
      ...evaluation.blockedCalls.map(({ call, capabilities }) => ({ tool: call.name, capabilities })),
    );
    this.worstSeverity = Math.max(this.worstSeverity, SEVERITY[evaluation.action]);
  }

  flush(): string[] {
    const emitted: string[] = [];
    for (const held of [...this.held.values()]) {
      this.held.delete(held.index);
      emitted.push(...this.resolveBlock(held, true));
    }
    if (this.sawEnd && this.endPayload) emitted.push(this.endPayload);
    return emitted;
  }

  summary(): StreamingGateSummary {
    return {
      action: SEVERITY_NAME[this.worstSeverity],
      matches: this.matches,
      violations: this.violations,
      threatScore: computeThreatScore(this.matches).overall,
    };
  }
}

interface HeldOpenAICall {
  id?: string;
  name?: string;
  argsFragments: string[];
}

class OpenAIStreamingGate implements StreamingGate {
  /** Raw payloads containing tool_call deltas, in arrival order. */
  private chunks: string[] = [];
  private byIndex = new Map<number, HeldOpenAICall>();
  private matches: PatternMatch[] = [];
  private violations: GateViolation[] = [];
  private worstSeverity = 0;
  private sawEnd = false;

  constructor(private responseGate: ResponseGate) {}

  process(dataPayload: string): string[] {
    if (dataPayload === '[DONE]') {
      // Hold the end marker until flush so held calls are emitted BEFORE it.
      this.sawEnd = true;
      return [];
    }

    const event = parseJson(dataPayload);
    if (!event || typeof event !== 'object') return [dataPayload];
    const choices = (event as Record<string, unknown>).choices;
    if (!Array.isArray(choices) || choices.length === 0) return [dataPayload];

    const choice = choices[0] as Record<string, unknown> | undefined;
    if (!choice || typeof choice !== 'object') return [dataPayload];
    const delta = choice.delta as Record<string, unknown> | undefined;
    const toolCalls = delta?.tool_calls;

    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      // Hold the entire chunk: tool-call fragments are withheld until finish_reason.
      this.chunks.push(dataPayload);
      for (const tc of toolCalls) {
        if (!tc || typeof tc !== 'object') continue;
        const t = tc as Record<string, unknown>;
        const index = typeof t.index === 'number' ? t.index : 0;
        const fn = t.function as Record<string, unknown> | undefined;
        const held = this.byIndex.get(index) ?? { argsFragments: [] };
        if (typeof t.id === 'string') held.id = t.id;
        if (fn && typeof fn.name === 'string') held.name = fn.name;
        if (fn && typeof fn.arguments === 'string') held.argsFragments.push(fn.arguments);
        this.byIndex.set(index, held);
      }
      return [];
    }

    if (choice.finish_reason === 'tool_calls') {
      if (this.byIndex.size === 0 && this.chunks.length === 0) {
        // Everything was already resolved by an earlier finish chunk: pass through.
        return [dataPayload];
      }
      return this.resolveAll();
    }

    return [dataPayload];
  }

  private resolveAll(): string[] {
    const emitted: string[] = [];
    const blocked: Array<{ call: ToolCall; capabilities: string[] }> = [];
    let anyBlocked = false;

    for (const [index, held] of this.byIndex) {
      const argsText = held.argsFragments.join('');
      let args: unknown = argsText;
      if (argsText.length > 0) {
        try {
          args = JSON.parse(argsText);
        } catch {
          // Keep the raw concatenated string when fragments are not valid JSON.
        }
      }
      const call: ToolCall = { id: held.id, name: held.name ?? 'unknown', arguments: args };
      const evaluation = this.responseGate.evaluateCalls([call]);
      if (evaluation.action === 'allow') continue;
      anyBlocked = true;
      this.matches.push(...evaluation.matches);
      this.violations.push(
        ...evaluation.blockedCalls.map(({ call: c, capabilities }) => ({ tool: c.name, capabilities })),
      );
      this.worstSeverity = Math.max(this.worstSeverity, SEVERITY[evaluation.action]);
      blocked.push(...evaluation.blockedCalls);
      this.byIndex.delete(index);
    }

    if (anyBlocked) {
      // Replacing the whole tool_calls section keeps the stream coherent: a fragment
      // stream cannot be partially stripped without rebuilding valid JSON per index.
      emitted.push(
        JSON.stringify({ choices: [{ index: 0, delta: { content: blockNotice(blocked) } }] }),
      );
      emitted.push(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    } else {
      emitted.push(...this.chunks);
      emitted.push(JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
    }
    this.chunks = [];
    this.byIndex.clear();
    return emitted;
  }

  flush(): string[] {
    const emitted: string[] = [];
    if (this.byIndex.size > 0 || this.chunks.length > 0) {
      // Clean end without an explicit finish_reason: resolve held calls now.
      emitted.push(...this.resolveAll());
    }
    if (this.sawEnd) emitted.push('[DONE]');
    return emitted;
  }

  summary(): StreamingGateSummary {
    return {
      action: SEVERITY_NAME[this.worstSeverity],
      matches: this.matches,
      violations: this.violations,
      threatScore: computeThreatScore(this.matches).overall,
    };
  }
}

/** Build the per-request streaming gate, or null when the provider is unsupported. */
export function createStreamingGate(
  provider: LLMProvider,
  responseGate: ResponseGate,
): StreamingGate | null {
  if (provider instanceof AnthropicProvider) return new AnthropicStreamingGate(responseGate);
  if (provider instanceof OpenAIProvider) return new OpenAIStreamingGate(responseGate);
  return null;
}
