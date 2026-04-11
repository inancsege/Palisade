import { createServer, type Server } from 'node:http';

export interface MockUpstreamOptions {
  status?: number;
  body?: Record<string, unknown>;
  latencyMs?: number;
  streaming?: boolean;
  errorOnConnect?: boolean;
  streamChunks?: Array<{ data: string; delayMs?: number }>;
  abortAfterChunks?: number;
}

const DEFAULT_RESPONSE = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'Mock response' }],
  model: 'test',
  usage: { input_tokens: 10, output_tokens: 5 },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMockUpstream(options: MockUpstreamOptions = {}): Server {
  const {
    status = 200,
    body = DEFAULT_RESPONSE,
    latencyMs = 0,
    streaming = false,
    errorOnConnect = false,
    streamChunks,
    abortAfterChunks,
  } = options;

  return createServer((req, res) => {
    if (errorOnConnect) {
      req.destroy();
      return;
    }

    let reqBody = '';
    req.on('data', (chunk) => (reqBody += chunk));
    req.on('end', () => {
      const respond = async () => {
        if (streaming) {
          res.writeHead(status, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });

          if (streamChunks) {
            for (let i = 0; i < streamChunks.length; i++) {
              if (abortAfterChunks !== undefined && i >= abortAfterChunks) {
                res.destroy();
                return;
              }
              const chunk = streamChunks[i];
              if (chunk.delayMs) {
                await delay(chunk.delayMs);
              }
              res.write(`data: ${chunk.data}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.write(`data: ${JSON.stringify(body)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
        } else {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        }
      };

      if (latencyMs > 0) {
        setTimeout(() => {
          respond().catch(() => {
            /* latency + async respond error ignored */
          });
        }, latencyMs);
      } else {
        respond().catch(() => {
          /* async respond error ignored */
        });
      }
    });
  });
}
