import type { LLMProvider } from './providers/base.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import type { PolicyConfig } from '../types/policy.js';
import type { PatternMatch } from '../types/verdict.js';
import type { ToolCall } from '../types/proxy.js';
import { Tier3Engine, type BlockedCall, type Tier3Evaluation } from '../detection/tier3/index.js';
import { computeThreatScore } from '../detection/tier1/scorer.js';

export interface GateViolation {
  tool: string;
  capabilities: string[];
}

export interface GateResult {
  action: 'allow' | 'warn' | 'block';
  /** True → the proxy must return 403 and discard the response. */
  hardBlock: boolean;
  /** True → `body` is a rewritten copy of the response. */
  modified: boolean;
  body?: Record<string, unknown>;
  matches: PatternMatch[];
  threatScore: number;
  violations: GateViolation[];
}

/**
 * Response-side action gate (Tier 3). Runs after the upstream response is complete:
 *  - allow  → pass through untouched;
 *  - warn   → pass through with violation headers/events;
 *  - block  → either rewrite the violating tool calls out of the body
 *             (`block_response: false`, default) or hard-block the response
 *             (`block_response: true`, non-streaming only).
 */
export class ResponseGate {
  private engine: Tier3Engine;

  constructor(private policy: PolicyConfig) {
    this.engine = new Tier3Engine(policy);
  }

  gateNonStreaming(body: Record<string, unknown>, provider: LLMProvider): GateResult {
    const calls = provider.extractToolCalls(body);
    const evaluation = this.engine.evaluate(calls);

    if (!evaluation.consulted || evaluation.action === 'allow') {
      return {
        action: 'allow',
        hardBlock: false,
        modified: false,
        matches: evaluation.matches,
        threatScore: 0,
        violations: [],
      };
    }

    const violations: GateViolation[] = evaluation.blockedCalls.map(({ call, capabilities }) => ({
      tool: call.name,
      capabilities,
    }));
    const threatScore = computeThreatScore(evaluation.matches).overall;

    if (evaluation.action === 'warn') {
      return {
        action: 'warn',
        hardBlock: false,
        modified: false,
        matches: evaluation.matches,
        threatScore,
        violations,
      };
    }

    if (this.policy.detection.tier3.block_response) {
      return {
        action: 'block',
        hardBlock: true,
        modified: false,
        matches: evaluation.matches,
        threatScore,
        violations,
      };
    }

    return {
      action: 'block',
      hardBlock: false,
      modified: true,
      body: this.rewrite(body, provider, evaluation.blockedCalls),
      matches: evaluation.matches,
      threatScore,
      violations,
    };
  }

  /** Evaluate a batch of tool calls (used by the streaming gate per completed block). */
  evaluateCalls(calls: ToolCall[]): Tier3Evaluation {
    return this.engine.evaluate(calls);
  }

  private rewrite(
    body: Record<string, unknown>,
    provider: LLMProvider,
    blockedCalls: BlockedCall[],
  ): Record<string, unknown> {
    if (provider instanceof AnthropicProvider) return rewriteAnthropic(body, blockedCalls);
    if (provider instanceof OpenAIProvider) return rewriteOpenAI(body, blockedCalls);
    return body;
  }
}

export function blockNotice(blockedCalls: BlockedCall[]): string {
  return blockedCalls
    .map(
      ({ call, capabilities }) =>
        `Palisade blocked tool call '${call.name}' (${capabilities.join(', ')}) by policy`,
    )
    .join('; ');
}

function isBlockedAnthropicBlock(
  block: Record<string, unknown>,
  blockedCalls: BlockedCall[],
): boolean {
  if (block.type !== 'tool_use') return false;
  return blockedCalls.some(({ call }) => {
    if (call.id && call.id === block.id) return true;
    return call.name === block.name && JSON.stringify(call.arguments) === JSON.stringify(block.input);
  });
}

function rewriteAnthropic(
  body: Record<string, unknown>,
  blockedCalls: BlockedCall[],
): Record<string, unknown> {
  const content = Array.isArray(body.content) ? [...body.content] : [];
  const remaining = content.filter((block) => {
    if (!block || typeof block !== 'object' || !('type' in block)) return true;
    return !isBlockedAnthropicBlock(block as Record<string, unknown>, blockedCalls);
  });
  remaining.push({ type: 'text', text: blockNotice(blockedCalls) });
  return { ...body, content: remaining };
}

function isBlockedOpenAICall(
  toolCall: Record<string, unknown>,
  blockedCalls: BlockedCall[],
): boolean {
  const fn = toolCall.function as Record<string, unknown> | undefined;
  return blockedCalls.some(({ call }) => {
    if (call.id && call.id === toolCall.id) return true;
    if (!fn) return false;
    return call.name === fn.name && JSON.stringify(call.arguments) === fn.arguments;
  });
}

function rewriteOpenAI(
  body: Record<string, unknown>,
  blockedCalls: BlockedCall[],
): Record<string, unknown> {
  const choices = Array.isArray(body.choices) ? [...body.choices] : [];
  const newChoices = choices.map((choice) => {
    if (!choice || typeof choice !== 'object') return choice;
    const c = { ...(choice as Record<string, unknown>) };
    const message = c.message as Record<string, unknown> | undefined;
    if (!message) return c;

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const remaining = toolCalls.filter((tc) => {
      if (!tc || typeof tc !== 'object') return true;
      return !isBlockedOpenAICall(tc as Record<string, unknown>, blockedCalls);
    });

    if (remaining.length !== toolCalls.length) {
      c.message = {
        ...message,
        tool_calls: remaining,
        ...(remaining.length === 0 ? { content: blockNotice(blockedCalls) } : {}),
      };
    }
    return c;
  });
  return { ...body, choices: newChoices };
}
