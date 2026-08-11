/**
 * OpenClaw integration preset (T6-05).
 *
 * OpenClaw proxies every LLM interaction through a per-connection gateway but offers no
 * pre-LLM message hook for injecting prompt-injection guards. The Palisade strategy is
 * therefore *gateway routing*: point an OpenClaw model provider at the running Palisade
 * proxy (`palisade serve`). The proxy scans, injects the canary and forwards upstream, so
 * OpenClaw agents get protection without plugin hooks.
 *
 * This module builds that provider entry in the shape OpenClaw actually reads: an optional
 * JSON5 config at `~/.openclaw/openclaw.json` (override with `OPENCLAW_CONFIG_PATH`), with
 * providers nested under `models.providers.<id>` using camelCase keys and an `api`
 * discriminator. See https://docs.openclaw.ai/gateway/configuration and
 * https://docs.openclaw.ai/concepts/model-providers.
 */

/** Which upstream wire protocol the Palisade proxy is forwarding to. */
export type OpenClawUpstream = 'openai' | 'anthropic';

/** OpenClaw's `api` discriminator for a provider entry. */
export type OpenClawApi = 'openai-completions' | 'anthropic-messages';

export interface OpenClawPresetOptions {
  /** Upstream wire protocol behind the proxy. */
  upstream: OpenClawUpstream;
  /** Palisade proxy host (paired with `proxyPort`). Defaults to `127.0.0.1`. */
  proxyHost?: string;
  /** Palisade proxy port (paired with `proxyHost`). Defaults to `8340`. */
  proxyPort?: number;
  /** Full proxy origin, e.g. `http://localhost:8340` — overrides host/port. */
  baseUrl?: string;
  /** Upstream model id OpenClaw should request. */
  model?: string;
  /** Display name for the model entry. Defaults to the model id. */
  modelName?: string;
  /** Pass-through API key for the upstream provider. Supports `${ENV_VAR}` form. */
  apiKey?: string;
}

export interface OpenClawModelEntry {
  id: string;
  name: string;
}

export interface OpenClawProviderEntry {
  baseUrl: string;
  apiKey: string;
  api: OpenClawApi;
  models: OpenClawModelEntry[];
}

export interface OpenClawConfig {
  agents: { defaults: { model: { primary: string } } };
  models: { providers: Record<string, OpenClawProviderEntry> };
}

/** The JSON5 config file OpenClaw reads (override with `OPENCLAW_CONFIG_PATH`). */
export const OPENCLAW_CONFIG_PATH = '~/.openclaw/openclaw.json';

/** The provider id Palisade registers itself under. */
export const OPENCLAW_PROVIDER_ID = 'palisade';

const DEFAULT_OPENAI_MODEL = 'gpt-4o';
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4';

/** Trim trailing slashes without a backtracking regex (redos/no-vulnerable). */
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return value.slice(0, end);
}

/** Resolve the proxy origin from explicit parts or a full baseUrl. */
function resolveOrigin(options: OpenClawPresetOptions): string {
  const base = options.baseUrl === undefined ? undefined : stripTrailingSlashes(options.baseUrl);
  if (base) return base;
  return `http://${options.proxyHost ?? '127.0.0.1'}:${options.proxyPort ?? 8340}`;
}

/**
 * Build the `models.providers.palisade` entry pointing OpenClaw at the Palisade proxy.
 * OpenAI-compatible upstreams expect the `/v1` suffix; the Anthropic messages API is
 * addressed at the bare origin.
 */
export function buildOpenClawProvider(options: OpenClawPresetOptions): OpenClawProviderEntry {
  const origin = resolveOrigin(options);
  const anthropic = options.upstream === 'anthropic';
  const model = options.model ?? (anthropic ? DEFAULT_ANTHROPIC_MODEL : DEFAULT_OPENAI_MODEL);

  return {
    baseUrl: anthropic ? origin : `${origin}/v1`,
    apiKey: options.apiKey ?? 'sk-palisade-proxy',
    api: anthropic ? 'anthropic-messages' : 'openai-completions',
    models: [{ id: model, name: options.modelName ?? model }],
  };
}

/**
 * Build the config fragment to merge into `~/.openclaw/openclaw.json`: the Palisade
 * provider plus the `provider/model` default-model selection that routes agents through it.
 */
export function buildOpenClawConfig(options: OpenClawPresetOptions): OpenClawConfig {
  const provider = buildOpenClawProvider(options);
  const modelId = provider.models[0].id;

  return {
    agents: { defaults: { model: { primary: `${OPENCLAW_PROVIDER_ID}/${modelId}` } } },
    models: { providers: { [OPENCLAW_PROVIDER_ID]: provider } },
  };
}

/**
 * Render the config fragment as JSON, ready to merge into `~/.openclaw/openclaw.json`.
 * OpenClaw parses JSON5, which is a superset of JSON, so plain JSON is always valid there.
 */
export function openclawConfigJson(options: OpenClawPresetOptions): string {
  return JSON.stringify(buildOpenClawConfig(options), null, 2);
}
