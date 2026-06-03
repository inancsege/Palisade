import initSqlJs from 'sql.js';
import type { Database as SqlJsDatabase } from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DatabaseError } from '../utils/errors.js';

const SCHEMA = `
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

export class EventDatabase {
  private db: SqlJsDatabase | null = null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async initialize(): Promise<void> {
    try {
      const SQL = await initSqlJs();

      if (this.dbPath === ':memory:') {
        this.db = new SQL.Database();
      } else if (existsSync(this.dbPath)) {
        const buffer = readFileSync(this.dbPath);
        this.db = new SQL.Database(buffer);
      } else {
        this.db = new SQL.Database();
      }

      this.db.run(SCHEMA);
      this.migrate();
    } catch (err) {
      throw new DatabaseError(
        `Failed to initialize database: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  /**
   * Additive, idempotent v0.2 schema migration (D19). Ported from the FOUND-07-proven
   * `scratch/sqljs-migration.mjs`: nullable `tier2_confidence`/`tier3_confidence` columns on
   * `events`, a `meta` key/value table with `schema_version='2'`, and a counts-only
   * `tier3_cost_ledger` (no prompt text — D16). All statements are forward-compatible: opening a
   * v0.1 `.db` leaves every v0.1 audit query identical, and re-running on an already-migrated db is
   * a no-op. sql.js `ALTER TABLE ... ADD COLUMN` throws if the column already exists (no
   * `IF NOT EXISTS` for columns), so each ADD COLUMN is guarded by a `PRAGMA table_info(events)`
   * presence check.
   */
  private migrate(): void {
    const db = this.db;
    if (!db) return;

    const existingColumns = new Set<string>();
    const info = db.exec('PRAGMA table_info(events)');
    // exec returns [{ columns: [...], values: [[cid, name, type, ...], ...] }]; column name is index 1.
    for (const row of info[0]?.values ?? []) {
      existingColumns.add(row[1] as string);
    }

    if (!existingColumns.has('tier2_confidence')) {
      db.run('ALTER TABLE events ADD COLUMN tier2_confidence REAL');
    }
    if (!existingColumns.has('tier3_confidence')) {
      db.run('ALTER TABLE events ADD COLUMN tier3_confidence REAL');
    }

    db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')");

    db.run(`
CREATE TABLE IF NOT EXISTS tier3_cost_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  window_start TEXT NOT NULL,
  window_type  TEXT NOT NULL,
  call_count   INTEGER NOT NULL DEFAULT 0,
  cost_units   REAL NOT NULL DEFAULT 0.0
)`);
  }

  getDb(): SqlJsDatabase {
    if (!this.db) {
      throw new DatabaseError('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  save(): void {
    if (!this.db || this.dbPath === ':memory:') return;
    try {
      const data = this.db.export();
      writeFileSync(this.dbPath, Buffer.from(data));
    } catch (err) {
      throw new DatabaseError(
        `Failed to save database: ${(err as Error).message}`,
        err as Error,
      );
    }
  }

  close(): void {
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
    }
  }
}
