import { describe, it, expect } from 'vitest';
import { scanCommand } from '../../../src/cli/commands/scan.js';
import { runCli, stripAnsi } from '../../helpers/cli.js';

// NOTE: scanCommand is itself the Commander sub-Command (named 'scan'), and
// runCli prepends ['node', 'palisade', ...]. Calling parseAsync directly on
// a sub-Command treats it as the root, so the argv passed here MUST NOT
// include the literal 'scan' subcommand token. We pass <dir> + options only.

describe('scan command (CLIT-01)', () => {
  it('exits 0 with empty results when scanning a benign directory in JSON format', async () => {
    const { exitCode, stdout } = await runCli(scanCommand, [
      'test/fixtures/cli/benign-only',
      '--format',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('files');
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results).toEqual([]);
  });

  it('exits 1 when scanning a directory containing a blocking injection', async () => {
    const { exitCode, stdout } = await runCli(scanCommand, [
      'test/fixtures/cli/nested',
      '--format',
      'json',
    ]);
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout);
    expect(parsed.files).toBeGreaterThanOrEqual(1);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.results[0].file).toContain('injection.txt');
    expect(parsed.results[0].result.action).toBe('block');
    expect(parsed.results[0].result.matches.length).toBeGreaterThan(0);
  });

  it('walks nested directories recursively', async () => {
    const { exitCode, stdout } = await runCli(scanCommand, [
      'test/fixtures/cli',
      '--format',
      'json',
    ]);
    expect(exitCode).toBe(1); // nested injection.txt triggers a block
    const parsed = JSON.parse(stdout);
    expect(
      parsed.results.some(
        (r: { file: string }) => r.file.includes('nested') && r.file.includes('injection.txt'),
      ),
    ).toBe(true);
  });

  it('skips zero-byte files (content.length === 0 branch)', async () => {
    const { exitCode, stdout } = await runCli(scanCommand, [
      'test/fixtures/cli',
      '--format',
      'json',
    ]);
    const parsed = JSON.parse(stdout);
    // empty.txt is included in walkDir's count but never appears in results
    // because the action `continues` before engine.detect runs.
    expect(parsed.results.some((r: { file: string }) => r.file.includes('empty.txt'))).toBe(false);
    // exitCode reflects the nested injection only
    expect(exitCode).toBe(1);
  });

  it('prints text-format banner and summary when --format is omitted', async () => {
    const { exitCode, stdout } = await runCli(scanCommand, [
      'test/fixtures/cli/benign-only',
    ]);
    expect(exitCode).toBe(0);
    const plain = stripAnsi(stdout);
    expect(plain).toContain('Palisade');
    expect(plain).toContain('Files scanned:');
    expect(plain).toContain('No threats detected.');
  });

  it('prints text-format BLOCK marker when scanning injection content', async () => {
    const { exitCode, stdout } = await runCli(scanCommand, [
      'test/fixtures/cli/nested',
    ]);
    expect(exitCode).toBe(1);
    const plain = stripAnsi(stdout);
    expect(plain).toContain('BLOCK');
    expect(plain).toContain('injection.txt');
    expect(plain).toContain('Files scanned:');
  });

  it('exits 1 with a stderr error message when the directory does not exist', async () => {
    const { exitCode, stderr } = await runCli(scanCommand, [
      'test/fixtures/__definitely_does_not_exist__',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Error reading directory');
  });

  it('loads policy from --policy <path> when provided', async () => {
    const { exitCode, stdout } = await runCli(scanCommand, [
      'test/fixtures/cli/benign-only',
      '--policy',
      'policy.example.yaml',
      '--format',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.results).toEqual([]);
  });
});
