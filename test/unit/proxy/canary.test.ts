import { describe, it, expect } from 'vitest';
import {
  CanaryStore,
  CANARY_GRACE_SECONDS,
  isCanaryTokenFormat,
} from '../../../src/proxy/canary.js';

function makeClock() {
  let now = 1_000_000;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('CanaryStore — token generation and rotation (T4-01)', () => {
  it('generates a format-valid token immediately on creation', () => {
    const store = new CanaryStore({ enabled: true, rotateIntervalSeconds: 3600 });
    const token = store.currentToken();
    expect(token).not.toBeNull();
    expect(isCanaryTokenFormat(token!)).toBe(true);
  });

  it('keeps the same token until the rotation interval elapses', () => {
    const clock = makeClock();
    const store = new CanaryStore({ enabled: true, rotateIntervalSeconds: 3600, now: clock.now });
    const first = store.currentToken();
    clock.advance(3599_000);
    expect(store.currentToken()).toBe(first);
    expect(store.isActiveToken(first!)).toBe(true);
  });

  it('rotates to a new token when the interval elapses', () => {
    const clock = makeClock();
    const store = new CanaryStore({ enabled: true, rotateIntervalSeconds: 3600, now: clock.now });
    const first = store.currentToken();
    clock.advance(3600_000);
    const second = store.currentToken();
    expect(second).not.toBe(first);
    expect(isCanaryTokenFormat(second!)).toBe(true);
  });

  it('still matches the rotated-away token during the grace period', () => {
    const clock = makeClock();
    const store = new CanaryStore({ enabled: true, rotateIntervalSeconds: 3600, now: clock.now });
    const first = store.currentToken();
    clock.advance(3600_000);
    expect(store.currentToken()).not.toBe(first);
    expect(store.isActiveToken(first!)).toBe(true);
  });

  it('stops matching the old token after the grace period expires', () => {
    const clock = makeClock();
    const store = new CanaryStore({ enabled: true, rotateIntervalSeconds: 3600, now: clock.now });
    const first = store.currentToken();
    clock.advance(3600_000 + CANARY_GRACE_SECONDS * 1000 + 1);
    expect(store.isActiveToken(first!)).toBe(false);
  });

  it('forced rotation moves the token immediately', () => {
    const clock = makeClock();
    const store = new CanaryStore({ enabled: true, rotateIntervalSeconds: 3600, now: clock.now });
    const first = store.currentToken();
    store.rotate();
    const second = store.currentToken();
    expect(second).not.toBe(first);
    expect(store.isActiveToken(first!)).toBe(true);
    clock.advance(CANARY_GRACE_SECONDS * 1000 + 1);
    expect(store.isActiveToken(first!)).toBe(false);
  });

  it('matches the token embedded in larger text', () => {
    const store = new CanaryStore({ enabled: true, rotateIntervalSeconds: 3600 });
    const token = store.currentToken()!;
    expect(store.isActiveToken(`Here is the report:\n${token}\nSigned.`)).toBe(true);
    expect(store.isActiveToken('just a regular paragraph about the weather')).toBe(false);
  });

  it('disabled store has no token and never matches', () => {
    const store = new CanaryStore({ enabled: false, rotateIntervalSeconds: 3600 });
    expect(store.currentToken()).toBeNull();
    expect(store.isActiveToken('palcanary-deadbeefdeadbeefdeadbeefdeadbeef')).toBe(false);
  });
});
