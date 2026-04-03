import type { ProviderType } from './proxy.js';
import type { VerdictAction } from './verdict.js';

export type EventType =
  | 'request_scanned'
  | 'injection_detected'
  | 'request_blocked'
  | 'request_warned'
  | 'policy_violation'
  | 'canary_triggered'
  | 'scan_completed';

export interface EventRecord {
  id: number;
  request_id: string;
  timestamp: string;
  event_type: EventType;
  provider: ProviderType | null;
  action_taken: VerdictAction;
  threat_score: number;
  matches_json: string;
  request_path: string | null;
  source_ip: string | null;
  policy_file: string | null;
  metadata_json: string | null;
}

export interface EventQueryFilters {
  since?: Date;
  until?: Date;
  eventType?: EventType;
  action?: VerdictAction;
  limit?: number;
  offset?: number;
}

export interface EventStats {
  totalRequests: number;
  blockedCount: number;
  warnedCount: number;
  allowedCount: number;
  topPatterns: { patternId: string; count: number }[];
  threatScoreDistribution: { bucket: string; count: number }[];
}
