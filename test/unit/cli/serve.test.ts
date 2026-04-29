import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import { serveCommand } from '../../../src/cli/commands/serve.js';
import { runCli, ExitError, spyOnProcessOn } from '../../helpers/cli.js';
import { getAvailablePort, sendRequest } from '../../helpers/http.js';
import { createMockUpstream } from '../../helpers/mock-upstream.js';
import { anthropicBody } from '../../helpers/factories.js';

// NOTE: serveCommand is itself the Commander sub-Command (named 'serve'), and
// runCli prepends ['node', 'palisade', ...]. Calling parseAsync directly on a
// sub-Command treats it as the root, so the argv passed here MUST NOT include
// the literal 'serve' subcommand token. We pass options only.
//
// Lifecycle subtlety: serve.ts's action awaits proxy.start() then runs
// printStartup() and returns. parseAsync resolves at that point, but the
// underlying http.Server keeps the event loop alive. The shutdown only fires
// when the captured SIGINT/SIGTERM handler runs (which calls process.exit(0)).
// Because runCli mockRestores process.exit when it returns, every place we
// invoke the captured shutdown -- whether intentionally in a test body OR
// best-effort in afterEach -- MUST first re-stub process.exit to throw
// ExitError so the Vitest worker is not killed.

let mockUpstream: Server;
let mockUpstreamPort: number;
let proxyPort: number;
let onSpyState: ReturnType<typeof spyOnProcessOn>;
// Tracks whether the captured SIGINT/SIGTERM shutdown has already been invoked
// by the test body. When true, afterEach must NOT re-invoke it (the proxy is
// already stopped). Reset to false after every test.
let shutdownAlreadyRun = false;

beforeEach(async () => {
  mockUpstreamPort = await getAvailablePort();
  mockUpstream = createMockUpstream();
  await new Promise<void>((resolve) => {
    mockUpstream.listen(mockUpstreamPort, '127.0.0.1', resolve);
  });
  proxyPort = await getAvailablePort();
  onSpyState = spyOnProcessOn();
});

afterEach(async () => {
  // Always restore the process.on spy first.
  onSpyState.restore();

  // Best-effort: if a captured SIGINT handler exists AND the test body did NOT
  // already invoke it, run it now to release the proxy port. The shutdown calls
  // process.exit(0) which would normally kill the Vitest worker -- so re-stub
  // process.exit to throw ExitError just for this invocation.
  if (!shutdownAlreadyRun && onSpyState.sigintHandlers.length > 0) {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: string | number | null) => {
        throw new ExitError(typeof code === 'number' ? code : 0);
      }) as never);
    try {
      await onSpyState.sigintHandlers[0]();
    } catch {
      // ExitError or already-stopped -- both are acceptable
    } finally {
      exitSpy.mockRestore();
    }
  }

  // Reset state for the next test
  shutdownAlreadyRun = false;
  onSpyState.sigintHandlers.length = 0;
  onSpyState.sigtermHandlers.length = 0;

  // Close mock-upstream
  await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
});

describe('serve command (CLIT-04)', () => {
  it('starts the proxy on an ephemeral port and forwards a request to upstream (full lifecycle)', async () => {
    const runResult = await runCli(serveCommand, [
      '-p',
      String(proxyPort),
      '-u',
      `http://127.0.0.1:${mockUpstreamPort}`,
      '--db',
      ':memory:',
      '--log-level',
      'error',
    ]);
    // runCli returns AFTER printStartup runs (parseAsync resolves there).
    // exitCode is null at this point because process.exit hasn't been called.
    expect(runResult.exitCode).toBeNull();

    // Both signal handlers should have been registered
    expect(onSpyState.sigintHandlers.length).toBeGreaterThan(0);
    expect(onSpyState.sigtermHandlers.length).toBeGreaterThan(0);

    // Fire one request through the running proxy to prove it's listening and configured
    const res = await sendRequest({ port: proxyPort, body: anthropicBody('Hello') });
    expect(res.status).toBe(200);

    // Trigger graceful shutdown via captured handler. The handler calls
    // process.exit(0) which we re-stub to throw ExitError(0) so the test
    // worker is not killed and we can verify the exit CODE specifically.
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: string | number | null) => {
        throw new ExitError(typeof code === 'number' ? code : 0);
      }) as never);
    try {
      // Verify exit code is 0 (clean shutdown), not just that some ExitError was thrown
      await expect(onSpyState.sigintHandlers[0]()).rejects.toMatchObject({ code: 0 });
    } finally {
      exitSpy.mockRestore();
    }
    // Mark that the test body already ran the shutdown; afterEach must not re-invoke it.
    shutdownAlreadyRun = true;
    onSpyState.sigintHandlers.length = 0;
  });

  it('registers the SIGTERM handler with the same shutdown function', async () => {
    await runCli(serveCommand, [
      '-p',
      String(proxyPort),
      '-u',
      `http://127.0.0.1:${mockUpstreamPort}`,
      '--db',
      ':memory:',
      '--log-level',
      'error',
    ]);
    expect(onSpyState.sigintHandlers.length).toBeGreaterThan(0);
    expect(onSpyState.sigtermHandlers.length).toBeGreaterThan(0);
    // serve.ts:46-47 registers the SAME shutdown function for both -- assert reference equality
    expect(onSpyState.sigtermHandlers[0]).toBe(onSpyState.sigintHandlers[0]);

    // Invoke SIGTERM and assert exit. Re-stub process.exit so the test worker survives.
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: string | number | null) => {
        throw new ExitError(typeof code === 'number' ? code : 0);
      }) as never);
    try {
      await expect(onSpyState.sigtermHandlers[0]()).rejects.toThrow(ExitError);
    } finally {
      exitSpy.mockRestore();
    }
    // SIGINT handler is the same reference as SIGTERM handler, so the proxy is now
    // stopped. Tell afterEach not to re-invoke.
    shutdownAlreadyRun = true;
    onSpyState.sigintHandlers.length = 0;
  });

  it('exits 1 with logged error when --policy points to a missing file', async () => {
    const result = await runCli(serveCommand, [
      '-p',
      String(proxyPort),
      '-u',
      `http://127.0.0.1:${mockUpstreamPort}`,
      '--policy',
      '/path/that/does/not/exist/policy.yaml',
      '--db',
      ':memory:',
      '--log-level',
      'error',
    ]);
    expect(result.exitCode).toBe(1);
    // proxy.start() was never called -- no SIGINT registration
    expect(onSpyState.sigintHandlers.length).toBe(0);
  });

  it('loads policy from a valid --policy <path>', async () => {
    const result = await runCli(serveCommand, [
      '-p',
      String(proxyPort),
      '-u',
      `http://127.0.0.1:${mockUpstreamPort}`,
      '--policy',
      'policy.example.yaml',
      '--db',
      ':memory:',
      '--log-level',
      'error',
    ]);
    expect(result.exitCode).toBeNull();
    expect(onSpyState.sigintHandlers.length).toBeGreaterThan(0);
    // Cleanup runs in afterEach via the captured SIGINT handler (shutdownAlreadyRun stays false)
  });

  it('exits 1 when proxy.start() fails (db init error on non-sqlite file)', async () => {
    // DEVIATION from plan: the plan asked for an EADDRINUSE-based test. That
    // path does not work here because PalisadeProxy.start() does not wire the
    // http.Server 'error' event into the listen() Promise -- so on EADDRINUSE
    // the start() Promise never resolves NOR rejects (it hangs forever) and
    // the listen error becomes an unhandled exception on the Vitest worker.
    // That is a pre-existing source-level bug in src/proxy/server.ts (out of
    // scope per Plan 08-01 D-03 "zero source-under-test changes"). To still
    // exercise the proxy.start() failure -> process.exit(1) branch, we point
    // --db at a non-SQLite file (package.json). EventDatabase.initialize()
    // throws DatabaseError when SQL.Database(buffer) cannot parse the file,
    // proxy.start() rejects synchronously, and serve.ts:55 calls process.exit(1).
    const result = await runCli(serveCommand, [
      '-p',
      String(proxyPort),
      '-u',
      `http://127.0.0.1:${mockUpstreamPort}`,
      '--db',
      'package.json',
      '--log-level',
      'error',
    ]);
    expect(result.exitCode).toBe(1);
  });

  it('passes config from CLI flags through to the running proxy', async () => {
    await runCli(serveCommand, [
      '-p',
      String(proxyPort),
      '-u',
      `http://127.0.0.1:${mockUpstreamPort}`,
      '--db',
      ':memory:',
      '--log-level',
      'error',
      '--timeout',
      '120',
    ]);
    const res = await sendRequest({ port: proxyPort, body: anthropicBody('What is 2+2?') });
    expect(res.status).toBe(200);
    // Confirm the proxy was the responder (Palisade adds these headers when detection ran)
    expect(res.headers.get('x-palisade-request-id')).toBeTruthy();
    expect(res.headers.get('x-palisade-verdict')).toBeTruthy();
    // afterEach will invoke the captured SIGINT handler to release the port
  });
});
