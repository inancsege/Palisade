/**
 * OpenClaw integration preset (T6-05).
 *
 * OpenClaw proxies every LLM interaction through a per-connection gateway, but
 * offers no pre-LLM message-hook for injecting prompt-injection guards. The
 * Palisade OpenClaw strategy is therefore *gateway routing*: point OpenClaw's
 * model connection at the running Palisade proxy (`palisade serve`). The proxy
 * forwards upstream after scanning, so OpenClaw crews get detection and canary
 * protection without plugin hooks.
 *
 * This module builds the OpenClaw connection config object and a ready-to-paste
 * `connections.yaml` fragment. OpenClaw reads the proxy as a drop-in substitute
 * for the real provider because the proxy forwards every path upstream.
 */

export type OpenClawProvider = 'openai' | 'anthropic';

export interface OpenClawPresetOptions {
  provider: OpenClawProvider;
  /** Palisade proxy origin host (paired with `proxyPort`). */
  proxyHost?: string;
  /** Palisade proxy origin port (paired with `proxyHost`). */
  proxyPort?: number;
  /** Full Palisade proxy origin, e.g. `http://localhost:8340` (overrides host/port). */
  baseUrl?: string;
  /** Upstream model id OpenClaw should request. */
  model?: string;
  /** Pass-through API key for the upstream provider. */
  apiKey?: string;
}

export interface OpenClawPreset {
  provider_id: string;
  base_url: string;
  model: string;
  api_key: string;
}

const DEFAULT_OPENAI_MODEL = 'gpt-4o';
const PATH_OPENAI = '/v1';
const PATH_ANTHROPIC = '';

/** Resolve the proxy origin from explicit parts or the full baseUrl. */
function resolveOrigin(options: OpenClawPresetOptions): string {
  const base = options.baseUrl?.replace(/\/$/, '');
  if (base) return base;
  const port = options.proxyPort ?? 8340;
  return `http://${options.proxyHost ?? '127.0.0.1'}:${port}`;
}

function apiKeyOrPlaceholder(apiKey?: string): string {
  return apiKey ?? 'sk-palisade-proxy';
}

/**
 * Build an OpenClaw connection preset. The result is shaped like an OpenClaw
 * `connections` entry: `provider_id`, `base_url`, `model`, `api_key`. Routing
 * through Palisade, OpenClaw's requests first hit `palisade serve`, which scans
 * for injection and injects/validates the canary token before forwarding.
 */
export function buildOpenClawPreset(options: OpenClawPresetOptions): OpenClawPreset {
  const origin = resolveOrigin(options);
  if (options.provider === 'anthropic') {
    return {
      provider_id: 'anthropic',
      base_url: `${origin}${PATH_ANTHROPIC}`,
      model: options.model ?? 'claude-sonnet-4',
      api_key: apiKeyOrPlaceholder(options.apiKey),
    };
  }
  return {
    provider_id: 'openai_compatible',
    base_url: `${origin}${PATH_OPENAI}`,
    model: options.model ?? DEFAULT_OPENAI_MODEL,
    api_key: apiKeyOrPlaceholder(options.apiKey),
  };
}

/**
 * Render a minimal OpenClaw `connections.yaml` fragment. Drop it under the
 * `connections:` key in `~/.openclaw/connections.yaml` (or a project config).
 */
export function openclawYaml(options: OpenClawPresetOptions): string {
  const preset = buildOpenClawPreset(options);
  return [
    '  palisade_proxy:',
    `    provider_id: ${preset.provider_id}`,
    `    base_url: ${preset.base_url}`,
    `    api_key: ${preset.api_key}`,
    `    model: ${preset.model}`,
    '    # Palisade routes this connection through palisade serve (prompt-injection scan + canary).',
  ].join('\n');
}