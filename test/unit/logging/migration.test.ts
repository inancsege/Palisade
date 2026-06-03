import { describe, it, expect, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { EventDatabase } from '../../../src/logging/database.js';
import { EventLogger } from '../../../src/logging/events.js';

// v0.1 SCHEMA, copied verbatim from the FOUND-07 smoke (scratch/sqljs-migration.mjs) — the
// migration must open this legacy shape with every audit query identical.
const V01_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    TEXT NOT NULL,
  timestamp     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  event_type    TEXT NOT NULL,
  provider      TEXT,
  action_taken  TEXT NOT NULL,
  threat_score  REAL NOT NULL DEFAULT 0.0,
  matches_json  TEXT,
  request_path  TEXT,
  source_ip     TEXT,
  policy_file   TEXT,
  metadata_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_request_id ON events(request_id);
CREATE INDEX IF NOT EXISTS idx_events_action ON events(action_taken);
CREATE TABLE IF NOT EXISTS skill_trust (
  skill_id      TEXT PRIMARY KEY,
  trust_score   REAL NOT NULL DEFAULT 1.0,
  total_requests INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  warned_count  INTEGER NOT NULL DEFAULT 0,
  last_seen     TEXT NOT NULL,
  first_seen    TEXT NOT NULL,
  metadata_json TEXT
);
CREATE TABLE IF NOT EXISTS pattern_stats (
  pattern_id    TEXT PRIMARY KEY,
  hit_count     INTEGER NOT NULL DEFAULT 0,
  last_hit      TEXT,
  false_positive_count INTEGER NOT NULL DEFAULT 0
);
`;

// v0.1 audit queries, reproduced verbatim from src/logging/events.ts.
const Q_EVENTS = `SELECT * FROM events ORDER BY timestamp DESC LIMIT 100`;
const Q_STATS_TOTALS = `SELECT
    COUNT(*) as total,
    SUM(CASE WHEN action_taken = 'block' THEN 1 ELSE 0 END) as blocked,
    SUM(CASE WHEN action_taken = 'warn' THEN 1 ELSE 0 END) as warned,
    SUM(CASE WHEN action_taken = 'allow' THEN 1 ELSE 0 END) as allowed
   FROM events WHERE timestamp >= ?`;
const Q_TOP_PATTERNS = `SELECT pattern_id, hit_count FROM pattern_stats ORDER BY hit_count DESC LIMIT 10`;

const SINCE = '2026-01-01T00:00:00.000Z';

function rowsOf(
  db: { prepare: (sql: string) => unknown },
  sql: string,
  params: unknown[] = [],
): Record<string, unknown>[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stmt = (db as any).prepare(sql);
  if (params.length) stmt.bind(params);
  const out: Record<string, unknown>[] = [];
  while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free();
  return out;
}

function project(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of keys) o[k] = row[k];
  return o;
}

const tempFiles: string[] = [];

afterEach(() => {
  for (const f of tempFiles.splice(0)) {
    if (existsSync(f)) unlinkSync(f);
  }
});

// Build a v0.1-era palisade.db on disk (legacy shape only, no v0.2 columns), seeded with
// representative events + pattern_stats rows. Returns the file path.
async function buildLegacyV01Db(): Promise<string> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(V01_SCHEMA);

  const actions = ['allow', 'warn', 'block'] as const;
  for (let i = 0; i < 12; i++) {
    const action = actions[i % 3];
    const ts = `2026-0${(i % 5) + 1}-1${i % 9}T1${i % 9}:30:00.000Z`;
    const matches =
      action === 'allow'
        ? null
        : JSON.stringify([{ patternId: `pat-${i % 4}`, weight: 0.4 + (i % 3) * 0.2 }]);
    db.run(
      `INSERT INTO events (request_id, timestamp, event_type, provider, action_taken, threat_score, matches_json, request_path, source_ip, policy_file, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        `req-${i}`,
        ts,
        'request_scanned',
        i % 2 ? 'anthropic' : 'openai',
        action,
        action === 'block' ? 0.82 : action === 'warn' ? 0.55 : 0.1,
        matches,
        '/v1/messages',
        null,
        'policy.example.yaml',
        null,
      ],
    );
  }
  for (const [pid, hits] of [
    ['pat-0', 9],
    ['pat-1', 5],
    ['pat-2', 3],
    ['pat-3', 1],
  ] as const) {
    db.run(`INSERT INTO pattern_stats (pattern_id, hit_count, last_hit) VALUES (?, ?, ?)`, [
      pid,
      hits,
      SINCE,
    ]);
  }

  const dbPath = join(
    tmpdir(),
    `palisade-migration-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
  tempFiles.push(dbPath);
  return dbPath;
}

describe('EventDatabase v0.2 additive migration (D19)', () => {
  it('opens a v0.1 .db with every v0.1 audit query byte-identical', async () => {
    const dbPath = await buildLegacyV01Db();

    // Capture the v0.1 audit-query results from the legacy db BEFORE migration.
    const SQL = await initSqlJs();
    const { readFileSync } = await import('node:fs');
    const legacy = new SQL.Database(readFileSync(dbPath));
    const preEvents = rowsOf(legacy, Q_EVENTS);
    const preTotals = rowsOf(legacy, Q_STATS_TOTALS, [SINCE]);
    const preTop = rowsOf(legacy, Q_TOP_PATTERNS);
    const v01Columns = Object.keys(preEvents[0]);
    legacy.close();

    // Open the SAME v0.1 db through EventDatabase — initialize() runs the v0.2 migration.
    const eventDb = new EventDatabase(dbPath);
    await eventDb.initialize();
    const db = eventDb.getDb();

    const postEvents = rowsOf(db, Q_EVENTS);
    const postTotals = rowsOf(db, Q_STATS_TOTALS, [SINCE]);
    const postTop = rowsOf(db, Q_TOP_PATTERNS);

    // v0.1 columns byte-identical (project post rows to the v0.1 column set).
    expect(postEvents.length).toBe(preEvents.length);
    for (let i = 0; i < preEvents.length; i++) {
      expect(project(postEvents[i], v01Columns)).toEqual(preEvents[i]);
    }
    // getStats queries (explicit columns) byte-identical.
    expect(postTotals).toEqual(preTotals);
    expect(postTop).toEqual(preTop);

    eventDb.close();
  });

  it('adds nullable tier2_confidence/tier3_confidence columns that read NULL on legacy rows', async () => {
    const dbPath = await buildLegacyV01Db();
    const eventDb = new EventDatabase(dbPath);
    await eventDb.initialize();
    const db = eventDb.getDb();

    const rows = rowsOf(db, Q_EVENTS);
    expect('tier2_confidence' in rows[0]).toBe(true);
    expect('tier3_confidence' in rows[0]).toBe(true);
    for (const row of rows) {
      expect(row.tier2_confidence).toBeNull();
      expect(row.tier3_confidence).toBeNull();
    }

    eventDb.close();
  });

  it('sets meta.schema_version to "2"', async () => {
    const dbPath = await buildLegacyV01Db();
    const eventDb = new EventDatabase(dbPath);
    await eventDb.initialize();
    const db = eventDb.getDb();

    const ver = rowsOf(db, `SELECT value FROM meta WHERE key = 'schema_version'`);
    expect(ver[0]?.value).toBe('2');

    eventDb.close();
  });

  it('creates the tier3_cost_ledger table', async () => {
    const dbPath = await buildLegacyV01Db();
    const eventDb = new EventDatabase(dbPath);
    await eventDb.initialize();
    const db = eventDb.getDb();

    const ledger = rowsOf(
      db,
      `SELECT name FROM sqlite_master WHERE type='table' AND name='tier3_cost_ledger'`,
    );
    expect(ledger.length).toBe(1);

    eventDb.close();
  });

  it('is idempotent: initialize() twice on the same db does not throw', async () => {
    const dbPath = await buildLegacyV01Db();

    const first = new EventDatabase(dbPath);
    await first.initialize();
    first.close(); // persists the migrated v0.2 db to disk

    // Re-open the already-migrated db; the ADD COLUMN guard must make this a no-op.
    const second = new EventDatabase(dbPath);
    await expect(second.initialize()).resolves.not.toThrow();
    const db = second.getDb();

    // Still exactly one tier2/tier3 column, value still '2'.
    const rows = rowsOf(db, Q_EVENTS);
    expect('tier2_confidence' in rows[0]).toBe(true);
    const ver = rowsOf(db, `SELECT value FROM meta WHERE key = 'schema_version'`);
    expect(ver[0]?.value).toBe('2');

    second.close();
  });

  it('runs the migration on a brand-new (no prior file) db', async () => {
    const eventDb = new EventDatabase(':memory:');
    await eventDb.initialize();
    const db = eventDb.getDb();

    const logger = new EventLogger(eventDb);
    logger.logEvent({
      requestId: 'req-new',
      eventType: 'request_scanned',
      actionTaken: 'allow',
      threatScore: 0.1,
    });

    const rows = rowsOf(db, Q_EVENTS);
    expect('tier2_confidence' in rows[0]).toBe(true);
    expect(rows[0].tier2_confidence).toBeNull();
    const ver = rowsOf(db, `SELECT value FROM meta WHERE key = 'schema_version'`);
    expect(ver[0]?.value).toBe('2');

    logger.close();
    eventDb.close();
  });
});
