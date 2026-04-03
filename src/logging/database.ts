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
    } catch (err) {
      throw new DatabaseError(
        `Failed to initialize database: ${(err as Error).message}`,
        err as Error,
      );
    }
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
