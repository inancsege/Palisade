import { Command } from 'commander';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import chalk from 'chalk';
import { DetectionEngine } from '../../detection/engine.js';
import { defaultPolicy } from '../../policy/defaults.js';
import { printBanner } from '../output.js';
import { loadRegisteredCorpus, selectCorpora } from '../../bench/corpora.js';
import { PINNED_SEED, splitCorpus } from '../../bench/split.js';
import {
  blockRateOnBenign,
  falsePositiveRate,
  latencyColumns,
  paraphraseConsistency,
  perCategoryF1,
  trueNegativeRate,
} from '../../bench/metrics.js';
import {
  engineDetect,
  evaluateCorpus,
  policyForConfiguration,
  tier2FiringRate,
  tierDisagreementRate,
  requireModelFor,
  assertTier2NotDegraded,
  type TierConfiguration,
} from '../../bench/runner.js';
import { fromCsv, runSoak, toCsv, type SoakResult } from '../../bench/soak.js';
import {
  captureEnvironment,
  renderReport,
  type ConfigurationResult,
  type CorpusResult,
  type SoakSummary,
} from '../../bench/report.js';
import { MODEL_SHA, isInstalled, modelDirFor } from '../../detection/tier2/model-cache.js';
import type { DetectionResult } from '../../types/verdict.js';

const ALL_CONFIGURATIONS: TierConfiguration[] = ['tier1', 'tier1+2', 'tier1+2+3'];

export const benchmarkCommand = new Command('benchmark')
  .description('Run the pre-registered benchmark (docs/benchmark-protocol.md) over the corpora')
  .option('--corpora <ids>', 'Comma-separated subset of the registered corpora (C1,C2,C3,C4)')
  .option('--out <path>', 'Write the rendered report here', 'BENCHMARK.md')
  .option('--emit-env', 'Also write environment.json for the run (§7)', false)
  .option('--env-out <path>', 'Path for the environment file', 'environment.json')
  .option(
    '--configurations <list>',
    'Comma-separated subset of tier1,tier1+2,tier1+2+3',
    ALL_CONFIGURATIONS.join(','),
  )
  .option('--soak <minutes>', 'Also run the §5 soak test for N minutes (protocol: 60)', '0')
  .option(
    '--soak-csv <path>',
    'Re-derive the soak row from a committed RSS series instead of measuring a new one',
  )
  .option('--soak-rate <n>', 'Soak request rate per second (protocol: 10)', '10')
  .option('--soak-out <dir>', 'Directory for the soak RSS series', 'bench/results/soak')
  .option('--seed <n>', 'Override the pinned RNG seed (invalidates published numbers)', String(PINNED_SEED))
  .action(async (options) => {
    printBanner();

    const seed = Number(options.seed);
    const descriptors = selectCorpora(options.corpora as string | undefined);

    const requested = String(options.configurations)
      .split(',')
      .map((c) => c.trim())
      .filter((c): c is TierConfiguration => (ALL_CONFIGURATIONS as string[]).includes(c));

    // Resolve the installed Tier 2 model up front and refuse any Tier 2 configuration
    // without it — a silently no-opping Tier 2 would publish an invented row.
    const modelPath = isInstalled(MODEL_SHA) ? modelDirFor(MODEL_SHA) : null;
    for (const configuration of requested) requireModelFor(configuration, modelPath);
    console.log(chalk.dim(`tier 2 model: ${modelPath ?? 'not installed (tier1-only run)'}`));

    const corpora: CorpusResult[] = [];
    for (const descriptor of descriptors) {
      const corpus = loadRegisteredCorpus(descriptor);

      // §4: only the EVAL split is ever scored. The calibration split exists to fit the
      // Tier 2 threshold and is deliberately never read here.
      const { evaluation } = splitCorpus(corpus.entries, seed);
      console.log(
        chalk.dim(
          `corpus ${corpus.id} · ${corpus.entries.length} entries · eval split ${evaluation.length} · ` +
            `train_overlap ${corpus.trainOverlap}`,
        ),
      );

      const results: ConfigurationResult[] = [];
      for (const configuration of requested) {
        process.stdout.write(chalk.dim(`  ${corpus.id} ${configuration} ... `));
        const engine = new DetectionEngine(
          policyForConfiguration(defaultPolicy.detection, configuration, modelPath),
        );

        // Loads + warms the Tier 2 pipeline. Without this the classifier is null and every
        // scan degrades to a zero result behind a warn log.
        await engine.initialize();

        const rawResults: DetectionResult[] = [];
        const detect = engineDetect(engine);
        const predictions = await evaluateCorpus(evaluation, async (text, i) => {
          const result = await detect(text, i);
          rawResults.push(result);
          return result;
        });
        await engine.close();
        assertTier2NotDegraded(configuration, rawResults);

        results.push({
          configuration,
          categories: perCategoryF1(predictions),
          falsePositiveRate: falsePositiveRate(predictions),
          blockRateOnBenign: blockRateOnBenign(predictions),
          trueNegativeRate: trueNegativeRate(predictions),
          paraphraseConsistency: paraphraseConsistency(predictions),
          latency: latencyColumns(predictions.map((p) => p.latencyMs)),
          tier2FiringRate: tier2FiringRate(rawResults),
          tierDisagreementRate: tierDisagreementRate(rawResults, defaultPolicy.detection.tier2.threshold),
        });
        console.log(chalk.green('done'));
      }

      corpora.push({
        corpus: {
          id: corpus.id,
          name: corpus.name,
          trainOverlap: corpus.trainOverlap,
          sha256: corpus.sha256,
          entries: corpus.entries.length,
          hasParaphraseGroups: corpus.hasParaphraseGroups,
        },
        evaluated: evaluation.length,
        results,
      });
    }

    const soak = await maybeSoak(options, requested, modelPath);

    const environment = captureEnvironment();
    const report = renderReport({ corpora, seed, environment, soak });

    const outPath = resolve(process.cwd(), options.out as string);
    writeFileSync(outPath, report, 'utf-8');
    console.log(chalk.green(`\n✓ wrote ${options.out}`));

    if (options.emitEnv) {
      const envPath = resolve(process.cwd(), options.envOut as string);
      writeFileSync(envPath, `${JSON.stringify(environment, null, 2)}\n`, 'utf-8');
      console.log(chalk.green(`✓ wrote ${options.envOut}`));
    }
  });

/**
 * Run the §5 soak when `--soak <minutes>` is non-zero.
 *
 * The soak runs on the heaviest configuration the run actually requested: a leak, if there
 * is one, lives in the ONNX session, so soaking tier1-only would prove nothing about the
 * component under suspicion.
 */
async function maybeSoak(
  options: Record<string, unknown>,
  requested: TierConfiguration[],
  modelPath: string | null,
): Promise<SoakSummary | null> {
  // Re-deriving from a committed series reproduces a published row exactly and costs
  // nothing; re-running costs an hour and produces a different one.
  if (options.soakCsv) {
    const path = options.soakCsv as string;
    const result = fromCsv(readFileSync(resolve(process.cwd(), path), 'utf-8'));
    console.log(chalk.dim(`\nsoak: re-derived from ${path}`));
    return summarise(result, path);
  }

  const minutes = Number(options.soak);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;

  const ratePerSecond = Number(options.soakRate);
  const configuration = requested[requested.length - 1] ?? 'tier1';
  console.log(
    chalk.dim(`\nsoak: ${minutes} min at ${ratePerSecond} req/s on ${configuration} (§5) ...`),
  );

  const engine = new DetectionEngine(
    policyForConfiguration(defaultPolicy.detection, configuration, modelPath),
  );
  await engine.initialize();
  const detect = engineDetect(engine);

  let result;
  try {
    result = await runSoak({
      scan: (text) => detect(text, 0),
      durationMs: minutes * 60_000,
      ratePerSecond,
    });
  } finally {
    await engine.close();
  }

  const csvPath = resolve(
    process.cwd(),
    `${options.soakOut as string}/${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
  );
  mkdirSync(dirname(csvPath), { recursive: true });
  writeFileSync(csvPath, toCsv(result), 'utf-8');

  return summarise(result, `${options.soakOut as string}/${csvPath.split(/[\\/]/).pop()}`);
}

/** Shared by the measured and the re-derived path so both publish the same shape. */
function summarise(result: SoakResult, csvPath: string): SoakSummary {
  const verdict = !result.resolvable
    ? chalk.yellow('inconclusive')
    : result.passed
      ? chalk.green('pass')
      : chalk.red('FAIL');
  console.log(
    `soak: ${result.scans} scans, slope ${result.slopeMbPerHour.toFixed(2)} MB/hour, ` +
      `RSS ${result.rssMinMb.toFixed(0)}-${result.rssMaxMb.toFixed(0)} MB, ` +
      `tail spread ${result.tailSpreadMb.toFixed(2)} MB — ${verdict}`,
  );

  return {
    durationMs: result.durationMs,
    scans: result.scans,
    // The achieved rate, not the requested one: a scan slower than the rate slice
    // degrades throughput, and publishing the request would overstate the load applied.
    ratePerSecond: result.achievedRatePerSecond,
    slopeMbPerHour: result.slopeMbPerHour,
    rssMinMb: result.rssMinMb,
    rssMaxMb: result.rssMaxMb,
    tailSpreadMb: result.tailSpreadMb,
    resolvable: result.resolvable,
    passed: result.passed,
    csvPath,
  };
}
