import { Command } from 'commander';
import chalk from 'chalk';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  resolveUrl,
  modelDirFor,
  isInstalled,
  verifyHash,
  MODEL_REPO,
  MODEL_SHA,
  MODEL_FILES,
} from '../../detection/tier2/model-cache.js';

/** Per-file download timeout (ms). The ONNX weights are ~700MB, so allow a generous window. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Download one repo file, sha256-verify it against its pin, and write it under the model dir.
 * Returns nothing on success; throws on a network error or a hash mismatch so the caller can clean
 * up the partial install. The pure tamper check (`verifyHash`) is unit-tested in model-cache; this
 * shell only does the I/O plumbing (fetch + writeFileSync).
 */
async function fetchVerifyWrite(
  file: { path: string; source: string; sha256: string },
  modelDir: string,
  token: string | undefined,
): Promise<void> {
  const url = resolveUrl(file.source);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${file.source}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  // The ONLY integrity gate (BLOCKER 3 / ASVS V6): a tampered or truncated download fails here.
  if (!verifyHash(buf, file.sha256)) {
    throw new Error(`sha256 mismatch for ${file.path} (expected ${file.sha256})`);
  }

  const dest = join(modelDir, file.path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
}

const installCommand = new Command('install')
  .description('Download + sha256-verify + cache the Tier 2 model into the local cache dir')
  .option('--force', 'Re-download even if the model is already installed')
  .option('--models-dir <path>', 'Override the cache root (sets PALISADE_MODELS_DIR for this run)')
  .action(async (options) => {
    if (options.modelsDir) {
      process.env.PALISADE_MODELS_DIR = options.modelsDir;
    }

    if (isInstalled(MODEL_SHA) && !options.force) {
      console.log(
        chalk.green('  Tier 2 model already installed at ') +
          chalk.bold(modelDirFor(MODEL_SHA)) +
          chalk.gray('  (use --force to re-download)'),
      );
      process.exit(0);
    }

    const modelDir = modelDirFor(MODEL_SHA);
    const token = process.env.HF_TOKEN;

    console.log(
      chalk.bold.cyan('\n  Installing Tier 2 model\n') +
        chalk.gray(`  ${MODEL_REPO} @ ${MODEL_SHA}\n`) +
        chalk.gray(`  -> ${modelDir}\n`),
    );

    mkdirSync(modelDir, { recursive: true });

    let index = 0;
    for (const file of MODEL_FILES) {
      index += 1;
      process.stdout.write(
        chalk.gray(`  [${index}/${MODEL_FILES.length}] `) +
          chalk.white(file.path) +
          chalk.gray(' ... '),
      );
      try {
        await fetchVerifyWrite(file, modelDir, token);
        console.log(chalk.green('verified'));
      } catch (err) {
        console.log(chalk.red('FAILED'));
        console.error(chalk.red(`  ${(err as Error).message}`));
        // Delete the partial install so a re-run starts clean and `serve` keeps fast-failing.
        rmSync(modelDir, { recursive: true, force: true });
        console.error(chalk.red('  Removed the partial install. Tier 2 model NOT installed.'));
        process.exit(1);
      }
    }

    console.log(
      chalk.green('\n  Tier 2 model installed at ') + chalk.bold(modelDir) + '\n',
    );
    process.exit(0);
  });

export const tier2Command = new Command('tier2')
  .description('Manage the Tier 2 (local ML classifier) model')
  .addCommand(installCommand);
