import type { VerdictAction } from './verdict.js';

export type ProviderType = 'anthropic' | 'openai' | 'unknown';

export interface ExtractedText {
  source: string;
  role: string;
  text: string;
}

/**
 * A tool call the model requested in a response. `arguments` is the parsed
 * invocation payload (Anthropic `input` object; OpenAI parsed `arguments` JSON).
 * When the JSON cannot be parsed (OpenAI), the raw string is preserved so the
 * capability classifier can still inspect it.
 */
export interface ToolCall {
  id?: string;
  name: string;
  arguments: unknown;
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
