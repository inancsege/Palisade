import type { ServerResponse } from 'node:http';
import type { LLMProvider } from './providers/base.js';
import { logger } from '../utils/logger.js';

export interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
}

export function parseSSELine(line: string): { field: string; value: string } | null {
  if (line.startsWith(':')) return null; // comment
  const colonIndex = line.indexOf(':');
  if (colonIndex === -1) return { field: line, value: '' };
  const field = line.slice(0, colonIndex);
  const value = line.slice(colonIndex + 1).replace(/^ /, '');
  return { field, value };
}

/**
 * Pipe a streaming SSE response from upstream to the client,
 * accumulating text content for post-hoc logging.
 */
export async function pipeStreamingResponse(
  upstreamResponse: Response,
  clientRes: ServerResponse,
  provider: LLMProvider,
  onComplete: (fullText: string) => void,
  requestId?: string,
): Promise<void> {
  if (!upstreamResponse.body) {
    clientRes.end();
    onComplete('');
    return;
  }

  // Write status + headers
  clientRes.writeHead(
    upstreamResponse.status,
    Object.fromEntries(upstreamResponse.headers.entries()),
  );

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let accumulatedText = '';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      clientRes.write(chunk);

      // Parse SSE events from the chunk to extract text
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // keep incomplete line in buffer

      for (const line of lines) {
        const parsed = parseSSELine(line);
        if (parsed?.field === 'data' && parsed.value !== '[DONE]') {
          const text = provider.extractStreamingText(parsed.value);
          if (text) accumulatedText += text;
        }
      }
    }
  } catch (err) {
    logger.error(
      { err, requestId },
      'Error during streaming response piping',
    );
  } finally {
    clientRes.end();
    onComplete(accumulatedText);
  }
}
