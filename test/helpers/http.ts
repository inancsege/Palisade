import { createServer } from 'node:http';

export function getAvailablePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface SendRequestOptions {
  port: number;
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

export function sendRequest(options: SendRequestOptions): Promise<Response> {
  const {
    port,
    path = '/v1/messages',
    method = 'POST',
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': 'sk-test-fake',
      'anthropic-version': '2023-06-01',
    },
    body,
  } = options;

  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
