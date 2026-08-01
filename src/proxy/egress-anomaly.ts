/** Fixed anomaly window: egress activity older than this is ignored. */
export const EGRESS_ANOMALY_WINDOW_MS = 60_000;
/** Same host called this many times within the window → burst anomaly. */
export const EGRESS_SAME_HOST_THRESHOLD = 5;
/** This many distinct hosts within the window → new-host-flood anomaly. */
export const EGRESS_DISTINCT_HOST_THRESHOLD = 5;
/** Bounded session map; evicts the least-recently-active source IP beyond this. */
const MAX_SESSIONS = 1024;

export type EgressAnomalyKind = 'burst' | 'new-host-flood';

export interface EgressAnomaly {
  kind: EgressAnomalyKind;
  /** The offending host for bursts; null for host-floods (the set is the signal). */
  host: string | null;
  count: number;
}

interface SessionState {
  /** host → arrival timestamps (pruned on access). */
  hosts: Map<string, number[]>;
}

/**
 * Cross-request exfiltration anomaly detection (fixed thresholds). Keyed by
 * source IP; windowed per-host and per-distinct-host counters. An anomaly fires
 * exactly once per window — when a counter crosses its threshold — so repeated
 * logging is avoided while the window still holds the same activity.
 */
export class EgressAnomalyTracker {
  private sessions = new Map<string, SessionState>();

  constructor(private readonly now: () => number = Date.now) {}

  recordEgress(sourceIp: string, host: string): EgressAnomaly[] {
    const t = this.now();
    let session = this.sessions.get(sourceIp);
    if (!session) {
      session = { hosts: new Map() };
      this.sessions.set(sourceIp, session);
    }
    // Move to the end of the insertion order: cheapest bounded LRU.
    this.sessions.delete(sourceIp);
    this.sessions.set(sourceIp, session);
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }

    const anomalies: EgressAnomaly[] = [];

    const hostTimes = session.hosts.get(host) ?? [];
    hostTimes.push(t);
    session.hosts.set(host, hostTimes);

    let distinctHosts = 0;
    for (const [h, times] of session.hosts) {
      const kept = times.filter((x) => t - x <= EGRESS_ANOMALY_WINDOW_MS);
      if (kept.length === 0) {
        session.hosts.delete(h);
        continue;
      }
      session.hosts.set(h, kept);
      distinctHosts++;
      if (h === host && kept.length === EGRESS_SAME_HOST_THRESHOLD) {
        anomalies.push({ kind: 'burst', host, count: kept.length });
      }
    }

    if (distinctHosts === EGRESS_DISTINCT_HOST_THRESHOLD) {
      anomalies.push({ kind: 'new-host-flood', host: null, count: distinctHosts });
    }

    return anomalies;
  }
}
