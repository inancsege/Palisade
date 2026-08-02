import { describe, it, expect, afterEach } from 'vitest';
import { EventDatabase } from '../../../src/logging/database.js';
import { EventLogger } from '../../../src/logging/events.js';
import type { EventRecord } from '../../../src/types/events.js';

const handles: Array<{ logger: EventLogger; db: EventDatabase; close: () => void }> = [];

async function openLogger(): Promise<EventLogger> {
  const db = new EventDatabase(':memory:');
  await db.initialize();
  const logger = new EventLogger(db);
  handles.push({ logger, db, close: () => { logger.close(); db.close(); } });
  return logger;
}

afterEach(() => {
  for (const h of handles) h.close();
  handles.length = 0;
});

async function queryEvents(logger: EventLogger): Promise<EventRecord[]> {
  return logger.queryEvents({ limit: 100 });
}

describe('EventLogger skillId (T5-02)', () => {
  it('stores skill_id on the event row and attributes action to the skill', async () => {
    const logger = await openLogger();
    logger.logEvent({
      requestId: 'r-1',
      eventType: 'request_blocked',
      actionTaken: 'block',
      threatScore: 0.9,
      skillId: 'web-research',
    });

    const events = await queryEvents(logger);
    expect(events.length).toBe(1);
    expect(events[0].request_id).toBe('r-1');
    expect(events[0].skill_id).toBe('web-research');

    const skills = logger.skills();
    expect(skills.map((s) => s.skillId)).toContain('web-research');
    const skill = skills.find((s) => s.skillId === 'web-research')!;
    expect(skill.totalRequests).toBe(1);
    expect(skill.blockedCount).toBe(1);
  });

  it('leaves skill_id null when not supplied', async () => {
    const logger = await openLogger();
    logger.logEvent({
      requestId: 'r-2',
      eventType: 'request_scanned',
      actionTaken: 'allow',
      threatScore: 0.1,
    });
    const events = await queryEvents(logger);
    expect(events[0].skill_id).toBeNull();
    expect(logger.skills()).toEqual([]);
  });

  it('aggregates allow/warn/block across requests for one skill', async () => {
    const logger = await openLogger();
    for (const [i, action] of ['allow', 'allow', 'warn', 'block'].entries()) {
      logger.logEvent({
        requestId: `r-${i}`,
        eventType: action === 'block' ? 'request_blocked' : 'request_scanned',
        actionTaken: action as 'allow' | 'warn' | 'block',
        threatScore: action === 'block' ? 0.9 : 0.1,
        skillId: 'analyzer',
      });
    }
    const skill = logger.skills().find((s) => s.skillId === 'analyzer')!;
    expect(skill.totalRequests).toBe(4);
    expect(skill.warnedCount).toBe(1);
    expect(skill.blockedCount).toBe(1);
    expect(skill.trustScore).toBeLessThan(1.0);
  });
});