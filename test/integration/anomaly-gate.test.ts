import { describe, it, expect } from 'vitest';
import { PalisadeProxy } from '../../src/proxy/server.js';
import { defaultPolicy } from '../../src/policy/defaults.js';
import { EventDatabase } from '../../src/logging/database.js';
import { EventLogger } from '../../src/logging/events.js';
import type { EventRecord } from '../../src/types/events.js';
import type { PolicyConfig } from '../../src/types/policy.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { sendRequest, getAvailablePort } from '../helpers/http.js';
import { createMockUpstream } from '../helpers/mock-upstream.js';

function anomalyPolicy(): PolicyConfig {
  return {
    ...defaultPolicy,
    detection: {
      ...defaultPolicy.detection,
      tier3: { ...defaultPolicy.detection.tier3, enabled: true },
    },
    tools: {
      'weather-lookup': { network_egress: { allow: ['api.openweathermap.org'] } },
    },
  };
}

function egressResponse(host: string, callCount: number): Record<string, unknown> {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'text', text: 'Checking.' },
      ...Array.from({ length: callCount }, (_, i) => ({
        type: 'tool_use',
        id: `toolu_${i}`,
        name: 'weather-lookup',
        input: { url: `https://${host}/x?q=${i}` },
      })),
    ],
    model: 'test',
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

async function queryEvents(dbPath: string): Promise<EventRecord[]> {
  const db = new EventDatabase(dbPath);
  await db.initialize();
  const logger = new EventLogger(db);
  const events = logger.queryEvents({});
  logger.close();
  db.close();
  try {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  } catch {
    /* Windows cleanup */
  }
  return events;
}

describe('Egress anomaly gate (T4-05)', () => {
  it('logs an anomaly_detected burst event when the same allow-listed host is called 5x in one window', async () => {
    const mock = createMockUpstream({ body: egressResponse('api.openweathermap.org', 5) });
    const mPort = await getAvailablePort();
    await new Promise((r) => mock.listen(mPort, '127.0.0.1', r));

    const dbPath = join(tmpdir(), `palisade-t4-05-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
      },
      anomalyPolicy(),
    );
    await proxy.start();

    const res = await sendRequest({
      port: pPort,
      path: '/v1/messages',
      body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    await proxy.stop();
    await new Promise((r) => mock.close(r));

    const events = await queryEvents(dbPath);
    const anomalies = events.filter((e) => e.event_type === 'anomaly_detected');
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    expect(anomalies[0].action_taken).toBe('warn');
    expect(anomalies[0].metadata_json).toContain('burst');
    expect(anomalies[0].metadata_json).toContain('api.openweathermap.org');
  });

  it('stays quiet below the burst threshold', async () => {
    const mock = createMockUpstream({ body: egressResponse('api.openweathermap.org', 2) });
    const mPort = await getAvailablePort();
    await new Promise((r) => mock.listen(mPort, '127.0.0.1', r));

    const dbPath = join(tmpdir(), `palisade-t4-05b-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
      },
      anomalyPolicy(),
    );
    await proxy.start();
    await sendRequest({
      port: pPort,
      path: '/v1/messages',
      body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
    });
    await new Promise((r) => setTimeout(r, 100));
    await proxy.stop();
    await new Promise((r) => mock.close(r));

    const events = await queryEvents(dbPath);
    expect(events.filter((e) => e.event_type === 'anomaly_detected')).toEqual([]);
  });
});
