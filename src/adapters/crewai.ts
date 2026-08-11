import type { BlockedResponse } from '../types/proxy.js';
import { PalisadeAdapter, type AdapterMessage } from './core.js';
import { PalisadeBlockedError } from './vercel.js';

/**
 * CrewAI integration (T6-04).
 *
 * CrewAI proper is a **Python** framework — there is no official JavaScript SDK — so the
 * supported integration is gateway routing: point CrewAI's LLM at a running Palisade proxy
 * (`palisade serve`) and every agent turn is scanned, canary-injected and forwarded. That
 * is what `buildCrewAIEnv` / `crewAILlmSnippet` configure.
 *
 * `guardCrewAIKickoff` / `wrapCrewAI` are a secondary, JS-only path for the unofficial
 * TypeScript ports (crewai-ts and friends). They guard a `kickoff(inputs)` call in-process.
 * They cannot wrap a Python crew.
 */

export type CrewAIUpstream = 'openai' | 'anthropic';

export interface CrewAIRoutingOptions {
  /** Upstream wire protocol behind the proxy. */
  upstream: CrewAIUpstream;
  /** Palisade proxy host (paired with `proxyPort`). Defaults to `127.0.0.1`. */
  proxyHost?: string;
  /** Palisade proxy port (paired with `proxyHost`). Defaults to `8340`. */
  proxyPort?: number;
  /** Full proxy origin, e.g. `http://localhost:8340` — overrides host/port. */
  baseUrl?: string;
  /** Model id CrewAI should request. */
  model?: string;
  /** Pass-through API key for the upstream provider. */
  apiKey?: string;
}

/** The environment CrewAI (via LiteLLM) reads to reach a custom endpoint. */
export interface CrewAIEnv {
  OPENAI_BASE_URL?: string;
  OPENAI_API_BASE?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_API_BASE?: string;
  ANTHROPIC_API_KEY?: string;
}

/** Trim trailing slashes without a backtracking regex (redos/no-vulnerable). */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return value.slice(0, end);
}

function resolveOrigin(options: CrewAIRoutingOptions): string {
  const base = options.baseUrl === undefined ? undefined : stripTrailingSlashes(options.baseUrl);
  if (base) return base;
  return `http://${options.proxyHost ?? '127.0.0.1'}:${options.proxyPort ?? 8340}`;
}

function routedUrl(options: CrewAIRoutingOptions): string {
  const origin = resolveOrigin(options);
  return options.upstream === 'anthropic' ? origin : `${origin}/v1`;
}

/**
 * Build the environment that routes CrewAI through the Palisade proxy.
 *
 * Both `*_BASE_URL` and `*_API_BASE` are set on purpose: CrewAI 1.12.x does not map
 * `base_url` onto LiteLLM's `api_base`, so setting only one silently leaves traffic on the
 * real provider. See https://github.com/crewAIInc/crewAI/issues/5139.
 */
export function buildCrewAIEnv(options: CrewAIRoutingOptions): CrewAIEnv {
  const url = routedUrl(options);
  const key = options.apiKey ?? 'sk-palisade-proxy';

  if (options.upstream === 'anthropic') {
    return { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_BASE: url, ANTHROPIC_API_KEY: key };
  }
  return { OPENAI_BASE_URL: url, OPENAI_API_BASE: url, OPENAI_API_KEY: key };
}

/**
 * Render the Python `LLM(...)` construction that routes a CrewAI agent through Palisade,
 * for users who configure the model in code rather than by environment.
 */
export function crewAILlmSnippet(options: CrewAIRoutingOptions): string {
  const url = routedUrl(options);
  const model = options.model ?? (options.upstream === 'anthropic' ? 'claude-sonnet-4' : 'gpt-4o');
  const key = options.apiKey ?? 'sk-palisade-proxy';

  return [
    'from crewai import LLM',
    '',
    '# Routed through `palisade serve` — every turn is scanned before it reaches the provider.',
    'llm = LLM(',
    `    model="${model}",`,
    '    custom_openai=True,',
    `    base_url="${url}",`,
    `    api_base="${url}",  # CrewAI 1.12.x does not map base_url -> api_base (crewAI#5139)`,
    `    api_key="${key}",`,
    ')',
  ].join('\n');
}

/**
 * CrewAI `kickoff()` input shape: a dict of named fields whose string leaves feed agent
 * prompts. Any string leaf is a potential injection carrier.
 */
export interface CrewKickoffInput {
  task_description?: unknown;
  [key: string]: unknown;
}

/** Duck-typed subset of a CrewAI `Crew` — just what the wrapper needs. */
export interface CrewAILike {
  kickoff: (inputs: CrewKickoffInput) => Promise<unknown>;
}

/** Walk nested structures and collect every string leaf as a scannable message. */
function collectStrings(inputs: unknown): AdapterMessage[] {
  const leaves: string[] = [];
  walk(inputs, leaves);
  return leaves.map((value) => ({ role: 'user', content: value }));
}

function walk(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, out));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((child) => walk(child, out));
  }
}

/**
 * Guard every string in a CrewAI kickoff input before it reaches the crew. A block verdict
 * throws `PalisadeBlockedError` and the crew MUST NOT run. When the canary is enabled the
 * token is appended to `task_description` so exfiltration stays detectable downstream.
 */
export async function guardCrewAIKickoff(
  inputs: CrewKickoffInput,
  adapter: PalisadeAdapter,
): Promise<CrewKickoffInput> {
  const messages = collectStrings(inputs);
  const scan = await adapter.guard({
    messages: messages.length > 0 ? messages : [{ role: 'user', content: String(inputs) }],
    ctx: { requestPath: '/guard/crewai/kickoff' },
  });
  if (scan.blocked) throw new PalisadeBlockedError(scan.blockedBody as unknown as BlockedResponse);

  const token = adapter.canaryToken();
  if (token && typeof inputs.task_description === 'string') {
    return { ...inputs, task_description: `${inputs.task_description}\n\n${token}` };
  }
  return inputs;
}

/**
 * Wrap a JS CrewAI-port crew so `kickoff()` is guarded. A `Proxy` is used so the crew's
 * prototype methods and `instanceof` survive — a plain object spread would drop every
 * method the port defines on the class.
 */
export function wrapCrewAI<T extends CrewAILike>(crew: T, adapter: PalisadeAdapter): T {
  return new Proxy(crew, {
    get(target, prop, receiver) {
      if (prop === 'kickoff') {
        return async (inputs: CrewKickoffInput): Promise<unknown> => {
          const guarded = await guardCrewAIKickoff(inputs, adapter);
          return target.kickoff(guarded);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}
