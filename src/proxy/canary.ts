import { randomBytes } from 'node:crypto';

export const CANARY_TOKEN_PREFIX = 'palcanary-';
/** 16 random bytes → 32 lowercase hex chars after the prefix. */
export const CANARY_TOKEN_BYTES = 16;
/** Fixed grace window: a rotated-away token still matches for this long (delayed exfiltration). */
export const CANARY_GRACE_SECONDS = 900;

export function generateCanaryToken(): string {
  return `${CANARY_TOKEN_PREFIX}${randomBytes(CANARY_TOKEN_BYTES).toString('hex')}`;
}

export function isCanaryTokenFormat(s: string): boolean {
  return new RegExp(
    `^${CANARY_TOKEN_PREFIX}[0-9a-f]{${CANARY_TOKEN_BYTES * 2}}$`,
  ).test(s);
}

export interface CanaryStoreOptions {
  enabled: boolean;
  rotateIntervalSeconds: number;
  /** Seconds a rotated-away token still matches. Defaults to CANARY_GRACE_SECONDS. */
  graceSeconds?: number;
  /** Injectable clock for deterministic rotation tests. */
  now?: () => number;
}

interface TokenEntry {
  token: string;
  rotatedAt: number;
}

/**
 * Deployment-wide canary token store. One active token is injected into prompts
 * on the request path; any occurrence of it in a response is evidence of
 * exfiltration. The token rotates every `rotateIntervalSeconds` (lazily, on
 * access — no timers), and recently rotated-away tokens still match during the
 * grace window so requests in flight are not false-flagged.
 */
export class CanaryStore {
  private active: TokenEntry | null = null;
  private previous: TokenEntry | null = null;
  private readonly rotateIntervalMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;

  constructor(options: CanaryStoreOptions) {
    this.rotateIntervalMs = options.rotateIntervalSeconds * 1000;
    this.graceMs = (options.graceSeconds ?? CANARY_GRACE_SECONDS) * 1000;
    this.now = options.now ?? Date.now;
    if (options.enabled) {
      this.active = { token: generateCanaryToken(), rotatedAt: this.now() };
    }
  }

  /** The active token to inject into requests, or null when canary is disabled. */
  currentToken(): string | null {
    this.rotateIfDue();
    return this.active?.token ?? null;
  }

  /** True when `text` contains the active token or a rotated-away token still in its grace window. */
  isActiveToken(text: string): boolean {
    this.rotateIfDue();
    const nowMs = this.now();
    if (this.active && text.includes(this.active.token)) return true;
    if (this.previous && nowMs - this.previous.rotatedAt <= this.graceMs) {
      return text.includes(this.previous.token);
    }
    return false;
  }

  /** Force an immediate rotation (keeps the previous token within its grace window). */
  rotate(): void {
    this.rotateNow(this.now());
  }

  private rotateIfDue(): void {
    if (!this.active) return;
    if (this.now() - this.active.rotatedAt >= this.rotateIntervalMs) {
      // Lazy rotation: the old token stopped being active when the interval
      // elapsed, not when this check happens to run — stamp it accordingly so
      // the grace window expires on schedule even if no access occurs.
      this.rotateNow(this.active.rotatedAt + this.rotateIntervalMs);
    }
  }

  private rotateNow(previousRotatedAt: number): void {
    if (!this.active) return;
    this.previous = { token: this.active.token, rotatedAt: previousRotatedAt };
    this.active = { token: generateCanaryToken(), rotatedAt: this.now() };
  }
}
