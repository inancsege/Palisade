import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { DetectionEngine } from '../../detection/engine.js';
import { defaultPolicy } from '../../policy/defaults.js';
import { printBanner } from '../output.js';
import { loadCorpus } from '../../bench/corpus.js';
import { PINNED_SEED, splitCorpus } from '../../bench/split.js';
import {
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
import { captureEnvironment, renderReport, type ConfigurationResult } from '../../bench/report.js';
import { MODEL_SHA, isInstalled, modelDirFor } from '../../detection/tier2/model-cache.js';
import type { DetectionResult } from '../../types/verdict.js';

const ALL_CONFIGURATIONS: TierConfiguration[] = ['tier1', 'tier1+2', 'tier1+2+3'];

export const benchmarkCommand = new Command('benchmark')
  .description('Run the pre-registered benchmark (docs/benchmark-protocol.md) over the corpus')
  .option('--corpus <dir>', 'Corpus directory containing attacks.jsonl + benign.jsonl', 'bench/corpus')
  .option('--out <path>', 'Write the rendered report here', 'BENCHMARK.md')
  .option('--emit-env', 'Also write environment.json for the run (§7)', false)
  .option('--env-out <path>', 'Path for the environment file', 'environment.json')
  .option(
    '--configurations <list>',
    'Comma-separated subset of tier1,tier1+2,tier1+2+3',
    ALL_CONFIGURATIONS.join(','),
  )
  .option('--seed <n>', 'Override the pinned RNG seed (invalidates published numbers)', String(PINNED_SEED))
  .action(async (options) => {
    printBanner();

    const seed = Number(options.seed);
    const corpusDir = resolve(process.cwd(), options.corpus as string);
    const corpus = loadCorpus({
      id: 'C4',
      name: 'Palisade held-out adversarial set',
      trainOverlap: 'none',
      attacksPath: resolve(corpusDir, 'attacks.jsonl'),
      benignPath: resolve(corpusDir, 'benign.jsonl'),
    });

    // §4: only the EVAL split is ever scored. The calibration split exists to fit the
    // Tier 2 threshold and is deliberately never read here.
    const { evaluation } = splitCorpus(corpus.entries, seed);

    const requested = String(options.configurations)
      .split(',')
      .map((c) => c.trim())
      .filter((c): c is TierConfiguration => (ALL_CONFIGURATIONS as string[]).includes(c));

    console.log(
      chalk.dim(
        `corpus ${corpus.id} · ${corpus.entries.length} entries · eval split ${evaluation.length} · seed ${seed}`,
      ),
    );

    // Resolve the installed Tier 2 model up front and refuse any Tier 2 configuration
    // without it — a silently no-opping Tier 2 would publish an invented row.
    const modelPath = isInstalled(MODEL_SHA) ? modelDirFor(MODEL_SHA) : null;
    for (const configuration of requested) requireModelFor(configuration, modelPath);
    console.log(
      chalk.dim(`tier 2 model: ${modelPath ?? 'not installed (tier1-only run)'}`),
    );

    const results: ConfigurationResult[] = [];
    for (const configuration of requested) {
      process.stdout.write(chalk.dim(`  running ${configuration} ... `));
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
        trueNegativeRate: trueNegativeRate(predictions),
        paraphraseConsistency: paraphraseConsistency(predictions),
        latency: latencyColumns(predictions.map((p) => p.latencyMs)),
        tier2FiringRate: tier2FiringRate(rawResults),
        tierDisagreementRate: tierDisagreementRate(rawResults, defaultPolicy.detection.tier2.threshold),
      });
      console.log(chalk.green('done'));
    }

    const environment = captureEnvironment();
    const report = renderReport({
      corpus: {
        id: corpus.id,
        name: corpus.name,
        trainOverlap: corpus.trainOverlap,
        sha256: corpus.sha256,
        entries: corpus.entries.length,
      },
      evaluated: evaluation.length,
      seed,
      results,
      environment,
    });

    const outPath = resolve(process.cwd(), options.out as string);
    writeFileSync(outPath, report, 'utf-8');
    console.log(chalk.green(`\n✓ wrote ${options.out}`));

    if (options.emitEnv) {
      const envPath = resolve(process.cwd(), options.envOut as string);
      writeFileSync(envPath, `${JSON.stringify(environment, null, 2)}\n`, 'utf-8');
      console.log(chalk.green(`✓ wrote ${options.envOut}`));
    }
  });
