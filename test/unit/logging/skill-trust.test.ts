import { describe, it, expect, afterEach } from 'vitest';
import { EventDatabase } from '../../../src/logging/database.js';
import { SkillTrustStore } from '../../../src/logging/skill-trust.js';

interface OpenHandle {
  store: SkillTrustStore;
  db: EventDatabase;
  close: () => void;
}

const openHandles: OpenHandle[] = [];

async function openStore(): Promise<OpenHandle> {
  const db = new EventDatabase(':memory:');
  await db.initialize();
  const handle: OpenHandle = {
    store: new SkillTrustStore(db),
    db,
    close: () => db.close(),
  };
  openHandles.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of openHandles) handle.close();
  openHandles.length = 0;
});

describe('SkillTrustStore (T5-01)', () => {
  it('creates a new skill at full trust on first allow', async () => {
    const { store } = await openStore();
    store.record('web-research', 'allow');
    const skill = store.get('web-research');
    expect(skill).not.toBeNull();
    expect(skill!.totalRequests).toBe(1);
    expect(skill!.blockedCount).toBe(0);
    expect(skill!.warnedCount).toBe(0);
    expect(skill!.trustScore).toBe(1.0);
  });

  it('accumulates request history across actions', async () => {
    const { store } = await openStore();
    store.record('web-research', 'allow');
    store.record('web-research', 'block');
    store.record('web-research', 'warn');
    const skill = store.get('web-research')!;
    expect(skill.totalRequests).toBe(3);
    expect(skill.blockedCount).toBe(1);
    expect(skill.warnedCount).toBe(1);
  });

  it('lowers trust with each block and recovers on clean activity', async () => {
    const { store } = await openStore();
    store.record('risky-skill', 'block');
    const afterBlock = store.get('risky-skill')!;
    expect(afterBlock.trustScore).toBeLessThan(1.0);
    expect(afterBlock.trustScore).toBe(0.2);

    store.record('risky-skill', 'allow');
    store.record('risky-skill', 'allow');
    store.record('risky-skill', 'allow');
    const recovered = store.get('risky-skill')!;
    expect(recovered.trustScore).toBeGreaterThan(afterBlock.trustScore);
  });

  it('decays trust less severely for warnings than blocks', async () => {
    const { store } = await openStore();
    store.record('warny', 'warn');
    const warnOnly = store.get('warny')!.trustScore;

    store.record('blocky', 'block');
    const blockOnly = store.get('blocky')!.trustScore;

    expect(warnOnly).toBeGreaterThan(blockOnly);
  });

  it('lists skills ordered riskiest-first with their live scores', async () => {
    const { store } = await openStore();
    store.record('clean', 'allow');
    store.record('dirty', 'block');
    store.record('dirty', 'block');
    store.record('mid', 'warn');

    const skills = store.list();
    expect(skills.map((s) => s.skillId).sort()).toEqual(['clean', 'dirty', 'mid']);
    expect(skills[0].skillId).toBe('dirty');
    expect(skills[0].trustScore).toBe(0);
  });

  it('returns null for an unknown skill', async () => {
    const { store } = await openStore();
    expect(store.get('nope')).toBeNull();
    expect(store.list()).toEqual([]);
  });
});