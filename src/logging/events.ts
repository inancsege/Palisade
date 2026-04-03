import type { EventDatabase } from './database.js';
import type { EventRecord, EventQueryFilters, EventStats, EventType } from '../types/events.js';
import type { VerdictAction, PatternMatch } from '../types/verdict.js';
import type { ProviderType } from '../types/proxy.js';

export class EventLogger {
  private db: EventDatabase;
  private dirty = false;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: EventDatabase) {
    this.db = db;
    // Periodic save every 5 seconds if dirty
    this.saveTimer = setInterval(() => {
      if (this.dirty) {
        this.db.save();
        this.dirty = false;
      }
    }, 5000);
  }

  logEvent(event: {
    requestId: string;
    eventType: EventType;
    provider?: ProviderType | null;
    actionTaken: VerdictAction;
    threatScore: number;
    matches?: PatternMatch[];
    requestPath?: string | null;
    sourceIp?: string | null;
    policyFile?: string | null;
    metadata?: Record<string, unknown> | null;
  }): void {
    const db = this.db.getDb();

    db.run(
      `INSERT INTO events (request_id, event_type, provider, action_taken, threat_score, matches_json, request_path, source_ip, policy_file, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.requestId,
        event.eventType,
        event.provider ?? null,
        event.actionTaken,
        event.threatScore,
        event.matches ? JSON.stringify(event.matches) : null,
        event.requestPath ?? null,
        event.sourceIp ?? null,
        event.policyFile ?? null,
        event.metadata ? JSON.stringify(event.metadata) : null,
      ],
    );

    // Update pattern stats
    if (event.matches) {
      for (const match of event.matches) {
        db.run(
          `INSERT INTO pattern_stats (pattern_id, hit_count, last_hit)
           VALUES (?, 1, datetime('now'))
           ON CONFLICT(pattern_id) DO UPDATE SET
             hit_count = hit_count + 1,
             last_hit = datetime('now')`,
          [match.patternId],
        );
      }
    }

    this.dirty = true;
  }

  queryEvents(filters: EventQueryFilters = {}): EventRecord[] {
    const db = this.db.getDb();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.since) {
      conditions.push('timestamp >= ?');
      params.push(filters.since.toISOString());
    }
    if (filters.until) {
      conditions.push('timestamp <= ?');
      params.push(filters.until.toISOString());
    }
    if (filters.eventType) {
      conditions.push('event_type = ?');
      params.push(filters.eventType);
    }
    if (filters.action) {
      conditions.push('action_taken = ?');
      params.push(filters.action);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 100;
    const offset = filters.offset ?? 0;

    const stmt = db.prepare(
      `SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
    );
    stmt.bind([...params, limit, offset]);

    const results: EventRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as unknown as EventRecord;
      results.push(row);
    }
    stmt.free();

    return results;
  }

  getStats(since: Date): EventStats {
    const db = this.db.getDb();
    const sinceStr = since.toISOString();

    const totals = db.exec(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN action_taken = 'block' THEN 1 ELSE 0 END) as blocked,
        SUM(CASE WHEN action_taken = 'warn' THEN 1 ELSE 0 END) as warned,
        SUM(CASE WHEN action_taken = 'allow' THEN 1 ELSE 0 END) as allowed
       FROM events WHERE timestamp >= ?`,
      [sinceStr],
    );

    const row = totals[0]?.values[0] ?? [0, 0, 0, 0];

    const topPatternsResult = db.exec(
      `SELECT pattern_id, hit_count FROM pattern_stats ORDER BY hit_count DESC LIMIT 10`,
    );

    const topPatterns = (topPatternsResult[0]?.values ?? []).map((r: unknown[]) => ({
      patternId: r[0] as string,
      count: r[1] as number,
    }));

    return {
      totalRequests: (row[0] as number) ?? 0,
      blockedCount: (row[1] as number) ?? 0,
      warnedCount: (row[2] as number) ?? 0,
      allowedCount: (row[3] as number) ?? 0,
      topPatterns,
      threatScoreDistribution: [],
    };
  }

  close(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    this.db.save();
  }
}
