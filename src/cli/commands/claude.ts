import { Command } from 'commander';
import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:net';
import { PalisadeProxy } from '../../proxy/server.js';
import { loadPolicy } from '../../policy/loader.js';
import { defaultPolicy } from '../../policy/defaults.js';
import { createLogger } from '../../utils/logger.js';
import { printClaudeBanner } from '../output.js';
import chalk from 'chalk';

function findClaudeBinary(customPath?: string): string | null {
  if (customPath) return customPath;

  try {
    const result = execSync(
      process.platform === 'win32' ? 'where claude' : 'which claude',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const path = result.trim().split('\n')[0].trim();
    if (path) return path;
  } catch {
    // Not found via which/where
  }

  return null;
}

function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

export const claudeCommand = new Command('claude')
  .description('Launch Claude Code CLI with Palisade injection protection')
  .option('--policy <path>', 'Path to policy.yaml file')
  .option('--log-level <level>', 'Palisade log level (debug|info|warn|error)', 'warn')
  .option('--db <path>', 'SQLite database path', './palisade.db')
  .option('--claude-path <path>', 'Path to claude binary')
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(async (options, command) => {
    // 1. Find claude binary
    const claudePath = findClaudeBinary(options.claudePath);
    if (!claudePath) {
      console.error(chalk.red('\n  Claude Code CLI not found.'));
      console.error(chalk.gray('  Install it from https://claude.ai/download'));
      console.error(chalk.gray('  Or specify the path: palisade claude --claude-path /path/to/claude\n'));
      process.exit(1);
    }

    // 2. Pick a random port
    let port: number;
    try {
      port = await getRandomPort();
    } catch {
      console.error(chalk.red('  Failed to find an available port.'));
      process.exit(1);
    }

    // 3. Load policy
    const log = createLogger(options.logLevel);
    let policy = defaultPolicy;
    if (options.policy) {
      try {
        policy = loadPolicy(options.policy);
        log.info({ path: options.policy }, 'Policy loaded');
      } catch (err) {
        console.error(chalk.red(`  Failed to load policy: ${(err as Error).message}`));
        process.exit(1);
      }
    }

    // 4. Start proxy
    const proxy = new PalisadeProxy(
      {
        port,
        host: '127.0.0.1',
        upstream: 'https://api.anthropic.com',
        logLevel: options.logLevel,
        dbPath: options.db,
        maxBodySize: 10 * 1024 * 1024,
        timeout: 300,
        policyPath: options.policy,
      },
      policy,
    );

    try {
      await proxy.start();
    } catch (err) {
      console.error(chalk.red(`  Failed to start Palisade proxy: ${(err as Error).message}`));
      process.exit(1);
    }

    // 5. Print banner
    printClaudeBanner(port);

    // 6. Collect extra args to pass through to claude
    const extraArgs = command.args.slice();

    // 7. Spawn claude with ANTHROPIC_BASE_URL pointing to our proxy
    const child = spawn(claudePath, extraArgs, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      },
      shell: process.platform === 'win32',
    });

    // 8. Cleanup on exit
    const cleanup = async (exitCode: number) => {
      await proxy.stop();
      process.exit(exitCode);
    };

    child.on('exit', (code) => {
      cleanup(code ?? 0);
    });

    child.on('error', (err) => {
      console.error(chalk.red(`\n  Failed to launch Claude: ${err.message}`));
      cleanup(1);
    });

    // Forward signals to child
    const forwardSignal = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };

    process.on('SIGINT', () => forwardSignal('SIGINT'));
    process.on('SIGTERM', () => forwardSignal('SIGTERM'));
  });
