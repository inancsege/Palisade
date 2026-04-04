import type { VerdictAction } from './verdict.js';

export type ProviderType = 'anthropic' | 'openai' | 'unknown';

export interface ExtractedText {
  source: string;
  role: string;
  text: string;
}

export interface ProxyRequest {
  requestId: string;
  provider: ProviderType;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody: Buffer;
  extractedTexts: ExtractedText[];
  receivedAt: Date;
}

export interface ProxyResponse {
  requestId: string;
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody: Buffer;
  isStreaming: boolean;
}

export interface ProxyConfig {
  port: number;
  upstream: string;
  host: string;
  policyPath?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  dbPath: string;
  maxBodySize: number;
  timeout: number; // seconds
}

export interface BlockedResponse {
  error: {
    type: 'prompt_injection_detected' | 'unparseable_body';
    message: string;
    verdict: VerdictAction;
    threatScore: number;
    requestId: string;
  };
}
