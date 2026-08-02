import { describe, it, expect } from 'vitest';
import { PalisadeProxy } from '../../src/proxy/server.js';
import { defaultPolicy } from '../../src/policy/defaults.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { sendRequest, getAvailablePort } from '../helpers/http.js';
import { createMockUpstream } from '../helpers/mock-upstream.js';

async function startProxy(dashboard = true) {
  const mock = createMockUpstream({});
  const mPort = await getAvailablePort();
  await new Promise((r) => mock.listen(mPort, '127.0.0.1', r));

  const dbPath = join(tmpdir(), `palisade-t5-03-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const pPort = await getAvailablePort();
  const proxy = new PalisadeProxy(
    {
      port: pPort,
      host: '127.0.0.1',
      upstream: `http://127.0.0.1:${mPort}`,
      logLevel: 'error',
      dbPath,
      maxBodySize: 10 * 1024 * 1024,
      timeout: 300,
      dashboard,
    },
    defaultPolicy,
  );
  await proxy.start();

  return {
    proxy,
    proxyPort: pPort,
    dbPath,
    stop: async () => {
      await proxy.stop();
      await new Promise((r) => mock.close(r));
      try {
        if (existsSync(dbPath)) unlinkSync(dbPath);
      } catch {
        /* Windows cleanup */
      }
    },
  };
}

describe('Dashboard API (T5-03)', () => {
  it('serves JSON stats on /_palisade/stats', async () => {
    const s = await startProxy();
    const res = await fetch(`http://127.0.0.1:${s.proxyPort}/_palisade/stats`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const stats = await res.json();
    expect(typeof stats.totalRequests).toBe('number');
    expect(typeof stats.blockedCount).toBe('number');
    expect(stats.totalRequests).toBe(0);
    await s.stop();
  });

  it('serves JSON events on /_palisade/events after a proxied request', async () => {
    const s = await startProxy();
    await sendRequest({
      port: s.proxyPort,
      path: '/v1/messages',
      body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
    });
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`http://127.0.0.1:${s.proxyPort}/_palisade/events?limit=10`);
    expect(res.status).toBe(200);
    const events = await res.json();
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0].request_id).toBeTruthy();
    expect(events[0].action_taken).toBe('allow');
    await s.stop();
  });

  it('serves skill trust records on /_palisade/skills', async () => {
    const s = await startProxy();
    await sendRequest({
      port: s.proxyPort,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-test-fake',
        'anthropic-version': '2023-06-01',
        'x-palisade-skill': 'web-research',
      },
      path: '/v1/messages',
      body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
    });
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`http://127.0.0.1:${s.proxyPort}/_palisade/skills`);
    expect(res.status).toBe(200);
    const skills = await res.json();
    expect(Array.isArray(skills)).toBe(true);
    const skill = skills.find((sk: { skillId: string }) => sk.skillId === 'web-research');
    expect(skill).toBeDefined();
    expect(skill.totalRequests).toBe(1);
    expect(skill.trustScore).toBe(1.0);
    await s.stop();
  });

  it('returns 404 for unknown dashboard routes', async () => {
    const s = await startProxy();
    const res = await fetch(`http://127.0.0.1:${s.proxyPort}/_palisade/nope`);
    expect(res.status).toBe(404);
    await s.stop();
  });

  it('forwards non-dashboard paths to upstream when dashboard is disabled', async () => {
    const s = await startProxy(false);
    const res = await sendRequest({
      port: s.proxyPort,
      path: '/v1/messages',
      body: { model: 'x', messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(res.status).toBe(200);
    await s.stop();
  });
});