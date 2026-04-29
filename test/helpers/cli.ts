import { vi } from 'vitest';
import type { Command } from 'commander';

/**
 * Sentinel exception thrown by the spied process.exit so tests can capture
 * the exit code without actually terminating the Vitest worker.
 */
export class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code}) called`);
    this.name = 'ExitError';
  }
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Strips ANSI SGR escape sequences (chalk colors) from a string so tests can
 * make plain-text assertions against rendered CLI output.
 */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Monkey-patches process.stdout.write and process.stderr.write to capture
 * everything that goes through, including chalk-colorized output. Returns a
 * { readStdout, readStderr, restore } object. Callers MUST call restore() in
 * finally to avoid leaking patches into other tests.
 */
export function captureIo(): {
  readStdout: () => string;
  readStderr: () => string;
  restore: () => void;
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  // @ts-expect-error: signature compatibility
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  };
  // @ts-expect-error: signature compatibility
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  };
  return {
    readStdout: () => stdoutChunks.join(''),
    readStderr: () => stderrChunks.join(''),
    restore: () => {
      process.stdout.write = originalStdout;
      process.stderr.write = originalStderr;
    },
  };
}

/**
 * Runs a Commander command in-process via parseAsync, capturing stdout/stderr
 * and intercepting process.exit() calls (turned into an ExitError sentinel).
 *
 * Returns:
 * - exitCode: the numeric code passed to process.exit, or null if the action
 *   resolved without calling process.exit (e.g., audit/report success path)
 * - stdout / stderr: captured strings (may include ANSI escapes; pair with stripAnsi)
 *
 * Restores both the I/O patches and the process.exit spy in all paths,
 * including when the action throws something other than ExitError.
 */
export async function runCli(
  cmd: Command,
  argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const io = captureIo();
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new ExitError(typeof code === 'number' ? code : 0);
  }) as never);
  let exitCode: number | null = null;
  try {
    try {
      await cmd.parseAsync(['node', 'palisade', ...argv]);
    } catch (err) {
      if (err instanceof ExitError) {
        exitCode = err.code;
      } else {
        throw err;
      }
    }
  } finally {
    io.restore();
    exitSpy.mockRestore();
  }
  return { stdout: io.readStdout(), stderr: io.readStderr(), exitCode };
}

/**
 * Captures handlers registered via process.on('SIGINT'|'SIGTERM') without
 * actually attaching them to the real process EventEmitter. Required by the
 * serve-command lifecycle test (plan 02). Mock implementation MUST return
 * `process` so that chainable .on(...).on(...) calls (pino, sql.js init) do
 * not crash with "cannot read property 'on' of undefined".
 */
export function spyOnProcessOn(): {
  sigintHandlers: Array<() => void | Promise<void>>;
  sigtermHandlers: Array<() => void | Promise<void>>;
  restore: () => void;
} {
  const sigintHandlers: Array<() => void | Promise<void>> = [];
  const sigtermHandlers: Array<() => void | Promise<void>> = [];
  const spy = vi.spyOn(process, 'on').mockImplementation(((event: string | symbol, handler: never) => {
    if (event === 'SIGINT') sigintHandlers.push(handler as () => Promise<void>);
    if (event === 'SIGTERM') sigtermHandlers.push(handler as () => Promise<void>);
    // CRITICAL: must return process for chainability or pino/sql.js init breaks
    return process;
  }) as never);
  return {
    sigintHandlers,
    sigtermHandlers,
    restore: () => spy.mockRestore(),
  };
}
