import { Command } from 'commander';
import chalk from 'chalk';
import { PalisadeProxy, checkUnimplementedFeatures } from '../../proxy/server.js';
import { loadPolicy } from '../../policy/loader.js';
import { defaultPolicy } from '../../policy/defaults.js';
import { resolveProxyConfig } from '../../utils/config.js';
import { createLogger } from '../../utils/logger.js';
import { printBanner, printStartup, printFeatureWarnings } from '../output.js';

/**
 * Map a thrown startup error to a structured operator-facing shape (T2-09). Returns a non-null
 * `{ type, message }` ONLY for errors carrying a known code that warrants a tailored remediation
 * (currently `tier2_model_missing`); other errors return null so the caller falls back to the
 * generic `log.error` + exit path. PURE (no I/O / no process control) so it is unit-testable
 * without spawning a process. The `tier2_model_missing` path surfaces the one-line
 * `palisade tier2 install` remediation that the fast-fail in `Tier2Engine.initialize()` raises.
 */
export function mapStartupError(err: unknown): { type: string; message: string } | null {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'tier2_model_missing') {
    return {
      type: 'tier2_model_missing',
      message:
        'Tier 2 is enabled but no model is installed. Run: palisade tier2 install',
    };
  }
  return null;
}

export const serveCommand = new Command('serve')
  .description('Start the Palisade proxy server')
  .option('-p, --port <number>', 'Port to listen on', '8340')
  .option('-u, --upstream <url>', 'Upstream LLM API URL', 'https://api.anthropic.com')
  .option('-H, --host <host>', 'Host to bind to', '127.0.0.1')
  .option('--policy <path>', 'Path to policy.yaml file')
  .option('--log-level <level>', 'Log level (debug|info|warn|error)', 'info')
  .option('--db <path>', 'Path to SQLite database file', './palisade.db')
  .option('--timeout <seconds>', 'Upstream request timeout in seconds', '300')
  .action(async (options) => {
    printBanner();

    const config = resolveProxyConfig(options);
    const log = createLogger(config.logLevel);

    let policy = defaultPolicy;
    if (config.policyPath) {
      try {
        policy = loadPolicy(config.policyPath);
        log.info({ path: config.policyPath }, 'Policy loaded');
      } catch (err) {
        log.error({ err }, 'Failed to load policy file');
        process.exit(1);
      }
    }

    const featureWarnings = checkUnimplementedFeatures(policy, log);

    const proxy = new PalisadeProxy(config, policy);

    // Graceful shutdown
    const shutdown = async () => {
      log.info('Shutting down...');
      await proxy.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
      await proxy.start();
      printStartup(config.port, config.host, config.upstream, config.policyPath);
      printFeatureWarnings(featureWarnings);
    } catch (err) {
      // T2-09: a tier2_model_missing fast-fail surfaces a structured error.type + a one-line
      // `palisade tier2 install` remediation and exits fast (within 2s, no network attempt —
      // initialize() throws before any socket opens). Other errors keep the generic path.
      const mapped = mapStartupError(err);
      if (mapped) {
        console.error(
          chalk.red('\n  Failed to start proxy: ') + chalk.bold(mapped.type),
        );
        console.error(chalk.yellow(`  ${mapped.message}\n`));
      } else {
        log.error({ err }, 'Failed to start proxy');
      }
      process.exit(1);
    }
  });
