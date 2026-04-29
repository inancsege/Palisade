import { EventDatabase } from '../../src/logging/database.js';
import { EventLogger } from '../../src/logging/events.js';
import type { VerdictAction, PatternMatch } from '../../src/types/verdict.js';

/**
 * Lightweight fixture event shape for seeding an in-memory EventDatabase via
 * real EventLogger.logEvent calls. Mirrors the audit/report production write
 * path -- so seeded data flows through the same SQL writes that the commands
 * later read from.
 */
export interface FixtureEvent {
  requestId: string;
  action: VerdictAction;
  threatScore: number;
  /** When set, a single PatternMatch is attached to the event. */
  patternId?: string;
  /** Optional override; defaults to 'override_phrase'. */
  patternCategory?: PatternMatch['category'];
}

/**
 * Builds an in-memory EventDatabase + EventLogger seeded via real
 * EventLogger.logEvent calls. The eventType is derived from the action:
 * - 'block' -> 'request_blocked'
 * - 'warn'  -> 'request_warned'
 * - 'allow' -> 'request_scanned'
 *
 * The returned `close` function MUST be called in afterEach (or finally) to
 * clear the 5-second setInterval timer the EventLogger constructor schedules.
 * Failing to close leaks the timer and keeps the Vitest worker alive.
 */
export async function makeSeededDb(
  events: FixtureEvent[],
): Promise<{ db: EventDatabase; logger: EventLogger; close: () => void }> {
  const db = new EventDatabase(':memory:');
  await db.initialize();
  const logger = new EventLogger(db);

  for (const evt of events) {
    const eventType = evt.action === 'block' ? 'request_blocked'
      : evt.action === 'warn' ? 'request_warned'
      : 'request_scanned';
    const matches: PatternMatch[] | undefined = evt.patternId
      ? [{
          patternId: evt.patternId,
          description: 'fixture pattern',
          tier: 1,
          category: evt.patternCategory ?? 'override_phrase',
          confidence: 0.9,
          weight: 1.0,
          matchedText: 'x',
          offset: 0,
          length: 1,
        }]
      : undefined;

    logger.logEvent({
      requestId: evt.requestId,
      eventType,
      actionTaken: evt.action,
      threatScore: evt.threatScore,
      matches,
    });
  }

  return {
    db,
    logger,
    close: () => {
      logger.close();
      db.close();
    },
  };
}
