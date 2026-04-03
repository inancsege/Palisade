import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { EventDatabase } from '../../logging/database.js';
import { EventLogger } from '../../logging/events.js';
import { printBanner } from '../output.js';
import chalk from 'chalk';

function parseDuration(duration: string): Date {
  const match = duration.match(/^(\d+)(h|d|m|w)$/);
  if (!match) {
    throw new Error(`Invalid duration: ${duration}. Use format like 24h, 7d, 30m, 1w`);
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return new Date(Date.now() - value * multipliers[unit]);
}

export const reportCommand = new Command('report')
  .description('Generate a security report from the event log')
  .option('--since <duration>', 'Time range', '7d')
  .option('--format <format>', 'Output format (text|json)', 'text')
  .option('--output <path>', 'Write report to file')
  .option('--db <path>', 'Path to SQLite database', './palisade.db')
  .action(async (options) => {
    const since = parseDuration(options.since);
    const db = new EventDatabase(options.db);
    await db.initialize();

    const eventLogger = new EventLogger(db);
    const stats = eventLogger.getStats(since);
    const events = eventLogger.queryEvents({ since, limit: 50 });

    const report = {
      generated: new Date().toISOString(),
      period: { since: since.toISOString(), until: new Date().toISOString() },
      summary: stats,
      recentEvents: events,
    };

    if (options.format === 'json') {
      const output = JSON.stringify(report, null, 2);
      if (options.output) {
        writeFileSync(options.output, output, 'utf-8');
        console.log(chalk.green(`Report written to ${options.output}`));
      } else {
        console.log(output);
      }
    } else {
      printBanner();
      console.log(chalk.bold('  Security Report'));
      console.log(chalk.gray(`  Period: ${since.toISOString()} to now\n`));
      console.log(`  Total requests:  ${chalk.bold(String(stats.totalRequests))}`);
      console.log(`  Blocked:         ${chalk.red.bold(String(stats.blockedCount))}`);
      console.log(`  Warned:          ${chalk.yellow.bold(String(stats.warnedCount))}`);
      console.log(`  Allowed:         ${chalk.green.bold(String(stats.allowedCount))}`);

      if (stats.topPatterns.length > 0) {
        console.log(chalk.bold('\n  Top Triggered Patterns:\n'));
        for (const p of stats.topPatterns.slice(0, 10)) {
          console.log(`    ${String(p.count).padStart(5)}x  ${p.patternId}`);
        }
      }

      if (events.length > 0) {
        console.log(chalk.bold(`\n  Recent Events (${events.length}):\n`));
        for (const evt of events.slice(0, 10)) {
          const actionColor = evt.action_taken === 'block' ? chalk.red
            : evt.action_taken === 'warn' ? chalk.yellow
            : chalk.green;
          console.log(`    ${chalk.gray(evt.timestamp)}  ${actionColor(evt.action_taken.toUpperCase().padEnd(5))}  score=${evt.threat_score.toFixed(2)}  ${evt.event_type}`);
        }
      }
      console.log();
    }

    eventLogger.close();
    db.close();
  });
