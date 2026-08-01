import type { ExtractedText, ToolCall } from '../../types/proxy.js';

export interface LLMProvider {
  extractTexts(body: Record<string, unknown>): ExtractedText[];
  extractStreamingText(data: string): string | null;
  /** Extract tool calls from a non-streaming (completed) response body. */
  extractToolCalls(body: Record<string, unknown>): ToolCall[];
}
