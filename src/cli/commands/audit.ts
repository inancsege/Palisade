import { Command } from 'commander';
import { EventDatabase } from '../../logging/database.js';
import { EventLogger } from '../../logging/events.js';
import { printBanner, printAuditStats } from '../output.js';

function parseDuration(duration: string): Date {
  const match = duration.match(/^(\d+)(h|d|m|w)$/);
  if (!match) {
    throw new Error(`Invalid duration: ${duration}. Use format like 24h, 7d, 30m, 1w`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];
  const now = Date.now();

  const multipliers: Record<string, number> = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };

  return new Date(now - value * multipliers[unit]);
}

export const auditCommand = new Command('audit')
  .description('Audit the event log for security incidents')
  .option('--since <duration>', 'Time range (e.g., 24h, 7d)', '24h')
  .option('--format <format>', 'Output format (text|json)', 'text')
  .option('--db <path>', 'Path to SQLite database', './palisade.db')
  .action(async (options) => {
    const since = parseDuration(options.since);
    const db = new EventDatabase(options.db);
    await db.initialize();

    const eventLogger = new EventLogger(db);
    const stats = eventLogger.getStats(since);

    if (options.format === 'json') {
      console.log(JSON.stringify(stats, null, 2));
    } else {
      printBanner();
      printAuditStats(stats);
    }

    eventLogger.close();
    db.close();
  });
