import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { pipeStreamingResponse } from '../../../src/proxy/streaming.js';
import { logger } from '../../../src/utils/logger.js';
import type { ServerResponse } from 'node:http';
import type { LLMProvider } from '../../../src/proxy/providers/base.js';

function createFailingResponse(): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"text":"partial"}}\n\n'));
      controller.error(new Error('stream interrupted'));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function createMockServerResponse(): ServerResponse {
  return {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
}

function createMockProvider(): LLMProvider {
  return {
    extractTexts: vi.fn().mockReturnValue([]),
    extractStreamingText: vi.fn().mockReturnValue('partial'),
  };
}

describe('SECF-03/SECF-04: Error visibility in streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs error via logger.error when reader.read() throws during streaming', async () => {
    const failingRes = createFailingResponse();
    const mockRes = createMockServerResponse();
    const mockProvider = createMockProvider();
    const onComplete = vi.fn();

    await pipeStreamingResponse(failingRes, mockRes, mockProvider, onComplete, 'test-req-id');

    expect(logger.error).toHaveBeenCalled();
    const callArgs = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0]).toHaveProperty('err');
    expect(callArgs[0]).toHaveProperty('requestId', 'test-req-id');
    expect(callArgs[1]).toBe('Error during streaming response piping');
  });

  it('still calls onComplete with accumulated text after stream error', async () => {
    const failingRes = createFailingResponse();
    const mockRes = createMockServerResponse();
    const mockProvider = createMockProvider();
    const onComplete = vi.fn();

    await pipeStreamingResponse(failingRes, mockRes, mockProvider, onComplete, 'test-req-id');

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(typeof onComplete.mock.calls[0][0]).toBe('string');
  });

  it('passes requestId in the logger.error context object', async () => {
    const failingRes = createFailingResponse();
    const mockRes = createMockServerResponse();
    const mockProvider = createMockProvider();
    const onComplete = vi.fn();

    await pipeStreamingResponse(failingRes, mockRes, mockProvider, onComplete, 'my-request-123');

    expect(logger.error).toHaveBeenCalled();
    const context = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(context.requestId).toBe('my-request-123');
  });
});
