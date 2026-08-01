import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ProxyConfig, BlockedResponse, ProviderType } from '../types/proxy.js';
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
import { ResponseGate, type GateResult, type GateViolation } from './response-gate.js';
import { createStreamingGate } from './streaming-gate.js';
import {
  CanaryStore,
  CanaryTextScanner,
  injectCanaryToken,
  scanForCanary,
} from './canary.js';
import { EgressAnomalyTracker } from './egress-anomaly.js';
import type { PatternMatch, VerdictAction } from '../types/verdict.js';
import { logger } from '../utils/logger.js';

export class PalisadeProxy {
  private server: Server | null = null;
  private config: ProxyConfig;
  private policy: PolicyConfig;
  private engine: DetectionEngine;
  private db: EventDatabase;
  private eventLogger: EventLogger | null = null;
  private responseGate: ResponseGate | null = null;
  private canaryStore: CanaryStore;
  private egressTracker: EgressAnomalyTracker;

  constructor(config: ProxyConfig, policy: PolicyConfig) {
    this.config = config;
    this.policy = policy;
    this.engine = new DetectionEngine(policy.detection);
    this.db = new EventDatabase(config.dbPath);
    // Tier 3 response-side gate is opt-in via detection.tier3.enabled (T3-06).
    this.responseGate = policy.detection.tier3.enabled ? new ResponseGate(policy) : null;
    // Canary tokens are always generated; disabled stores simply return no token (T4-01).
    this.canaryStore = new CanaryStore({
      enabled: policy.detection.canary.enabled,
      rotateIntervalSeconds: policy.detection.canary.rotate_interval,
    });
    // Cross-request egress anomaly tracking (T4-04) — fed from Tier 3 gate evaluations.
    this.egressTracker = new EgressAnomalyTracker();
  }

  async start(): Promise<void> {
    await this.db.initialize();
    // D08 lifecycle: warm up the detection engine (Tier 2) BEFORE the server accepts traffic.
    // No-op without a model (Slice A); real ONNX warmup slots in here in Slice B.
    await this.engine.initialize();
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
    if (this.eventLogger) {
      this.eventLogger.close();
    }
    // Release the detection engine's (future) Tier 2 session. Safe pre-init / when never started.
    await this.engine.close();
    return new Promise((resolve) => {
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

  /**
   * Apply a Tier 3 gate verdict to an in-flight non-streaming response:
   * adds violation headers, logs the event, and hard-blocks when configured.
   */
  private applyGateResult(
    res: ServerResponse,
    responseHeaders: Record<string, string>,
    gateResult: GateResult,
    requestId: string,
    providerType: ProviderType,
    req: IncomingMessage,
  ): void {
    responseHeaders['x-palisade-gate-action'] = gateResult.action;
    responseHeaders['x-palisade-policy-violation'] = gateResult.matches
      .map((m) => m.patternId)
      .join(',');

    this.logGateEvent(requestId, gateResult.action, gateResult.matches, gateResult.threatScore, gateResult.violations, providerType, req, 'non-streaming');

    if (gateResult.hardBlock) {
      const blocked: BlockedResponse = {
        error: {
          type: 'policy_violation',
          message: `Palisade blocked the response: ${gateResult.violations.length} policy violation(s) in tool call(s): ${gateResult.violations.map((v) => v.tool).join(', ')}`,
          verdict: 'block',
          threatScore: gateResult.threatScore,
          requestId,
        },
      };
      res.writeHead(403, {
        'Content-Type': 'application/json',
        'X-Palisade-Request-Id': requestId,
        'X-Palisade-Gate-Action': 'block',
      });
      res.end(JSON.stringify(blocked));
      logger.warn(
        { requestId, violations: gateResult.violations.length, threatScore: gateResult.threatScore },
        'Response hard-blocked by policy gate',
      );
    } else {
      logger.warn(
        { requestId, violations: gateResult.violations.length, threatScore: gateResult.threatScore, modified: gateResult.modified },
        'Response gated by policy',
      );
    }
  }

  /** Shared policy-violation event logging for both streaming and non-streaming gates. */
  private logGateEvent(
    requestId: string,
    action: VerdictAction,
    matches: PatternMatch[],
    threatScore: number,
    violations: GateViolation[],
    providerType: ProviderType,
    req: IncomingMessage,
    gate: 'streaming' | 'non-streaming',
  ): void {
    setImmediate(() => {
      try {
        this.eventLogger?.logEvent({
          requestId,
          eventType: 'policy_violation',
          provider: providerType,
          actionTaken: action,
          threatScore,
          matches,
          requestPath: req.url ?? null,
          sourceIp: req.socket.remoteAddress ?? null,
          policyFile: this.config.policyPath ?? null,
          metadata: {
            gate,
            tools: violations.map((v) => v.tool),
          },
        });
      } catch (logErr) {
        logger.error({ err: logErr, requestId }, 'Failed to log policy violation');
      }
    });
  }

  /** T4-04: feed the egress anomaly tracker and log any anomalies as events. */
  private recordEgressHosts(
    requestId: string,
    sourceIp: string | null,
    hosts: string[],
    providerType: ProviderType,
    req: IncomingMessage,
  ): void {
    if (hosts.length === 0 || !sourceIp) return;
    for (const host of hosts) {
      for (const anomaly of this.egressTracker.recordEgress(sourceIp, host)) {
        setImmediate(() => {
          try {
            this.eventLogger?.logEvent({
              requestId,
              eventType: 'anomaly_detected',
              provider: providerType,
              actionTaken: 'warn',
              threatScore: 0,
              requestPath: req.url ?? null,
              sourceIp,
              policyFile: this.config.policyPath ?? null,
              metadata: { anomaly: anomaly.kind, host: anomaly.host, count: anomaly.count },
            });
          } catch (logErr) {
            logger.error({ err: logErr, requestId }, 'Failed to log egress anomaly');
          }
        });
        logger.warn(
          { requestId, sourceIp, anomaly: anomaly.kind, host: anomaly.host, count: anomaly.count },
          `Egress anomaly detected: ${anomaly.kind}`,
        );
      }
    }
  }

  /** T4-03: record a canary token hit (exfiltration evidence) as a canary_triggered event. */
  private logCanaryEvent(
    requestId: string,
    token: string,
    providerType: ProviderType,
    req: IncomingMessage,
    gate: 'streaming' | 'non-streaming',
  ): void {
    setImmediate(() => {
      try {
        this.eventLogger?.logEvent({
          requestId,
          eventType: 'canary_triggered',
          provider: providerType,
          actionTaken: 'block',
          threatScore: 1,
          matches: [{
            patternId: 'canary-token',
            description: 'Canary token detected in response content (possible data exfiltration)',
            tier: 3,
            category: 'exfiltration',
            confidence: 1,
            weight: 1,
            matchedText: token,
            offset: -1,
            length: token.length,
          }],
          requestPath: req.url ?? null,
          sourceIp: req.socket.remoteAddress ?? null,
          policyFile: this.config.policyPath ?? null,
          metadata: { gate },
        });
      } catch (logErr) {
        logger.error({ err: logErr, requestId }, 'Failed to log canary trigger');
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
    // Hoisted so canary injection (after detection) can reuse the parsed body.
    let body: Record<string, unknown> | null = null;

    // Only scan if there's a body to scan (POST requests with JSON)
    if (rawBody.length > 0 && req.method === 'POST') {
      try {
        body = JSON.parse(rawBody.toString('utf-8'));
        const extractedTexts = provider.extractTexts(body!);

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
              'X-Palisade-Tiers': detectionResult.tiersExecuted.join(','),
            });
            res.end(JSON.stringify(blocked));
            logger.warn(
              { requestId, threatScore: detectionResult.threatScore.overall, matchCount: detectionResult.matches.length },
              'Request blocked',
            );
            return;
          }
        }
      } catch {
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

    // T4-02: canary injection runs AFTER request-side scanning so the token never
    // trips the pattern engine; the forwarded body carries the active token.
    const canaryToken = this.canaryStore.currentToken();
    if (canaryToken && body) {
      const injected = injectCanaryToken(body, provider, canaryToken);
      if (injected !== body) {
        rawBody = Buffer.from(JSON.stringify(injected));
        forwardHeaders['content-length'] = String(rawBody.length);
      }
    }

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method: req.method ?? 'GET',
        headers: forwardHeaders,
        body: rawBody.length > 0 ? rawBody : undefined,
        signal: AbortSignal.timeout(this.config.timeout * 1000),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            type: 'upstream_timeout',
            message: `Upstream request timed out after ${this.config.timeout}s`,
          },
        }));
        return;
      }
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
      // T2-08: additive header reporting which tiers ran ('1' or '1,2'). v0.1 headers unchanged.
      responseHeaders['x-palisade-tiers'] = detectionResult.tiersExecuted.join(',');
    }

    // Handle streaming vs non-streaming response
    if (isStreamingResponse(responseHeaders)) {
      // T3-07: streaming hold-back gate (text deltas flow, tool_use blocks gated).
      const streamingGate = this.responseGate
        ? createStreamingGate(provider, this.responseGate)
        : null;
      // T4-03: scan streamed text for the canary token before it reaches the client.
      const canaryScanner = new CanaryTextScanner(this.canaryStore);
      await pipeStreamingResponse(upstreamRes, res, provider, (fullText) => {
        logger.debug({ requestId, streamedChars: fullText.length }, 'Streaming response complete');
      }, requestId, streamingGate, (text) => {
        const hit = canaryScanner.push(text);
        if (hit) {
          this.logCanaryEvent(requestId, hit, providerType, req, 'streaming');
          logger.warn(
            { requestId, canaryToken: hit, gate: 'streaming' },
            'Streaming response aborted: canary token in response content',
          );
          return false;
        }
        return true;
      });

      if (streamingGate) {
        const summary = streamingGate.summary();
        this.recordEgressHosts(requestId, req.socket.remoteAddress ?? null, summary.egressHosts, providerType, req);
        if (summary.matches.length > 0) {
          this.logGateEvent(requestId, summary.action, summary.matches, summary.threatScore, summary.violations, providerType, req, 'streaming');
          logger.warn(
            { requestId, violations: summary.violations.length, threatScore: summary.threatScore, gate: 'streaming' },
            'Streaming response gated by policy',
          );
        }
      }
    } else {
      const responseBody = Buffer.from(await upstreamRes.arrayBuffer());
      let bodyToSend = responseBody;

      // T3-06: response-side action gate for non-streaming JSON responses.
      if (this.responseGate && (responseHeaders['content-type'] ?? '').includes('application/json')) {
        try {
          const parsed = JSON.parse(responseBody.toString('utf-8'));
          const gateResult = this.responseGate.gateNonStreaming(parsed, provider);
          this.recordEgressHosts(requestId, req.socket.remoteAddress ?? null, gateResult.egressHosts, providerType, req);
          if (gateResult.action !== 'allow') {
            this.applyGateResult(res, responseHeaders, gateResult, requestId, providerType, req);
            if (gateResult.hardBlock) return;
            if (gateResult.modified && gateResult.body) {
              bodyToSend = Buffer.from(JSON.stringify(gateResult.body));
              // The rewritten body has a different length than the upstream body:
              // a stale Content-Length (or transfer-encoding) would make the client
              // wait for bytes that never arrive. Node recomputes it on end().
              delete responseHeaders['content-length'];
              delete responseHeaders['transfer-encoding'];
            }
          }
        } catch {
          // Unparseable or non-object body: pass through unchanged.
        }
      }

      // T4-03: a canary token in the response is exfiltration evidence — hard-block.
      const canaryHit = scanForCanary(bodyToSend.toString('utf-8'), this.canaryStore);
      if (canaryHit) {
        this.logCanaryEvent(requestId, canaryHit, providerType, req, 'non-streaming');
        const blocked: BlockedResponse = {
          error: {
            type: 'canary_detected',
            message: 'Palisade blocked this response: canary token detected in response content (possible data exfiltration)',
            verdict: 'block',
            threatScore: 1,
            requestId,
          },
        };
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'X-Palisade-Request-Id': requestId,
          'X-Palisade-Gate-Action': 'block',
        });
        res.end(JSON.stringify(blocked));
        logger.warn(
          { requestId, canaryToken: canaryHit, gate: 'non-streaming' },
          'Response hard-blocked: canary token in response content',
        );
        return;
      }

      res.writeHead(upstreamRes.status, responseHeaders);
      res.end(bodyToSend);
    }

    const elapsed = performance.now() - startTime;
    logger.debug({ requestId, elapsed: elapsed.toFixed(2), verdict: detectionResult?.action ?? 'passthrough' }, 'Request handled');
  }
}
