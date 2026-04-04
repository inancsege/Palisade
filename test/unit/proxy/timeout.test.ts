import { describe, it, expect } from 'vitest';
import { resolveProxyConfig } from '../../../src/utils/config.js';

describe('timeout configuration', () => {
  it('should default to 300 seconds', () => {
    const config = resolveProxyConfig({});
    expect(config.timeout).toBe(300);
  });

  it('should accept CLI timeout option', () => {
    const config = resolveProxyConfig({ timeout: '60' });
    expect(config.timeout).toBe(60);
  });

  it('should accept PALISADE_TIMEOUT env var', () => {
    const original = process.env.PALISADE_TIMEOUT;
    process.env.PALISADE_TIMEOUT = '120';
    try {
      const config = resolveProxyConfig({});
      expect(config.timeout).toBe(120);
    } finally {
      if (original === undefined) delete process.env.PALISADE_TIMEOUT;
      else process.env.PALISADE_TIMEOUT = original;
    }
  });

  it('should prioritize CLI option over env var', () => {
    const original = process.env.PALISADE_TIMEOUT;
    process.env.PALISADE_TIMEOUT = '120';
    try {
      const config = resolveProxyConfig({ timeout: '60' });
      expect(config.timeout).toBe(60);
    } finally {
      if (original === undefined) delete process.env.PALISADE_TIMEOUT;
      else process.env.PALISADE_TIMEOUT = original;
    }
  });
});
