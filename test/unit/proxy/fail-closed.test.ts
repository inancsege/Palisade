import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PalisadeProxy } from '../../../src/proxy/server.js';
import { defaultPolicy } from '../../../src/policy/defaults.js';
import { createServer, type Server } from 'node:http';

let mockUpstream: Server;
let mockUpstreamPort: number;
let proxy: PalisadeProxy;
let proxyPort: number;

function getAvailablePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  mockUpstreamPort = await getAvailablePort();
  mockUpstream = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Mock response' }],
        model: 'test',
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    });
  });
  await new Promise<void>((resolve) => {
    mockUpstream.listen(mockUpstreamPort, '127.0.0.1', resolve);
  });

  proxyPort = await getAvailablePort();
  proxy = new PalisadeProxy(
    {
      port: proxyPort,
      host: '127.0.0.1',
      upstream: `http://127.0.0.1:${mockUpstreamPort}`,
      logLevel: 'error',
      dbPath: ':memory:',
      maxBodySize: 10 * 1024 * 1024,
    },
    defaultPolicy,
  );
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
});

describe('SECF-01: Fail-closed JSON parsing', () => {
  it('blocks POST with Content-Type application/json and unparseable body "not valid json"', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-test-fake',
      },
      body: 'not valid json at all',
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: { type: string } };
    expect(body.error.type).toBe('unparseable_body');
  });

  it('blocks POST with Content-Type application/json and malformed JSON body', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-test-fake',
      },
      body: '{malformed',
    });
    expect(res.status).toBe(403);
  });

  it('forwards POST with Content-Type text/plain and non-JSON body (status 200)', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'x-api-key': 'sk-test-fake',
      },
      body: 'not json',
    });
    expect(res.status).toBe(200);
  });

  it('forwards POST with Content-Type application/json and empty body (status 200)', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-test-fake',
      },
      body: '',
    });
    expect(res.status).toBe(200);
  });

  it('forwards GET request with no body (status 200)', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/models`, {
      headers: { 'x-api-key': 'sk-test-fake' },
    });
    expect(res.status).toBe(200);
  });

  it('returns correct BlockedResponse JSON shape on 403', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-test-fake',
      },
      body: 'not valid json',
    });
    expect(res.status).toBe(403);
    const body = await res.json() as {
      error: {
        type: string;
        message: string;
        verdict: string;
        threatScore: number;
        requestId: string;
      };
    };
    expect(body.error.type).toBe('unparseable_body');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message).toContain('application/json');
    expect(body.error.verdict).toBe('block');
    expect(body.error.threatScore).toBe(0);
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
  });

  it('returns X-Palisade-Request-Id header on 403 response', async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-test-fake',
      },
      body: '<<<not json>>>',
    });
    expect(res.status).toBe(403);
    const requestId = res.headers.get('X-Palisade-Request-Id');
    expect(requestId).toBeTruthy();
    expect(typeof requestId).toBe('string');
    expect(requestId!.length).toBeGreaterThan(0);
  });
});
