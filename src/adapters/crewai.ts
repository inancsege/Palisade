import { PalisadeAdapter, type AdapterMessage } from './core.js';
import { PalisadeBlockedError } from './vercel.js';
import type { BlockedResponse } from '../types/proxy.js';

/**
 * CrewAI `Crew.kickoff()` input shape. CrewAI kickoffs take a `dict` of named
 * fields (e.g. `task`, `goal`, `topic`); values may nest ad-hoc structures that
 * feed agent prompts. Any string leaf is a potential injection carrier. The
 * wrapper scans every string before the crew runs.
 */
export interface CrewKickoffInput {
  task_description?: unknown;
  [key: string]: unknown;
}

/** Duck-typed subset of a CrewAI `Crew` — just what the wrapper needs. */
export interface CrewAILike {
  kickoff: (inputs: CrewKickoffInput) => Promise<unknown>;
}

/**
 * Walk nested structures and collect every string leaf as an `AdapterMessage`.
 * Reuses the core extractor so scan sources stay consistent with all adapters.
 */
function collectStrings(inputs: unknown): AdapterMessage[] {
  const leaves: Array<{ path: string; value: string }> = [];
  walk(inputs, 'kickoff', leaves);
  return leaves.map((leaf) => ({ role: 'user', content: leaf.value }));
}

function walk(value: unknown, path: string, out: Array<{ path: string; value: string }>): void {
  if (typeof value === 'string') {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([key, child]) =>
      walk(child, `${path}.${key}`, out),
    );
  }
}

/**
 * Guard every string in a CrewAI kickoff input before it reaches the crew. On a
 * block verdict throws `PalisadeBlockedError` — the crew MUST NOT run. When the
 * canary is enabled, the token is appended to the `task_description` field (a
 * common CrewAI input) so exfiltration is detectable for any downstream agent.
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
  if (scan.blocked) {
    throw new PalisadeBlockedError(scan.blockedBody as unknown as BlockedResponse);
  }

  const token = adapter.canaryToken();
  if (token && typeof inputs.task_description === 'string') {
    return { ...inputs, task_description: `${inputs.task_description}\n\n${token}` };
  }
  return { ...inputs };
}

/**
 * Return a CrewAI-compatible object that intercepts `kickoff()`: inputs are
 * guarded before the wrapped crew runs, and the canary token is appended to the
 * task description. Other properties CrewAI reads off the crew are preserved.
 */
export function wrapCrewAI(crew: CrewAILike, adapter: PalisadeAdapter): CrewAILike {
  const wrapped: CrewAILike & Record<string, unknown> = {
    ...(crew as unknown as Record<string, unknown>),

    async kickoff(inputs: CrewKickoffInput): Promise<unknown> {
      const guarded = await guardCrewAIKickoff(inputs, adapter);
      return (crew as CrewAILike).kickoff(guarded);
    },
  };
  return wrapped;
}