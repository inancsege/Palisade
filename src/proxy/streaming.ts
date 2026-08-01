import type { ServerResponse } from 'node:http';
import type { LLMProvider } from './providers/base.js';
import type { StreamingGate } from './streaming-gate.js';
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
 *
 * When `gate` is provided, the stream is forwarded line-by-line so held events
 * (tool_use blocks) can be withheld and rewritten; without a gate the response is
 * piped chunk-by-chunk, byte-identical to the upstream.
 */
export async function pipeStreamingResponse(
  upstreamResponse: Response,
  clientRes: ServerResponse,
  provider: LLMProvider,
  onComplete: (fullText: string) => void,
  requestId?: string,
  gate?: StreamingGate | null,
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
  let cleanFinish = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        cleanFinish = true;
        break;
      }

      const chunk = decoder.decode(value, { stream: true });

      if (!gate) {
        clientRes.write(chunk);
        accumulateChunk(chunk);
        continue;
      }

      // Line-mode forwarding: gate each completed data payload.
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const writeLine = (l: string) => clientRes.write(l + '\n');
        const parsed = parseSSELine(line);
        if (!parsed) {
          writeLine(line);
          continue;
        }
        if (parsed.field === 'data') {
          if (parsed.value !== '[DONE]') {
            const text = provider.extractStreamingText(parsed.value);
            if (text) accumulatedText += text;
          }
          for (const payload of gate.process(parsed.value)) {
            clientRes.write(`data: ${payload}\n\n`);
          }
        } else {
          writeLine(line);
        }
      }
    }
  } catch (err) {
    logger.error(
      { err, requestId },
      'Error during streaming response piping',
    );
  } finally {
    // Always flush held payloads — also on error — so the client's SSE stream
    // terminates every tool block it already saw (held blocks must not vanish).
    // End markers ([DONE] / message_stop) are held by the gate and only re-emitted
    // here, after the held payloads, when the upstream ended the stream cleanly.
    if (gate) {
      for (const payload of gate.flush()) {
        clientRes.write(`data: ${payload}\n\n`);
      }
    }
    if (gate && buffer.length > 0 && cleanFinish) {
      // Trailing incomplete line after the final chunk.
      clientRes.write(buffer + '\n');
    }
    clientRes.end();
    onComplete(accumulatedText);
  }

  function accumulateChunk(chunk: string): void {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const parsed = parseSSELine(line);
      if (parsed?.field === 'data' && parsed.value !== '[DONE]') {
        const text = provider.extractStreamingText(parsed.value);
        if (text) accumulatedText += text;
      }
    }
  }
}
