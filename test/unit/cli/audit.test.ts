import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { auditCommand } from '../../../src/cli/commands/audit.js';
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
    `palisade-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

// NOTE: auditCommand is itself the Commander sub-Command (named 'audit').
// runCli prepends ['node', 'palisade', ...]. Calling parseAsync directly on
// a sub-Command treats it as the root, so the argv we pass here MUST NOT
// include the literal 'audit' subcommand token.

describe('audit command (CLIT-02)', () => {
  it('parseDuration accepts 24h via --since 24h', async () => {
    const dbPath = await seedFileDb([]);
    tempPaths.push(dbPath);
    const { exitCode, stdout } = await runCli(auditCommand, [
      '--db', dbPath, '--since', '24h', '--format', 'json',
    ]);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(parsed.totalRequests).toBe(0);
    expect(parsed.blockedCount).toBe(0);
    expect(parsed.warnedCount).toBe(0);
    expect(parsed.allowedCount).toBe(0);
  });

  it('parseDuration accepts 7d / 30m / 1w', async () => {
    const dbPath = await seedFileDb([]);
    tempPaths.push(dbPath);
    for (const since of ['7d', '30m', '1w']) {
      const { exitCode, stdout } = await runCli(auditCommand, [
        '--db', dbPath, '--since', since, '--format', 'json',
      ]);
      expect(exitCode).toBeNull();
      const parsed = JSON.parse(stdout);
      expect(parsed.totalRequests).toBe(0);
    }
  });

  it('throws an error when --since uses an invalid format', async () => {
    await expect(
      runCli(auditCommand, ['--db', ':memory:', '--since', 'forever']),
    ).rejects.toThrow(/Invalid duration/);
  });

  it('returns aggregated stats for a seeded database in JSON format', async () => {
    const dbPath = await seedFileDb([
      { requestId: 'r-1', action: 'block', threatScore: 0.85, patternId: 'override:ignore' },
      { requestId: 'r-2', action: 'block', threatScore: 0.92, patternId: 'override:ignore' },
      { requestId: 'r-3', action: 'warn', threatScore: 0.55, patternId: 'role-marker:system-colon' },
      { requestId: 'r-4', action: 'allow', threatScore: 0.10 },
    ]);
    tempPaths.push(dbPath);
    const { exitCode, stdout } = await runCli(auditCommand, [
      '--db', dbPath, '--since', '24h', '--format', 'json',
    ]);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(parsed.totalRequests).toBe(4);
    expect(parsed.blockedCount).toBe(2);
    expect(parsed.warnedCount).toBe(1);
    expect(parsed.allowedCount).toBe(1);
    expect(Array.isArray(parsed.topPatterns)).toBe(true);
  });

  it('returns topPatterns sorted by hit count', async () => {
    const dbPath = await seedFileDb([
      { requestId: 'r-1', action: 'block', threatScore: 0.85, patternId: 'override:ignore' },
      { requestId: 'r-2', action: 'block', threatScore: 0.92, patternId: 'override:ignore' },
      { requestId: 'r-3', action: 'block', threatScore: 0.88, patternId: 'override:ignore' },
      { requestId: 'r-4', action: 'warn', threatScore: 0.55, patternId: 'role-marker:system-colon' },
    ]);
    tempPaths.push(dbPath);
    const { exitCode, stdout } = await runCli(auditCommand, [
      '--db', dbPath, '--since', '24h', '--format', 'json',
    ]);
    expect(exitCode).toBeNull();
    const parsed = JSON.parse(stdout);
    expect(parsed.topPatterns[0].patternId).toBe('override:ignore');
    expect(parsed.topPatterns[0].count).toBe(3);
  });

  it('renders text format with banner and audit summary', async () => {
    const dbPath = await seedFileDb([]);
    tempPaths.push(dbPath);
    const { exitCode, stdout } = await runCli(auditCommand, [
      '--db', dbPath, '--since', '24h',
    ]);
    expect(exitCode).toBeNull();
    const plain = stripAnsi(stdout);
    expect(plain).toContain('Palisade');
    expect(plain).toContain('Audit Summary');
    expect(plain).toContain('Total requests:');
    expect(plain).toContain('Blocked:');
    expect(plain).toContain('Warned:');
    expect(plain).toContain('Allowed:');
  });

  it('uses default --since 24h when flag is omitted', async () => {
    const dbPath = await seedFileDb([
      { requestId: 'r-a', action: 'block', threatScore: 0.85 },
      { requestId: 'r-b', action: 'allow', threatScore: 0.1 },
    ]);
    tempPaths.push(dbPath);
    const { exitCode, stdout } = await runCli(auditCommand, [
      '--db', dbPath, '--format', 'json',
    ]);
    const parsed = JSON.parse(stripAnsi(stdout));
    expect(exitCode).toBeNull();
    expect(parsed.totalRequests).toBe(2);
  });
});
