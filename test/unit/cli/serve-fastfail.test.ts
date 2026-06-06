import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tier2Engine } from '../../../src/detection/tier2/index.js';
import { DetectionError } from '../../../src/utils/errors.js';
import { mapStartupError } from '../../../src/cli/commands/serve.js';

/**
 * Task 3 (T2-09): the model-missing fast-fail + serve mapping.
 *
 * These are network-free: `PALISADE_MODELS_DIR` is pointed at a fresh EMPTY tmp dir so
 * `isInstalled(MODEL_SHA)` is deterministically false (no model installed) WITHOUT any download.
 * The fast-fail is a pure `existsSync` check, so initialize() rejects (or no-ops) well under 2s.
 */

type Tier2ConfigSlice = ConstructorParameters<typeof Tier2Engine>[0];

function makeConfig(overrides: Partial<Tier2ConfigSlice> = {}): Tier2ConfigSlice {
  return {
    enabled: false,
    ambiguous_band: [0.3, 0.7],
    calibration: { temperature: 1.0, bias: 0 },
    max_input_chars: 4000,
    ...overrides,
  } as Tier2ConfigSlice;
}

describe('Tier2Engine.initialize() model-missing fast-fail (T2-09)', () => {
  let savedModelsDir: string | undefined;
  let savedXdg: string | undefined;
  let emptyCache: string;

  beforeEach(() => {
    savedModelsDir = process.env.PALISADE_MODELS_DIR;
    savedXdg = process.env.XDG_CACHE_HOME;
    // A fresh EMPTY cache root → isInstalled(MODEL_SHA) is false (model NOT installed), network-free.
    emptyCache = mkdtempSync(join(tmpdir(), 'palisade-fastfail-'));
    process.env.PALISADE_MODELS_DIR = emptyCache;
    delete process.env.XDG_CACHE_HOME;
  });

  afterEach(() => {
    if (savedModelsDir === undefined) delete process.env.PALISADE_MODELS_DIR;
    else process.env.PALISADE_MODELS_DIR = savedModelsDir;
    if (savedXdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = savedXdg;
    rmSync(emptyCache, { recursive: true, force: true });
  });

  it('enabled:true + model_path set + NOT installed → rejects with code tier2_model_missing, <500ms, no network', async () => {
    const engine = new Tier2Engine(
      makeConfig({ enabled: true, model_path: join(emptyCache, 'some-model') }),
    );
    const start = performance.now();
    let caught: unknown;
    try {
      await engine.initialize();
    } catch (err) {
      caught = err;
    }
    const elapsed = performance.now() - start;

    expect(caught).toBeInstanceOf(DetectionError);
    expect((caught as DetectionError).code).toBe('tier2_model_missing');
    // Pure existsSync check — must be far under the 2s serve budget (no network, no model load).
    expect(elapsed).toBeLessThan(500);
    // The engine must NOT have marked itself initialized after a fast-fail throw.
    expect(engine.isInitialized).toBe(false);
  });

  it('enabled:true + model_path undefined → does NOT throw (benign no-op, preserves Slice-A stub case)', async () => {
    // WARNING 4: the fast-fail is gated on hasModel(); an enabled-but-unconfigured engine never
    // fast-fails (stub.test.ts "enabled but no model_path" no-op MUST stay green).
    const engine = new Tier2Engine(makeConfig({ enabled: true, model_path: undefined }));
    await expect(engine.initialize()).resolves.toBeUndefined();
    expect(engine.isInitialized).toBe(true);
  });

  it('enabled:false → does NOT throw (v0.1 default never fast-fails)', async () => {
    const engine = new Tier2Engine(makeConfig({ enabled: false }));
    await expect(engine.initialize()).resolves.toBeUndefined();
    expect(engine.isInitialized).toBe(true);
  });
});

describe('serve mapStartupError() mapping (T2-09)', () => {
  it('maps a tier2_model_missing error to error.type + a palisade tier2 install remediation', () => {
    const err = new DetectionError(
      'Tier 2 is enabled but no model is installed. Run: palisade tier2 install',
      'tier2_model_missing',
    );
    const mapped = mapStartupError(err);
    expect(mapped).not.toBeNull();
    expect(mapped!.type).toBe('tier2_model_missing');
    expect(mapped!.message).toContain('palisade tier2 install');
  });

  it('returns null for a generic error (falls back to the generic log.error path)', () => {
    expect(mapStartupError(new Error('something else'))).toBeNull();
    expect(mapStartupError(new DetectionError('generic detection failure'))).toBeNull();
    expect(mapStartupError(undefined)).toBeNull();
  });
});
