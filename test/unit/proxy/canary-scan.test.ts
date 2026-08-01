import { describe, it, expect } from 'vitest';
import {
  CanaryStore,
  CanaryTextScanner,
  scanForCanary,
} from '../../../src/proxy/canary.js';

describe('scanForCanary (T4-03)', () => {
  const store = new CanaryStore({ enabled: true, rotateIntervalSeconds: 3600 });

  it('returns the token when it appears in text', () => {
    const token = store.currentToken()!;
    expect(scanForCanary(`Summary:\n${token}\nSigned.`, store)).toBe(token);
  });

  it('returns null for clean text', () => {
    expect(scanForCanary('A perfectly normal response paragraph.', store)).toBeNull();
  });
});

describe('CanaryTextScanner — cross-chunk token detection (T4-03)', () => {
  it('catches a token split across two chunks', () => {
    const store = new CanaryStore({ enabled: true, rotateIntervalSeconds: 3600 });
    const token = store.currentToken()!;
    const scanner = new CanaryTextScanner(store);
    const half = Math.floor(token.length / 2);
    expect(scanner.push(`prefix ${token.slice(0, half)}`)).toBeNull();
    expect(scanner.push(`${token.slice(half)} suffix`)).toBe(token);
  });

  it('returns null until the token fully arrives', () => {
    const store = new CanaryStore({ enabled: true, rotateIntervalSeconds: 3600 });
    const token = store.currentToken()!;
    const scanner = new CanaryTextScanner(store);
    expect(scanner.push(token.slice(0, 10))).toBeNull();
    expect(scanner.push(token.slice(10, 30))).toBeNull();
    expect(scanner.push(token.slice(30))).toBe(token);
  });

  it('stays silent on long benign streams', () => {
    const store = new CanaryStore({ enabled: true, rotateIntervalSeconds: 3600 });
    const scanner = new CanaryTextScanner(store);
    for (let i = 0; i < 500; i++) {
      expect(scanner.push('lorem ipsum dolor sit amet '.repeat(5))).toBeNull();
    }
  });
});
