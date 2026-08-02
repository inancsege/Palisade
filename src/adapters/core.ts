import { randomUUID } from 'node:crypto';
import type { PolicyConfig } from '../types/policy.js';
import type { DetectionResult, PatternMatch, VerdictAction } from '../types/verdict.js';
import type { ToolCall, BlockedResponse, ExtractedText } from '../types/proxy.js';
import type { EventLogger } from '../logging/events.js';
import { DetectionEngine } from '../detection/engine.js';
import { ResponseGate } from '../proxy/response-gate.js';
import { CanaryStore, injectCanaryToken } from '../proxy/canary.js';
import { OpenAIProvider } from '../proxy/providers/openai.js';

/**
 * Framework-neutral chat message. Framework adapters (Vercel AI SDK, LangGraph,
 * CrewAI, OpenClaw) normalize onto this shape: `role` plus `content`, which is a
 * string (mostly) or an array of typed parts (OpenAI `/v1/chat` parts galore).
 */
export interface AdapterMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string; [key: string]: unknown }>;
}

export interface GuardContext {
  requestId?: string;
  sourceIp?: string | null;
  requestPath?: string | null;
  skillId?: string | null;
  provider?: 'openai' | 'anthropic';
}

export interface GuardResult {
  action: VerdictAction;
  /** True → the caller must NOT send this request to the model. */
  blocked: boolean;
  matches: PatternMatch[];
  threatScore: number;
  requestId: string;
  /**
   * Messages to send, with the canary token injected into the system prompt
   * (when enabled). When `blocked` the model is never invoked and `body` is null.
   */
  body: AdapterMessage[] | null;
  blockedBody: BlockedResponse | null;
}

/**
 * Framework-agnostic adapter core (T6-01). Reuses the proxy-side `DetectionEngine`
 * (Tier 1/2 request scan), `ResponseGate` (Tier 3 tool-call gate) and `CanaryStore`
 * against a plain chat-message shape so the SDK-specific wrappers stay thin.
 *
 * Canary injection runs AFTER scanning so the token never trips the engine, and
 * the default `OpenAIProvider` message mutation mutates `body.messages` — both
 * matching proxy/server.ts behaviour.
 */
export class PalisadeAdapter {
  private engine: DetectionEngine;
  private responseGate: ResponseGate | null;
  private canaryStore: CanaryStore;
  private eventLogger: EventLogger | null;
  private policy: PolicyConfig;

  constructor(options: { policy: PolicyConfig; eventLogger?: EventLogger | null }) {
    this.policy = options.policy;
    this.engine = new DetectionEngine(options.policy.detection);
    this.responseGate = options.policy.detection.tier3.enabled
      ? new ResponseGate(options.policy)
      : null;
    this.canaryStore = new CanaryStore({
      enabled: options.policy.detection.canary.enabled,
      rotateIntervalSeconds: options.policy.detection.canary.rotate_interval,
    });
    this.eventLogger = options.eventLogger ?? null;
  }

  /** Release the detection engine's resources (safe pre-init). */
  async close(): Promise<void> {
    await this.engine.close();
  }

  /**
   * Scan a chat-message list and, when allowed, return a body mutated with the
   * canary token. The returned `body` may share object identity with `messages`
   * when the canary is disabled — callers that must not mutate their input
   * should pass their own copy.
   */
  async guard(options: { messages: AdapterMessage[]; ctx?: GuardContext; skillId?: string | null }): Promise<GuardResult> {
    const requestId = options.ctx?.requestId ?? randomUUID();
    const texts = extractTexts(options.messages);

    const result = await this.engine.detect(texts, requestId);

    this.log(result, options.ctx, options.skillId);

    if (result.action === 'block') {
      return {
        action: 'block',
        blocked: true,
        matches: result.matches,
        threatScore: result.threatScore.overall,
        requestId,
        body: null,
        blockedBody: {
          error: {
            type: 'prompt_injection_detected',
            message: `Palisade blocked this request: ${result.matches.length} injection pattern(s) detected (threat score ${result.threatScore.overall.toFixed(2)})`,
            verdict: 'block',
            threatScore: result.threatScore.overall,
            requestId,
          },
        },
      };
    }

    let body = options.messages;
    const token = this.canaryStore.currentToken();
    if (token) {
      const mutated = injectCanaryToken(
        { messages: options.messages },
        new OpenAIProvider(),
        token,
      );
      if (Array.isArray(mutated.messages)) {
        body = mutated.messages as AdapterMessage[];
      }
    }

    return {
      action: result.action,
      blocked: false,
      matches: result.matches,
      threatScore: result.threatScore.overall,
      requestId,
      body,
      blockedBody: null,
    };
  }

  /** Gate tool calls a model produced against the Tier 3 policy (allow/warn/block). */
  gateToolCalls(calls: ToolCall[]): ToolCallVerdict {
    if (!this.responseGate) {
      return { action: 'allow', violations: [], matches: [], egressHosts: [], blocked: false };
    }
    const evaluation = this.responseGate.evaluateCalls(calls as ToolCall[]);
    const action: 'allow' | 'warn' | 'block' =
      evaluation.action === 'block' && this.policy.detection.tier3.block_response
        ? 'block'
        : evaluation.action;
    return {
      action,
      violations: evaluation.blockedCalls.map(({ call, capabilities }) => ({
        tool: call.name,
        capabilities,
      })),
      blocked: evaluation.action === 'block',
      matches: evaluation.matches,
      egressHosts: evaluation.egressHosts,
    };
  }

  private log(result: DetectionResult, ctx?: GuardContext, skillId?: string | null): void {
    if (!this.eventLogger) return;
    this.eventLogger.logEvent({
      requestId: result.requestId,
      eventType: result.action === 'block' ? 'request_blocked'
        : result.action === 'warn' ? 'request_warned'
        : 'request_scanned',
      provider: ctx?.provider ?? null,
      actionTaken: result.action,
      threatScore: result.threatScore.overall,
      matches: result.matches,
      requestPath: ctx?.requestPath,
      sourceIp: ctx?.sourceIp,
      skillId: skillId ?? ctx?.skillId,
    });
  }
}

export interface ToolCallVerdict {
  action: 'allow' | 'warn' | 'block';
  violations: Array<{ tool: string; capabilities: string[] }>;
  matches: PatternMatch[];
  egressHosts: string[];
  blocked: boolean;
}

function extractTexts(messages: AdapterMessage[]): ExtractedText[] {
  const texts: ExtractedText[] = [];
  messages.forEach((msg, i) => {
    if (typeof msg.content === 'string') {
      texts.push({ source: `messages[${i}]`, role: msg.role, text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part.text === 'string') {
          texts.push({ source: `messages[${i}].content`, role: msg.role, text: part.text });
        }
      }
    }
  });
  return texts;
}