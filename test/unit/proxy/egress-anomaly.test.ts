import { describe, it, expect } from 'vitest';
import {
  EgressAnomalyTracker,
  EGRESS_SAME_HOST_THRESHOLD,
  EGRESS_DISTINCT_HOST_THRESHOLD,
} from '../../../src/proxy/egress-anomaly.js';

function makeClock() {
  let now = 0;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('EgressAnomalyTracker — burst detection (T4-04)', () => {
  it('stays quiet below the same-host threshold', () => {
    const clock = makeClock();
    const tracker = new EgressAnomalyTracker(clock.now);
    for (let i = 0; i < EGRESS_SAME_HOST_THRESHOLD - 1; i++) {
      expect(tracker.recordEgress('10.0.0.1', 'exfil.example.com')).toEqual([]);
    }
  });

  it('fires a burst the moment the same host is called threshold times in the window', () => {
    const clock = makeClock();
    const tracker = new EgressAnomalyTracker(clock.now);
    for (let i = 0; i < EGRESS_SAME_HOST_THRESHOLD - 1; i++) tracker.recordEgress('10.0.0.1', 'exfil.example.com');
    const anomalies = tracker.recordEgress('10.0.0.1', 'exfil.example.com');
    expect(anomalies).toEqual([
      { kind: 'burst', host: 'exfil.example.com', count: EGRESS_SAME_HOST_THRESHOLD },
    ]);
  });

  it('does not re-fire on every call beyond the threshold within the same window', () => {
    const tracker = new EgressAnomalyTracker(() => 0);
    for (let i = 0; i < EGRESS_SAME_HOST_THRESHOLD + 3; i++) tracker.recordEgress('10.0.0.1', 'exfil.example.com');
    const anomalies = tracker.recordEgress('10.0.0.1', 'exfil.example.com');
    expect(anomalies.filter((a) => a.kind === 'burst')).toEqual([]);
  });

  it('resets the counter after the window expires and fires again on a new burst', () => {
    const clock = makeClock();
    const tracker = new EgressAnomalyTracker(clock.now);
    for (let i = 0; i < EGRESS_SAME_HOST_THRESHOLD; i++) tracker.recordEgress('10.0.0.1', 'exfil.example.com');
    clock.advance(60_001);
    for (let i = 0; i < EGRESS_SAME_HOST_THRESHOLD - 1; i++) {
      expect(tracker.recordEgress('10.0.0.1', 'exfil.example.com')).toEqual([]);
    }
    const anomalies = tracker.recordEgress('10.0.0.1', 'exfil.example.com');
    expect(anomalies.filter((a) => a.kind === 'burst')).toHaveLength(1);
  });
});

describe('EgressAnomalyTracker — new-host flood (T4-04)', () => {
  it('fires a new-host-flood when distinct hosts reach the threshold in the window', () => {
    const tracker = new EgressAnomalyTracker(() => 0);
    let anomalies: ReturnType<EgressAnomalyTracker['recordEgress']> = [];
    for (let i = 0; i < EGRESS_DISTINCT_HOST_THRESHOLD; i++) {
      anomalies = tracker.recordEgress('10.0.0.1', `host-${i}.example.com`);
    }
    expect(anomalies).toEqual([
      { kind: 'new-host-flood', host: null, count: EGRESS_DISTINCT_HOST_THRESHOLD },
    ]);
  });

  it('does not fire twice while the window holds the same host set', () => {
    const tracker = new EgressAnomalyTracker(() => 0);
    for (let i = 0; i < EGRESS_DISTINCT_HOST_THRESHOLD + 2; i++) {
      tracker.recordEgress('10.0.0.1', `host-${i}.example.com`);
    }
    const anomalies = tracker.recordEgress('10.0.0.1', 'another.example.com');
    expect(anomalies.filter((a) => a.kind === 'new-host-flood')).toEqual([]);
  });
});

describe('EgressAnomalyTracker — isolation (T4-04)', () => {
  it('tracks source IPs independently', () => {
    const tracker = new EgressAnomalyTracker(() => 0);
    for (let i = 0; i < EGRESS_SAME_HOST_THRESHOLD - 1; i++) {
      tracker.recordEgress('10.0.0.1', 'exfil.example.com');
    }
    const other = tracker.recordEgress('10.0.0.2', 'exfil.example.com');
    expect(other).toEqual([]);
    const mine = tracker.recordEgress('10.0.0.1', 'exfil.example.com');
    expect(mine.filter((a) => a.kind === 'burst')).toHaveLength(1);
  });
});
