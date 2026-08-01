import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
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

function canaryPolicy(): PolicyConfig {
  return {
    ...defaultPolicy,
    detection: {
      ...defaultPolicy.detection,
      canary: { enabled: true, rotate_interval: 3600 },
    },
  };
}

/**
 * Echo upstream: answers with the request's injected system prompt as response
 * text, so a canary token the proxy injected comes back in the response —
 * exercising injection AND detection in one flow.
 */
function createEchoUpstream(options: { streaming?: boolean } = {}): Server {
  const { streaming = false } = options;
  return createServer((req, res) => {
    let reqBody = '';
    req.on('data', (c) => (reqBody += c));
    req.on('end', () => {
      let system = 'no system';
      try {
        const parsed = JSON.parse(reqBody);
        if (typeof parsed.system === 'string') system = parsed.system;
      } catch {
        /* echo fallback */
      }

      if (streaming) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'test' } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: system } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
        res.end();
        return;
      }

      const payload = JSON.stringify({
        id: 'msg_echo',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: system }],
        model: 'test',
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload)),
      });
      res.end(payload);
    });
  });
}

async function startProxy(
  upstreamPort: number,
  policy: PolicyConfig,
  dbPath: string,
): Promise<{ proxy: PalisadeProxy; port: number }> {
  const port = await getAvailablePort();
  const proxy = new PalisadeProxy(
    {
      port,
      host: '127.0.0.1',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      logLevel: 'error',
      dbPath,
      maxBodySize: 10 * 1024 * 1024,
      timeout: 300,
    },
    policy,
  );
  await proxy.start();
  return { proxy, port };
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

describe('Canary gate — non-streaming response (T4-03)', () => {
  let mock: Server;
  let mockPort: number;

  beforeAll(async () => {
    mockPort = await getAvailablePort();
    mock = createEchoUpstream();
    await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));
  });

  afterAll(async () => {
    await new Promise((r) => mock.close(r));
  });

  it('hard-blocks (403) when the response contains the injected canary token', async () => {
    const dbPath = join(tmpdir(), `palisade-t4-03-ns-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const { proxy, port } = await startProxy(mockPort, canaryPolicy(), dbPath);

    const res = await sendRequest({
      port,
      path: '/v1/messages',
      body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.type).toBe('canary_detected');
    expect(body.error.verdict).toBe('block');
    await proxy.stop();

    const events = await queryEvents(dbPath);
    const canaryEvents = events.filter((e) => e.event_type === 'canary_triggered');
    expect(canaryEvents.length).toBeGreaterThanOrEqual(1);
    expect(canaryEvents[0].action_taken).toBe('block');
    expect(canaryEvents[0].matches_json).toContain('palcanary-');
  });
});

describe('Canary gate — streaming response (T4-03)', () => {
  let mock: Server;
  let mockPort: number;

  beforeAll(async () => {
    mockPort = await getAvailablePort();
    mock = createEchoUpstream({ streaming: true });
    await new Promise((r) => mock.listen(mockPort, '127.0.0.1', r));
  });

  afterAll(async () => {
    await new Promise((r) => mock.close(r));
  });

  it('aborts the stream when the canary token appears in streamed text', async () => {
    const dbPath = join(tmpdir(), `palisade-t4-03-str-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const { proxy, port } = await startProxy(mockPort, canaryPolicy(), dbPath);

    const res = await sendRequest({
      port,
      path: '/v1/messages',
      body: { model: 'x', messages: [{ role: 'user', content: 'hi' }] },
    });
    const body = await res.text();

    expect(res.status).toBe(200);
    // The token-bearing delta must never reach the client; the stream is aborted.
    expect(body).not.toContain('palcanary-');
    expect(body).not.toContain('message_stop');
    await proxy.stop();

    const events = await queryEvents(dbPath);
    const canaryEvents = events.filter((e) => e.event_type === 'canary_triggered');
    expect(canaryEvents.length).toBeGreaterThanOrEqual(1);
    expect(canaryEvents[0].action_taken).toBe('block');
  });
});
