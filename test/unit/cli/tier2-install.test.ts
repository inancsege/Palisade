import { describe, it, expect } from 'vitest';
import {
  verifyHash,
  resolveUrl,
  MODEL_SHA,
  MODEL_REPO,
  MODEL_FILES,
} from '../../../src/detection/tier2/model-cache.js';
import { tier2Command } from '../../../src/cli/commands/tier2.js';

/**
 * Network-free coverage of the sha256 tamper gate (BLOCKER 3, threat T-02-07-T). `verifyHash` is the
 * ONLY integrity check for the ~700MB `tier2 install` download, so it MUST have automated coverage:
 * a matching buffer passes, a corrupted copy fails. The rest of `tier2.ts` is a thin fetch shell with
 * no branch logic worth excluding — the verifiable logic lives here and in model-cache.ts.
 */
describe('palisade tier2 install — verifyHash tamper gate (network-free)', () => {
  // sha256('palisade') precomputed.
  const SHA = '31bcf00e541432c9fa66278f0606407d5114079c8ecb5908d9397df51a64438c';

  it('verifyHash returns TRUE when the buffer matches the pin', () => {
    expect(verifyHash(Buffer.from('palisade'), SHA)).toBe(true);
  });

  it('verifyHash returns FALSE when the buffer is corrupted (one byte flipped)', () => {
    const corrupted = Buffer.from('palisadE'); // capital E → different bytes
    expect(verifyHash(corrupted, SHA)).toBe(false);
  });
});

describe('palisade tier2 install — pinned-commit URL build', () => {
  it('builds the resolve URL against the pinned MODEL_SHA (never "main")', () => {
    const url = resolveUrl('onnx/model.onnx');
    expect(url).toBe(
      `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_SHA}/onnx/model.onnx`,
    );
    expect(url).not.toContain('/main/');
    expect(MODEL_SHA).toMatch(/^[0-9a-f]{40}$/);
  });

  it('every MODEL_FILES source resolves under the pinned commit', () => {
    for (const f of MODEL_FILES) {
      expect(resolveUrl(f.source)).toContain(`/resolve/${MODEL_SHA}/`);
    }
  });
});

describe('palisade tier2 install — command registration', () => {
  it('is a "tier2" command exposing an "install" subcommand', () => {
    expect(tier2Command.name()).toBe('tier2');
    const sub = tier2Command.commands.map((c) => c.name());
    expect(sub).toContain('install');
  });

  it('install subcommand exposes --force and --models-dir options', () => {
    const install = tier2Command.commands.find((c) => c.name() === 'install');
    expect(install).toBeDefined();
    const flags = install!.options.map((o) => o.long);
    expect(flags).toContain('--force');
    expect(flags).toContain('--models-dir');
  });
});
