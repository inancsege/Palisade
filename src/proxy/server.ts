import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ProxyConfig, BlockedResponse } from '../types/proxy.js';
import type { PolicyConfig } from '../types/policy.js';
import type { DetectionResult } from '../types/verdict.js';
import { DetectionEngine } from '../detection/engine.js';
import { EventDatabase } from '../logging/database.js';
import { EventLogger } from '../logging/events.js';
import { detectProvider } from './providers/index.js';
import {
  bufferRequestBody,
  buildUpstreamUrl,
  filterHeaders,
  isStreamingResponse,
} from './interceptor.js';
import { pipeStreamingResponse } from './streaming.js';
import { logger } from '../utils/logger.js';

export class PalisadeProxy {
  private server: Server | null = null;
  private config: ProxyConfig;
  private policy: PolicyConfig;
  private engine: DetectionEngine;
  private db: EventDatabase;
  private eventLogger: EventLogger | null = null;

  constructor(config: ProxyConfig, policy: PolicyConfig) {
    this.config = config;
    this.policy = policy;
    this.engine = new DetectionEngine(policy.detection);
    this.db = new EventDatabase(config.dbPath);
  }

  async start(): Promise<void> {
    await this.db.initialize();
    this.eventLogger = new EventLogger(this.db);

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        logger.error({ err }, 'Unhandled proxy error');
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { type: 'proxy_error', message: 'Internal proxy error' } }));
        }
      });
    });

    return new Promise((resolve) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        logger.info(
          { port: this.config.port, host: this.config.host, upstream: this.config.upstream },
          'Palisade proxy started',
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.eventLogger) {
        this.eventLogger.close();
      }
      if (this.server) {
        this.server.close(() => {
          this.db.close();
          logger.info('Palisade proxy stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const startTime = performance.now();

    // Buffer the request body
    let rawBody: Buffer;
    try {
      rawBody = await bufferRequestBody(req, this.config.maxBodySize);
    } catch (err) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'payload_too_large', message: (err as Error).message } }));
      return;
    }

    // Detect provider and extract texts
    const headers = req.headers as Record<string, string | string[] | undefined>;
    const { type: providerType, provider } = detectProvider(this.config.upstream, headers);

    let detectionResult: DetectionResult | null = null;

    // Only scan if there's a body to scan (POST requests with JSON)
    if (rawBody.length > 0 && req.method === 'POST') {
      try {
        const body = JSON.parse(rawBody.toString('utf-8'));
        const extractedTexts = provider.extractTexts(body);

        if (extractedTexts.length > 0) {
          detectionResult = await this.engine.detect(extractedTexts, requestId);

          // Log the event asynchronously
          setImmediate(() => {
            try {
              this.eventLogger?.logEvent({
                requestId,
                eventType: detectionResult!.action === 'block' ? 'request_blocked'
                  : detectionResult!.action === 'warn' ? 'request_warned'
                  : 'request_scanned',
                provider: providerType,
                actionTaken: detectionResult!.action,
                threatScore: detectionResult!.threatScore.overall,
                matches: detectionResult!.matches,
                requestPath: req.url ?? null,
                sourceIp: req.socket.remoteAddress ?? null,
                policyFile: this.config.policyPath ?? null,
              });
            } catch (logErr) {
              logger.error(
                { err: logErr, requestId },
                'Failed to log detection event',
              );
            }
          });

          // Block if verdict says so
          if (detectionResult.action === 'block') {
            const blocked: BlockedResponse = {
              error: {
                type: 'prompt_injection_detected',
                message: `Palisade blocked this request: ${detectionResult.matches.length} injection pattern(s) detected with threat score ${detectionResult.threatScore.overall.toFixed(2)}`,
                verdict: 'block',
                threatScore: detectionResult.threatScore.overall,
                requestId,
              },
            };

            res.writeHead(403, {
              'Content-Type': 'application/json',
              'X-Palisade-Verdict': 'block',
              'X-Palisade-Request-Id': requestId,
              'X-Palisade-Threat-Score': detectionResult.threatScore.overall.toFixed(4),
            });
            res.end(JSON.stringify(blocked));
            logger.warn(
              { requestId, threatScore: detectionResult.threatScore.overall, matchCount: detectionResult.matches.length },
              'Request blocked',
            );
            return;
          }
        }
      } catch (parseErr) {
        // Per SECF-01: Content-Type is application/json but body failed JSON.parse
        // Treat as suspicious -- block with 403 instead of silently forwarding
        const contentType = req.headers['content-type'] ?? '';
        if (contentType.includes('application/json')) {
          logger.warn(
            { requestId, method: req.method, path: req.url, contentType },
            'Blocked request with unparseable JSON body',
          );
          const blocked: BlockedResponse = {
            error: {
              type: 'unparseable_body',
              message: 'Request Content-Type is application/json but body could not be parsed',
              verdict: 'block',
              threatScore: 0,
              requestId,
            },
          };
          res.writeHead(403, {
            'Content-Type': 'application/json',
            'X-Palisade-Request-Id': requestId,
          });
          res.end(JSON.stringify(blocked));
          return;
        }
        // Non-JSON content type -- fall through and forward as-is
      }
    }

    // Forward request to upstream
    const upstreamUrl = buildUpstreamUrl(this.config.upstream, req.url ?? '/');
    const forwardHeaders = filterHeaders(headers, ['host', 'connection', 'content-length', 'accept-encoding']);
    forwardHeaders['content-length'] = String(rawBody.length);
    forwardHeaders['accept-encoding'] = 'identity'; // Request uncompressed responses from upstream

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: req.method ?? 'GET',
        headers: forwardHeaders,
        body: rawBody.length > 0 ? rawBody : undefined,
      });
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: { type: 'upstream_error', message: `Failed to reach upstream: ${(err as Error).message}` },
      }));
      return;
    }

    // Add Palisade headers to response
    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      responseHeaders[key] = value;
    }
    if (detectionResult) {
      responseHeaders['x-palisade-verdict'] = detectionResult.action;
      responseHeaders['x-palisade-request-id'] = requestId;
      responseHeaders['x-palisade-threat-score'] = detectionResult.threatScore.overall.toFixed(4);
      responseHeaders['x-palisade-latency-ms'] = detectionResult.latencyMs.toFixed(2);
    }

    // Handle streaming vs non-streaming response
    if (isStreamingResponse(responseHeaders)) {
      await pipeStreamingResponse(upstreamRes, res, provider, (fullText) => {
        logger.debug({ requestId, streamedChars: fullText.length }, 'Streaming response complete');
      });
    } else {
      const responseBody = Buffer.from(await upstreamRes.arrayBuffer());
      res.writeHead(upstreamRes.status, responseHeaders);
      res.end(responseBody);
    }

    const elapsed = performance.now() - startTime;
    logger.debug({ requestId, elapsed: elapsed.toFixed(2), verdict: detectionResult?.action ?? 'passthrough' }, 'Request handled');
  }
}
