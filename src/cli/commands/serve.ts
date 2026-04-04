import { Command } from 'commander';
import { PalisadeProxy, checkUnimplementedFeatures } from '../../proxy/server.js';
import { loadPolicy } from '../../policy/loader.js';
import { defaultPolicy } from '../../policy/defaults.js';
import { resolveProxyConfig } from '../../utils/config.js';
import { createLogger } from '../../utils/logger.js';
import { printBanner, printStartup, printFeatureWarnings } from '../output.js';

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
      log.error({ err }, 'Failed to start proxy');
      process.exit(1);
    }
  });
