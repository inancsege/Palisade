import { z } from 'zod';
import type { ProxyConfig } from '../types/proxy.js';

const proxyConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(8340),
  upstream: z.string().url().default('https://api.anthropic.com'),
  host: z.string().default('127.0.0.1'),
  policyPath: z.string().optional(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  dbPath: z.string().default('./palisade.db'),
  maxBodySize: z.coerce.number().int().min(1024).default(10 * 1024 * 1024), // 10MB
  timeout: z.coerce.number().min(1).max(3600).default(300), // seconds
  // `--dashboard` is a commander boolean flag; the env form PALISADE_DASHBOARD may
  // arrive as a string ('1'/'true'), so coerce both to a real boolean.
  dashboard: z
    .union([z.boolean(), z.enum(['true', '1']), z.enum(['false', '0'])])
    .transform((v) => v === true || v === '1' || v === 'true')
    .default(false),
});

export function resolveProxyConfig(
  cliOptions: Record<string, unknown>,
): ProxyConfig {
  const merged = {
    port: cliOptions.port ?? process.env.PALISADE_PORT,
    upstream: cliOptions.upstream ?? process.env.PALISADE_UPSTREAM,
    host: cliOptions.host ?? process.env.PALISADE_HOST,
    policyPath: cliOptions.policy ?? process.env.PALISADE_POLICY,
    logLevel: cliOptions.logLevel ?? process.env.PALISADE_LOG_LEVEL,
    dbPath: cliOptions.db ?? process.env.PALISADE_DB,
    maxBodySize: cliOptions.maxBodySize ?? process.env.PALISADE_MAX_BODY_SIZE,
    timeout: cliOptions.timeout ?? process.env.PALISADE_TIMEOUT,
    dashboard: cliOptions.dashboard ?? process.env.PALISADE_DASHBOARD,
  };

  return proxyConfigSchema.parse(merged);
}
