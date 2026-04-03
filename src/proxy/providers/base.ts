import type { ExtractedText } from '../../types/proxy.js';

export interface LLMProvider {
  extractTexts(body: Record<string, unknown>): ExtractedText[];
  extractStreamingText(data: string): string | null;
}
