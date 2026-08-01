import type { ExtractedText, ToolCall } from '../../types/proxy.js';

export interface LLMProvider {
  extractTexts(body: Record<string, unknown>): ExtractedText[];
  extractStreamingText(data: string): string | null;
  /** Extract tool calls from a non-streaming (completed) response body. */
  extractToolCalls(body: Record<string, unknown>): ToolCall[];
}

/**
 * Accumulates SSE events for ONE streaming response and yields tool calls the
 * moment they complete (Anthropic `content_block_stop`; OpenAI `finish_reason:
 * 'tool_calls'`). `ingest` receives the JSON-parsed SSE `data` payload.
 */
export interface StreamingToolCallAccumulator {
  ingest(event: unknown): ToolCall[];
  /** Flush any calls completed without an explicit terminal event (stream end). */
  finish(): ToolCall[];
}
