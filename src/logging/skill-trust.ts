import type { EventDatabase } from './database.js';
import type { VerdictAction } from '../types/verdict.js';

/**
 * A per-skill trust fact derived from the runtime event stream. `trustScore`
 * starts at 1.0 for a brand-new skill and decays per adverse verdict:
 * every block drops it by 0.8, every warn by 0.15, and clean allows recover
 * 0.1 (capped at 1.0). Counter columns are retained for introspection.
 */
export interface SkillTrustRecord {
  skillId: string;
  trustScore: number;
  totalRequests: number;
  blockedCount: number;
  warnedCount: number;
  firstSeen: string;
  lastSeen: string;
}

const RECOVERY_STEP = 0.1;
const WARN_STEP = -0.15;
const BLOCK_STEP = -0.8;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function nextScore(previous: number, action: VerdictAction): number {
  const step = action === 'block' ? BLOCK_STEP
    : action === 'warn' ? WARN_STEP
    : RECOVERY_STEP;
  return round2(clamp01(previous + step));
}

/**
 * Reads and writes the `skill_trust` table. Self-contained over an
 * `EventDatabase` so CLI read/audit commands can instantiate it directly, while
 * the proxy feeds it through the EventLogger. All SQL is server-generated,
 * keyed by `skill_id` with an upsert — safe to call concurrently per request.
 */
export class SkillTrustStore {
  constructor(
    private readonly db: EventDatabase,
    private readonly onChange: () => void = () => {},
  ) {}

  record(skillId: string, action: VerdictAction, when = new Date().toISOString()): void {
    const existing = this.get(skillId);
    const firstSeen = existing?.firstSeen ?? when;
    const totalRequests = (existing?.totalRequests ?? 0) + 1;
    const blockedCount = (existing?.blockedCount ?? 0) + (action === 'block' ? 1 : 0);
    const warnedCount = (existing?.warnedCount ?? 0) + (action === 'warn' ? 1 : 0);
    const trustScore = nextScore(existing?.trustScore ?? 1.0, action);

    const db = this.db.getDb();
    db.run(
      `INSERT INTO skill_trust (skill_id, trust_score, total_requests, blocked_count, warned_count, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(skill_id) DO UPDATE SET
         trust_score = excluded.trust_score,
         total_requests = excluded.total_requests,
         blocked_count = excluded.blocked_count,
         warned_count = excluded.warned_count,
         last_seen = excluded.last_seen`,
      [skillId, trustScore, totalRequests, blockedCount, warnedCount, firstSeen, when],
    );
    this.onChange();
  }

  get(skillId: string): SkillTrustRecord | null {
    const db = this.db.getDb();
    const stmt = db.prepare('SELECT * FROM skill_trust WHERE skill_id = ?');
    stmt.bind([skillId]);
    const row: unknown = stmt.step() ? stmt.getAsObject() : null;
    stmt.free();
    return row ? toRecord(row) : null;
  }

  /** All tracked skills, ordered riskiest-first (ascending trust score). */
  list(): SkillTrustRecord[] {
    const db = this.db.getDb();
    const stmt = db.prepare('SELECT * FROM skill_trust ORDER BY trust_score ASC, skill_id ASC');
    const records: SkillTrustRecord[] = [];
    while (stmt.step()) {
      records.push(toRecord(stmt.getAsObject()));
    }
    stmt.free();
    return records;
  }
}

function toRecord(row: object): SkillTrustRecord {
  const r = row as Record<string, unknown>;
  return {
    skillId: r.skill_id as string,
    trustScore: r.trust_score as number,
    totalRequests: r.total_requests as number,
    blockedCount: r.blocked_count as number,
    warnedCount: r.warned_count as number,
    firstSeen: r.first_seen as string,
    lastSeen: r.last_seen as string,
  };
}