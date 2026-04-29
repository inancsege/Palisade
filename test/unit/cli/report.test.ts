import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { reportCommand } from '../../../src/cli/commands/report.js';
import { runCli, stripAnsi } from '../../helpers/cli.js';
import { EventDatabase } from '../../../src/logging/database.js';
import { EventLogger } from '../../../src/logging/events.js';

interface SeedEvent {
  requestId: string;
  action: 'block' | 'warn' | 'allow';
  threatScore: number;
  patternId?: string;
}

async function seedFileDb(events: SeedEvent[]): Promise<string> {
  const dbPath = join(
    tmpdir(),
    `palisade-report-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const db = new EventDatabase(dbPath);
  await db.initialize();
  const logger = new EventLogger(db);
  for (const evt of events) {
    const eventType = evt.action === 'block' ? 'request_blocked'
      : evt.action === 'warn' ? 'request_warned'
      : 'request_scanned';
    logger.logEvent({
      requestId: evt.requestId,
      eventType,
      actionTaken: evt.action,
      threatScore: evt.threatScore,
      matches: evt.patternId
        ? [{
            patternId: evt.patternId,
            description: 'fixture',
            tier: 1,
            category: 'override_phrase',
            confidence: 0.9,
            weight: 1.0,
            matchedText: 'x',
            offset: 0,
            length: 1,
          }]
        : undefined,
    });
  }
  logger.close();
  db.close();
  return dbPath;
}

const tempPaths: string[] = [];

afterEach(() => {
  for (const p of tempPaths) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      // Windows EPERM tolerance: best-effort cleanup
    }
  }
  tempPaths.length = 0;
});

// NOTE: reportCommand is itself the Commander sub-Command (named 'report').
// runCli prepends ['node', 'palisade', ...]. Calling parseAsync directly on
// a sub-Command treats it as the root, so the argv we pass here MUST NOT
// include the literal 'report' subcommand token.

describe('report command (CLIT-03)', () => {
  it('parseDuration accepts 7d via --since 7d', async () => {
    const dbPath = await seedFileDb([]);
    tempPaths.push(dbPath);
    const { exitCode, stdout } = await runCli(reportCommand, [
      '--db', dbPath, '--since', '7d', '--format', 'json',
    ]);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(typeof parsed.generated).toBe('string');
    expect(parsed.period).toHaveProperty('since');
    expect(parsed.period).toHaveProperty('until');
    expect(parsed.summary.totalRequests).toBe(0);
    expect(Array.isArray(parsed.recentEvents)).toBe(true);
    expect(parsed.recentEvents).toEqual([]);
  });

  it('parseDuration accepts 24h / 30m / 1w against report --since', async () => {
    const dbPath = await seedFileDb([]);
    tempPaths.push(dbPath);
    for (const since of ['24h', '30m', '1w']) {
      const { exitCode, stdout } = await runCli(reportCommand, [
        '--db', dbPath, '--since', since, '--format', 'json',
      ]);
      expect(exitCode).toBeNull();
      const parsed = JSON.parse(stdout);
      expect(parsed.summary.totalRequests).toBe(0);
    }
  });

  it('throws an error when --since uses an invalid format', async () => {
    await expect(
      runCli(reportCommand, ['--db', ':memory:', '--since', 'invalid']),
    ).rejects.toThrow(/Invalid duration/);
  });

  it('aggregates stats and includes recent events for a seeded database', async () => {
    const dbPath = await seedFileDb([
      { requestId: 'r-1', action: 'block', threatScore: 0.85, patternId: 'override:ignore' },
      { requestId: 'r-2', action: 'warn', threatScore: 0.55, patternId: 'role-marker:system-colon' },
      { requestId: 'r-3', action: 'allow', threatScore: 0.10 },
      { requestId: 'r-4', action: 'allow', threatScore: 0.05 },
    ]);
    tempPaths.push(dbPath);
    const { exitCode, stdout } = await runCli(reportCommand, [
      '--db', dbPath, '--since', '24h', '--format', 'json',
    ]);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(parsed.summary.totalRequests).toBe(4);
    expect(parsed.summary.blockedCount).toBe(1);
    expect(parsed.summary.warnedCount).toBe(1);
    expect(parsed.summary.allowedCount).toBe(2);
    expect(Array.isArray(parsed.recentEvents)).toBe(true);
    expect(parsed.recentEvents.length).toBeGreaterThanOrEqual(1);
    expect(parsed.recentEvents.length).toBeLessThanOrEqual(50);
  });

  it('writes JSON report to --output <path> and prints a confirmation to stdout', async () => {
    const dbPath = await seedFileDb([
      { requestId: 'r-1', action: 'block', threatScore: 0.85, patternId: 'override:ignore' },
    ]);
    tempPaths.push(dbPath);
    const outPath = join(
      tmpdir(),
      `palisade-report-out-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    tempPaths.push(outPath);
    const { exitCode, stdout } = await runCli(reportCommand, [
      '--db', dbPath, '--format', 'json', '--output', outPath, '--since', '24h',
    ]);
    expect(exitCode).toBeNull();
    expect(existsSync(outPath)).toBe(true);
    const plainOut = stripAnsi(stdout);
    expect(plainOut).toContain('Report written to');
    expect(plainOut).toContain(outPath);
    const fileContent = JSON.parse(readFileSync(outPath, 'utf-8'));
    expect(fileContent).toHaveProperty('summary');
    expect(fileContent).toHaveProperty('recentEvents');
    expect(fileContent.summary.totalRequests).toBe(1);
  });

  it('renders text format with security report summary and event lines', async () => {
    const dbPath = await seedFileDb([
      { requestId: 'r-1', action: 'block', threatScore: 0.85, patternId: 'override:ignore' },
      { requestId: 'r-2', action: 'warn', threatScore: 0.55, patternId: 'role-marker:system-colon' },
      { requestId: 'r-3', action: 'allow', threatScore: 0.10 },
    ]);
    tempPaths.push(dbPath);
    const { exitCode, stdout } = await runCli(reportCommand, [
      '--db', dbPath, '--since', '24h',
    ]);
    expect(exitCode).toBeNull();
    const plain = stripAnsi(stdout);
    expect(plain).toContain('Palisade');
    expect(plain).toContain('Security Report');
    expect(plain).toContain('Total requests:');
    expect(plain).toContain('Blocked:');
    expect(plain).toContain('Warned:');
    expect(plain).toContain('Allowed:');
    expect(plain).toContain('Recent Events');
    // exercises the actionColor branches in report.ts (block / warn / allow)
    expect(plain).toContain('BLOCK');
    expect(plain).toContain('WARN');
    expect(plain).toContain('ALLOW');
  });

  it('renders text format with topPatterns when patterns are present', async () => {
    const dbPath = await seedFileDb([
      { requestId: 'r-1', action: 'block', threatScore: 0.85, patternId: 'override:ignore' },
      { requestId: 'r-2', action: 'block', threatScore: 0.88, patternId: 'override:ignore' },
      { requestId: 'r-3', action: 'block', threatScore: 0.91, patternId: 'override:ignore' },
    ]);
    tempPaths.push(dbPath);
    const { exitCode, stdout } = await runCli(reportCommand, [
      '--db', dbPath, '--since', '24h',
    ]);
    expect(exitCode).toBeNull();
    const plain = stripAnsi(stdout);
    expect(plain).toContain('Top Triggered Patterns:');
    expect(plain).toContain('override:ignore');
    // count line is "    3x  override:ignore" (count.padStart(5) + 'x  ' + patternId)
    expect(plain).toMatch(/3x\s+override:ignore/);
  });
});
