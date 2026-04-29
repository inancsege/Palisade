import { describe, it, expect } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripAnsi } from '../helpers/cli.js';
import { getAvailablePort } from '../helpers/http.js';

// Build-precondition (D-02): the smoke tests require dist/cli/index.js to
// already be built. We do NOT auto-run tsup -- devs and CI control the
// rebuild cadence. Throw a clear error at module load if dist is missing.
const distCli = resolve(process.cwd(), 'dist/cli/index.js');
if (!existsSync(distCli)) {
  throw new Error(
    'dist/cli/index.js not found - run `npm run build` first. ' +
      'CLI smoke tests require the built artifact to exist.',
  );
}

describe('CLI smoke (built dist)', () => {
  it('palisade scan exits 0 on a benign directory and outputs JSON with files+results keys', () => {
    const result = spawnSync(
      process.execPath,
      [distCli, 'scan', 'test/fixtures/cli/benign-only', '--format', 'json'],
      { encoding: 'utf-8', timeout: 10_000 },
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('files');
    expect(parsed).toHaveProperty('results');
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  it('palisade audit exits 0 with a fresh tmpdir database and reports zero events', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'palisade-smoke-audit-'));
    const dbPath = join(tmpDir, 'audit.db');
    try {
      const result = spawnSync(
        process.execPath,
        [distCli, 'audit', '--db', dbPath, '--format', 'json', '--since', '24h'],
        { encoding: 'utf-8', timeout: 10_000 },
      );
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.totalRequests).toBe(0);
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* Windows EPERM on locked files -- best-effort cleanup */
      }
    }
  });

  it('palisade report exits 0 with a fresh tmpdir database', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'palisade-smoke-report-'));
    const dbPath = join(tmpDir, 'report.db');
    try {
      const result = spawnSync(
        process.execPath,
        [distCli, 'report', '--db', dbPath, '--format', 'json', '--since', '7d'],
        { encoding: 'utf-8', timeout: 10_000 },
      );
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty('summary');
      expect(parsed).toHaveProperty('recentEvents');
      expect(parsed.summary.totalRequests).toBe(0);
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* Windows EPERM on locked files -- best-effort cleanup */
      }
    }
  });

  it('palisade serve starts, prints "Proxy listening on", and exits cleanly on SIGINT', async () => {
    // DEVIATION from plan: the plan suggested `-p 0` for kernel-assigned port,
    // but the Zod schema (src/utils/config.ts) enforces `port.min(1)`, so the
    // CLI rejects 0. Use getAvailablePort() to grab a real ephemeral port and
    // pass it explicitly. This still satisfies D-05 (ephemeral binding).
    const port = await getAvailablePort();
    // Async spawn (cannot use spawnSync because serve never returns until SIGINT).
    const child = spawn(process.execPath, [
      distCli,
      'serve',
      '-p',
      String(port),
      '-u',
      'http://127.0.0.1:1', // unreachable upstream is fine; we don't fire requests
      '--db',
      ':memory:',
      '--log-level',
      'error',
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    // Wait up to 5s for "Proxy listening on" in stdout
    await new Promise<void>((resolveStart, rejectStart) => {
      const timeout = setTimeout(() => {
        clearInterval(interval);
        rejectStart(
          new Error(`serve did not start within 5s. stdout: ${stdout} stderr: ${stderr}`),
        );
      }, 5_000);
      const interval = setInterval(() => {
        if (stripAnsi(stdout).includes('Proxy listening on')) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolveStart();
        }
      }, 50);
    });

    // Send SIGINT to the child (this is a child process, NOT the test worker -- safe).
    // CROSS-PLATFORM NOTE: on Windows, POSIX signals do not exist; child.kill('SIGINT')
    // forcefully terminates the process (exit code 1 / signal 'SIGINT' label only).
    // On Unix, the SIGINT handler in serve.ts runs cleanly and exits 0.
    child.kill('SIGINT');

    // Wait for child exit (timeout 5s)
    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => {
        const timeout = setTimeout(() => resolveExit({ code: null, signal: null }), 5_000);
        child.on('exit', (code, signal) => {
          clearTimeout(timeout);
          resolveExit({ code, signal });
        });
      },
    );
    // Packaging integrity = the child started, "Proxy listening on" printed,
    // and the child terminated when signaled. Exit code 0 only asserted on
    // platforms with real POSIX signal handling (i.e., not Windows).
    if (process.platform === 'win32') {
      // On Windows, child.kill terminates forcefully; we only require that
      // the child actually exited (didn't hang past the 5s timeout).
      expect(exitInfo.code !== null || exitInfo.signal !== null).toBe(true);
    } else {
      expect(exitInfo.code).toBe(0);
    }
  });
});
