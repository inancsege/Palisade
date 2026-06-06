import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Singleton-load + 3-shape warmup + close() dispose tests (T2-02, D08) — NO model download (D20).
 *
 * The model never loads here: a test subclass overrides the `protected loadClassifier(modelDir)`
 * seam to return a FAKE classifier function (a callable that records its calls, with a `dispose`
 * spy). The subclass reads the `protected classifier` field directly — NO `as any` (WARNING 2).
 *
 * This proves the SINGLETON (one load across repeated initialize/scan), the THREE warmup inferences
 * at 32/128/512-token shapes completing BEFORE `initialize()` resolves (so warmup precedes
 * `server.listen()` — success criterion 6 / D08), the no-model fast no-op, and idempotent
 * dispose-on-close — all without a 700MB download.
 */

vi.mock('../../../../src/utils/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// loadTokenizer is mocked so initialize() does not touch a real tokenizer/model dir.
const { loadTokenizerMock } = vi.hoisted(() => ({
  loadTokenizerMock: vi.fn(async () => undefined),
}));
vi.mock('../../../../src/detection/tier2/tokenizer.js', () => ({
  loadTokenizer: loadTokenizerMock,
  tokenize: vi.fn(() => []),
  decodeWindow: vi.fn(() => ''),
  __resetTokenizerForTests: vi.fn(),
}));

import { Tier2Engine } from '../../../../src/detection/tier2/index.js';

type Tier2ConfigSlice = ConstructorParameters<typeof Tier2Engine>[0];

function makeConfig(overrides: Partial<Tier2ConfigSlice> = {}): Tier2ConfigSlice {
  return {
    enabled: true,
    threshold: 0.5,
    action: 'block',
    model_path: '/fake/model/dir',
    ambiguous_band: [0.3, 0.7],
    calibration: { temperature: 1.0, bias: 0 },
    max_input_chars: 4000,
    ...overrides,
  } as Tier2ConfigSlice;
}

type LabelScore = { label: string; score: number };

/** A fake classifier: callable, records every call's text, exposes a dispose spy. */
function makeFakeClassifier() {
  const calls: string[] = [];
  const dispose = vi.fn(async () => undefined);
  const fn = vi.fn(async (text: string): Promise<LabelScore[]> => {
    calls.push(text);
    return [{ label: 'INJECTION', score: 0.1 }];
  });
  // Attach dispose to the callable, mirroring TextClassificationPipeline.
  (fn as unknown as { dispose: typeof dispose }).dispose = dispose;
  return { fn, calls, dispose };
}

/**
 * Test subclass overriding the `protected loadClassifier()` seam so NO real model loads.
 * Records how many times the pipeline factory is invoked (singleton assertion) and exposes the
 * `protected classifier` field directly (no `as any` — the field is `protected`, WARNING 2).
 */
class FakeLoadingTier2Engine extends Tier2Engine {
  loadCount = 0;
  fake = makeFakeClassifier();

  protected async loadClassifier(modelDir: string): Promise<never> {
    this.loadCount += 1;
    this.lastModelDir = modelDir;
    return this.fake.fn as unknown as never;
  }

  lastModelDir = '';

  /** Read the protected singleton field directly (proves it is protected, not private). */
  get classifierRef(): unknown {
    return this.classifier;
  }

  /** Snapshot the warmup-call count (calls recorded before any scan). */
  get warmupCalls(): string[] {
    return this.fake.calls;
  }
}

describe('initialize() singleton load + 3-shape warmup (T2-02, D08)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads the classifier exactly ONCE across repeated initialize/scan (singleton)', async () => {
    const engine = new FakeLoadingTier2Engine(makeConfig());
    await engine.initialize();
    await engine.initialize(); // a second initialize must NOT reload.
    await engine.scan('text');
    await engine.scan('more text');
    expect(engine.loadCount).toBe(1);
  });

  it('places the loaded classifier into the protected classifier field', async () => {
    const engine = new FakeLoadingTier2Engine(makeConfig());
    await engine.initialize();
    expect(engine.classifierRef).toBe(engine.fake.fn);
  });

  it('resolves the model dir from config.model_path for loadClassifier', async () => {
    const engine = new FakeLoadingTier2Engine(makeConfig({ model_path: '/fake/model/dir' }));
    await engine.initialize();
    expect(engine.lastModelDir).toBe('/fake/model/dir');
  });

  it('loads the tokenizer for the same model dir before warmup', async () => {
    const engine = new FakeLoadingTier2Engine(makeConfig({ model_path: '/fake/model/dir' }));
    await engine.initialize();
    expect(loadTokenizerMock).toHaveBeenCalledWith('/fake/model/dir');
  });

  it('runs exactly THREE warmup inferences at 32/128/512-token shapes', async () => {
    const engine = new FakeLoadingTier2Engine(makeConfig());
    await engine.initialize();
    expect(engine.warmupCalls).toHaveLength(3);
    // Filler strings are space-joined "word" tokens; word-count approximates token shape.
    const wordCounts = engine.warmupCalls.map((s) => s.split(' ').length);
    expect(wordCounts).toEqual([32, 128, 512]);
  });

  it('completes all THREE warmups BEFORE initialize() resolves (warmup precedes listen)', async () => {
    const engine = new FakeLoadingTier2Engine(makeConfig());
    // The moment the await resolves, warmup must already be done (count === 3) — not deferred.
    await engine.initialize();
    expect(engine.warmupCalls).toHaveLength(3);
  });

  it('no-model path: initialize() is a fast no-op (<100ms), no load, no warmup', async () => {
    const engine = new FakeLoadingTier2Engine(makeConfig({ model_path: undefined }));
    const start = performance.now();
    await engine.initialize();
    expect(performance.now() - start).toBeLessThan(100);
    expect(engine.loadCount).toBe(0);
    expect(engine.warmupCalls).toHaveLength(0);
    expect(engine.classifierRef).toBeNull();
  });

  it('disabled path: initialize() loads nothing even with a model_path set', async () => {
    const engine = new FakeLoadingTier2Engine(makeConfig({ enabled: false }));
    await engine.initialize();
    expect(engine.loadCount).toBe(0);
    expect(engine.classifierRef).toBeNull();
  });
});

describe('close() disposes the singleton (Pitfall 7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls dispose, nulls the field, and is idempotent', async () => {
    const engine = new FakeLoadingTier2Engine(makeConfig());
    await engine.initialize();
    expect(engine.classifierRef).not.toBeNull();

    await engine.close();
    expect(engine.fake.dispose).toHaveBeenCalledTimes(1);
    expect(engine.classifierRef).toBeNull();

    // A second close() is safe (idempotent) and does not re-dispose a nulled field.
    await expect(engine.close()).resolves.toBeUndefined();
    expect(engine.fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('close() before initialize() is safe (no classifier to dispose)', async () => {
    const engine = new FakeLoadingTier2Engine(makeConfig());
    await expect(engine.close()).resolves.toBeUndefined();
    expect(engine.fake.dispose).not.toHaveBeenCalled();
  });
});
