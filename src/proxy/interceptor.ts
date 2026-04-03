import type { IncomingMessage } from 'node:http';

export async function bufferRequestBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;

    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > maxBytes) {
        req.destroy();
        reject(new Error(`Request body exceeds maximum size of ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

export function isStreamingResponse(headers: Record<string, string | string[] | undefined>): boolean {
  const contentType = headers['content-type'];
  if (typeof contentType === 'string') {
    return contentType.includes('text/event-stream');
  }
  return false;
}

export function buildUpstreamUrl(upstream: string, originalPath: string): string {
  // Remove trailing slash from upstream, add original path
  const base = upstream.replace(/\/$/, '');
  return `${base}${originalPath}`;
}

export function filterHeaders(
  headers: Record<string, string | string[] | undefined>,
  excludeKeys: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  const excludeSet = new Set(excludeKeys.map((k) => k.toLowerCase()));

  for (const [key, value] of Object.entries(headers)) {
    if (excludeSet.has(key.toLowerCase())) continue;
    if (value === undefined) continue;
    result[key] = Array.isArray(value) ? value.join(', ') : value;
  }

  return result;
}
