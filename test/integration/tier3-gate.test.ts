import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PalisadeProxy } from '../../src/proxy/server.js';
import { defaultPolicy } from '../../src/policy/defaults.js';
import { EventDatabase } from '../../src/logging/database.js';
import { EventLogger } from '../../src/logging/events.js';
import type { EventRecord } from '../../src/types/events.js';
import type { PolicyConfig } from '../../src/types/policy.js';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { sendRequest, getAvailablePort } from '../helpers/http.js';
import { createMockUpstream } from '../helpers/mock-upstream.js';

function tier3Policy(overrides: Partial<PolicyConfig['detection']['tier3']> = {}): PolicyConfig {
  return {
    ...defaultPolicy,
    detection: {
      ...defaultPolicy.detection,
      tier3: { ...defaultPolicy.detection.tier3, enabled: true, ...overrides },
    },
    tools: {
      'weather-lookup': { network_egress: { allow: ['api.openweathermap.org'] } },
    },
  };
}

const ANTHROPIC_RESPONSE = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  content: [
    { type: 'text', text: 'Checking the weather.' },
    {
      type: 'tool_use',
      id: 'toolu_evil',
      name: 'weather-lookup',
      input: { url: 'https://evil.example.com/x' },
    },
    {
      type: 'tool_use',
      id: 'toolu_ok',
      name: 'weather-lookup',
      input: { url: 'https://api.openweathermap.org/x' },
    },
  ],
  model: 'test',
  usage: { input_tokens: 10, output_tokens: 5 },
};

const OPENAI_RESPONSE = {
  id: 'chatcmpl-1',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'weather-lookup',
              arguments: '{"url": "https://evil.example.com/x"}',
            },
          },
          {
            id: 'call_2',
            type: 'function',
            function: {
              name: 'weather-lookup',
              arguments: '{"url": "https://api.openweathermap.org/x"}',
            },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
};

async function startProxy(upstreamPort: number, policy: PolicyConfig): Promise<{ proxy: PalisadeProxy; port: number }> {
  const port = await getAvailablePort();
  const proxy = new PalisadeProxy(
    {
      port,
      host: '127.0.0.1',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      logLevel: 'error',
      dbPath: ':memory:',
      maxBodySize: 10 * 1024 * 1024,
      timeout: 300,
    },
    policy,
  );
  await proxy.start();
  return { proxy, port };
}

describe('Tier 3 response gate — non-streaming (T3-06)', () => {
  let mockUpstream: Server;
  let mockUpstreamPort: number;
  let proxy: PalisadeProxy;
  let proxyPort: number;

  beforeAll(async () => {
    mockUpstreamPort = await getAvailablePort();
    mockUpstream = createMockUpstream({ body: ANTHROPIC_RESPONSE });
    await new Promise<void>((resolve) => mockUpstream.listen(mockUpstreamPort, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
  });

  describe('block (rewrite default)', () => {
    beforeAll(async () => {
      ({ proxy, port: proxyPort } = await startProxy(mockUpstreamPort, tier3Policy()));
    });
    afterAll(async () => {
      await proxy.stop();
    });

    it('strips the violating tool_use block and injects a text notice (HTTP 200)', async () => {
      const res = await sendRequest({ port: proxyPort, body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] } });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-palisade-gate-action')).toBe('block');
      expect(res.headers.get('x-palisade-policy-violation')).toContain('capability.network_egress');

      const body = (await res.json()) as { content: Array<{ type: string; id?: string; text?: string; name?: string }> };
      const toolUses = body.content.filter((b) => b.type === 'tool_use');
      expect(toolUses).toHaveLength(1);
      expect(toolUses[0].id).toBe('toolu_ok');
      const notes = body.content.filter((b) => b.type === 'text');
      expect(notes.some((n) => n.text?.includes('Palisade blocked'))).toBe(true);
    });
  });

  describe('hard block (block_response: true)', () => {
    beforeAll(async () => {
      ({ proxy, port: proxyPort } = await startProxy(mockUpstreamPort, tier3Policy({ block_response: true })));
    });
    afterAll(async () => {
      await proxy.stop();
    });

    it('returns 403 policy_violation and discards the response', async () => {
      const res = await sendRequest({ port: proxyPort, body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] } });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { type: string; verdict: string } };
      expect(body.error.type).toBe('policy_violation');
      expect(body.error.verdict).toBe('block');
    });
  });

  describe('warn action', () => {
    beforeAll(async () => {
      ({ proxy, port: proxyPort } = await startProxy(mockUpstreamPort, tier3Policy({ action: 'warn' })));
    });
    afterAll(async () => {
      await proxy.stop();
    });

    it('passes the response through unchanged but flags the violation', async () => {
      const res = await sendRequest({ port: proxyPort, body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] } });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-palisade-gate-action')).toBe('warn');
      expect(res.headers.get('x-palisade-policy-violation')).toBeTruthy();

      const body = (await res.json()) as { content: Array<{ type: string; id?: string }> };
      const toolUses = body.content.filter((b) => b.type === 'tool_use');
      expect(toolUses.map((t) => t.id)).toEqual(['toolu_evil', 'toolu_ok']);
    });
  });

  describe('disabled tier3', () => {
    beforeAll(async () => {
      ({ proxy, port: proxyPort } = await startProxy(mockUpstreamPort, defaultPolicy));
    });
    afterAll(async () => {
      await proxy.stop();
    });

    it('passes the response through byte-identical with no gate headers', async () => {
      const res = await sendRequest({ port: proxyPort, body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] } });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-palisade-gate-action')).toBeNull();
      expect(res.headers.get('x-palisade-policy-violation')).toBeNull();
      const body = (await res.json()) as { content: Array<{ type: string; id?: string }> };
      expect(body.content.filter((b) => b.type === 'tool_use').map((t) => t.id)).toEqual(['toolu_evil', 'toolu_ok']);
    });
  });
});

describe('Tier 3 response gate — OpenAI non-streaming (T3-06)', () => {
  let mockUpstream: Server;
  let mockUpstreamPort: number;
  let proxy: PalisadeProxy;
  let proxyPort: number;

  beforeAll(async () => {
    mockUpstreamPort = await getAvailablePort();
    mockUpstream = createMockUpstream({ body: OPENAI_RESPONSE });
    await new Promise<void>((resolve) => mockUpstream.listen(mockUpstreamPort, '127.0.0.1', resolve));
    ({ proxy, port: proxyPort } = await startProxy(mockUpstreamPort, tier3Policy()));
  });

  afterAll(async () => {
    await proxy.stop();
    await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
  });

  it('strips violating tool_calls and keeps compliant ones', async () => {
    const res = await sendRequest({
      port: proxyPort,
      path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test-fake' },
      body: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-palisade-gate-action')).toBe('block');

    const body = (await res.json()) as {
      choices: Array<{ message: { tool_calls?: Array<{ id: string }>; content?: string | null } }>;
    };
    const toolCalls = body.choices[0].message.tool_calls ?? [];
    expect(toolCalls.map((t) => t.id)).toEqual(['call_2']);
  });

  it('logs a policy_violation event with tier-3 matches', async () => {
    const dbPath = join(tmpdir(), `palisade-t3-06-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = new EventDatabase(dbPath);
    await db.initialize();
    const logger = new EventLogger(db);
    logger.close();

    const pPort = await getAvailablePort();
    const p = new PalisadeProxy(
      {
        port: pPort,
        host: '127.0.0.1',
        upstream: `http://127.0.0.1:${mockUpstreamPort}`,
        logLevel: 'error',
        dbPath,
        maxBodySize: 10 * 1024 * 1024,
        timeout: 300,
      },
      tier3Policy(),
    );
    await p.start();
    await sendRequest({
      port: pPort,
      path: '/v1/chat/completions',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test-fake' },
      body: { model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] },
    });
    await new Promise((r) => setTimeout(r, 100));
    await p.stop();

    const verifyDb = new EventDatabase(dbPath);
    await verifyDb.initialize();
    const verifyLogger = new EventLogger(verifyDb);
    const events: EventRecord[] = verifyLogger.queryEvents({});
    verifyLogger.close();
    verifyDb.close();
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    } catch {
      /* Windows cleanup */
    }

    const violations = events.filter((e) => e.event_type === 'policy_violation');
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations[0].action_taken).toBe('block');
    expect(violations[0].matches_json).toContain('network_egress');
  });
});
