import chalk from 'chalk';
import type { DetectionResult, PatternMatch } from '../types/verdict.js';

export function printBanner(): void {
  console.log(chalk.bold.cyan('\n  Palisade') + chalk.gray(' v0.1.0'));
  console.log(chalk.gray('  Runtime prompt injection detection\n'));
}

export function printStartup(port: number, host: string, upstream: string, policyPath?: string): void {
  console.log(chalk.green('  Proxy listening on ') + chalk.bold(`http://${host}:${port}`));
  console.log(chalk.green('  Upstream:          ') + chalk.bold(upstream));
  if (policyPath) {
    console.log(chalk.green('  Policy:            ') + chalk.bold(policyPath));
  }
  console.log();
}

export function printScanResult(file: string, result: DetectionResult): void {
  if (result.matches.length === 0) return;

  const icon = result.action === 'block' ? chalk.red('BLOCK')
    : result.action === 'warn' ? chalk.yellow(' WARN')
    : chalk.green('ALLOW');

  console.log(`  ${icon}  ${chalk.bold(file)}`);
  console.log(chalk.gray(`         Threat score: ${result.threatScore.overall.toFixed(2)} | ${result.matches.length} match(es) | ${result.latencyMs.toFixed(1)}ms`));

  for (const match of result.matches) {
    const snippet = match.matchedText.length > 60
      ? match.matchedText.slice(0, 57) + '...'
      : match.matchedText;
    console.log(chalk.gray(`         - [${match.category}] `) + chalk.white(snippet));
  }
  console.log();
}

export function printScanSummary(
  totalFiles: number,
  totalMatches: number,
  blocked: number,
  warned: number,
): void {
  console.log(chalk.gray('  ───────────────────────────────────'));
  console.log(`  Files scanned: ${chalk.bold(String(totalFiles))}`);
  console.log(`  Total matches: ${chalk.bold(String(totalMatches))}`);
  if (blocked > 0) console.log(`  Blocked:       ${chalk.red.bold(String(blocked))}`);
  if (warned > 0) console.log(`  Warned:        ${chalk.yellow.bold(String(warned))}`);
  if (blocked === 0 && warned === 0) console.log(chalk.green('  No threats detected.'));
  console.log();
}

export function printAuditStats(stats: {
  totalRequests: number;
  blockedCount: number;
  warnedCount: number;
  allowedCount: number;
  topPatterns: { patternId: string; count: number }[];
}): void {
  console.log(chalk.bold('\n  Audit Summary\n'));
  console.log(`  Total requests: ${chalk.bold(String(stats.totalRequests))}`);
  console.log(`  Blocked:        ${chalk.red.bold(String(stats.blockedCount))}`);
  console.log(`  Warned:         ${chalk.yellow.bold(String(stats.warnedCount))}`);
  console.log(`  Allowed:        ${chalk.green.bold(String(stats.allowedCount))}`);

  if (stats.topPatterns.length > 0) {
    console.log(chalk.bold('\n  Top Patterns:\n'));
    for (const p of stats.topPatterns) {
      console.log(`    ${chalk.gray(String(p.count).padStart(5))}x  ${p.patternId}`);
    }
  }
  console.log();
}
