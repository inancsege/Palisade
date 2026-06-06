import { pipeline, env, type TextClassificationPipeline } from '@huggingface/transformers';
import type { DetectionPolicyConfig } from '../../types/policy.js';
import type { Tier2Result } from '../../types/verdict.js';
import { logger } from '../../utils/logger.js';
import { calibrate } from './calibrate.js';
import { chunk } from './chunker.js';
import { tokenize, decodeWindow, loadTokenizer } from './tokenizer.js';

/**
 * The slice of policy config the Tier 2 engine needs. Mirrors `DetectionPolicyConfig['tier2']`
 * so the engine can be constructed straight from `policy.tier2`.
 */
export type Tier2Config = DetectionPolicyConfig['tier2'];

/**
 * Raw output of the (Slice-B) inference body. `calibratedConfidence` is the
 * temperature/bias-calibrated 0..1 probability; `raw` is the uncalibrated model score.
 */
interface InferenceOutput {
  calibratedConfidence: number;
  raw?: number;
}

/**
 * Default cap on concurrent Tier 2 scans (T2-11). When exceeded, `scan()` short-circuits to the
 * zero deferred result rather than queueing — this prevents Tier 2 from amplifying load under
 * burst concurrency (anti-DoS).
 */
const DEFAULT_INFLIGHT_CAP = 16;

/** Overlap stride between consecutive 512-token windows (D06: 384 → 128-token overlap). */
const WINDOW_STRIDE = 384;
/** Maximum tokens per inference window (the model's max sequence length, D06). */
const WINDOW_MAX = 512;

/**
 * Token shapes to warm up before `server.listen()` (T2-02, D08). 512 = the model max (exercises the
 * full graph); the smaller shapes JIT the common short-prompt path. Warmup must complete inside
 * `initialize()` so the first real request never pays the cold-start spike (Pattern 6).
 */
const WARMUP_SHAPES = [32, 128, 512];

/**
 * Tier 2 (local ML classifier) engine — STUB (Slice A).
 *
 * This class ships the full, model-INDEPENDENT contract that `DetectionEngine` integrates against:
 * lifecycle (`initialize`/`close`), the error contract (T2-12 — `scan()` never rejects), and the
 * inflight cap (T2-11). The real ONNX `InferenceSession` + tokenizer + 3-shape warmup is Slice B;
 * until then `scan()` returns the disabled/zero result (`calibratedConfidence: 0`).
 *
 * Mirrors the structural shape of `Tier1Engine` (constructor + scan + private helpers).
 */
export class Tier2Engine {
  private config: Tier2Config;
  private inflightCap: number;
  private inflight = 0;
  private initialized = false;

  /**
   * The singleton ONNX text-classification pipeline, loaded ONCE in `initialize()` and reused for
   * every scan (one session per process — success criterion 7; null until loaded / after close).
   *
   * Declared `protected` (NOT private) so the warmup/inference subclass tests can inject and inspect
   * a fake classifier without an `as any` cast (the existing `FailingTier2Engine`/`SlowTier2Engine`
   * pattern). Populated in `initialize()` (Task 2).
   */
  protected classifier: TextClassificationPipeline | null = null;

  constructor(config: Tier2Config, inflightCap: number = DEFAULT_INFLIGHT_CAP) {
    this.config = config;
    this.inflightCap = inflightCap;
  }

  /**
   * Load the singleton text-classification pipeline ONCE and run the 32/128/512-token warmup BEFORE
   * resolving (T2-02, D08) — `PalisadeProxy.start()` awaits this before `server.listen()`, so warmup
   * always precedes the first real request. Idempotent: a second call is a no-op once loaded.
   *
   * When Tier 2 is disabled or no model is configured, this is a fast no-op (no load, no warmup) —
   * the v0.1 default path, so `serve` runs offline with zero ML cost (D17).
   */
  async initialize(): Promise<void> {
    if (this.initialized) return; // singleton: never reload on a repeated initialize().
    if (!this.config.enabled || !this.hasModel()) {
      this.initialized = true;
      return;
    }

    // Forbid any request-time hub fetch; load strictly from the local cache dir (RESEARCH Pattern 7).
    env.allowRemoteModels = false;
    env.allowLocalModels = true;

    // hasModel() guarantees model_path is a non-empty string here.
    const modelDir = this.config.model_path as string;
    await loadTokenizer(modelDir); // the chunker's token-boundary tokenizer (D05).
    this.classifier = await this.loadClassifier(modelDir);
    await this.warmup(); // 32/128/512-token warmups BEFORE we resolve (D08).
    this.initialized = true;
  }

  /**
   * Load the ONNX text-classification pipeline from a local model dir — the SINGLE subclass-overridable
   * model-touching seam (so unit tests inject a fake without a 700MB download, D20). Pins `dtype:'fp32'`
   * to match the bake-off numbers (Pitfall 6) and `device:'cpu'` (the proven `bakeoff.mjs` call shape).
   */
  protected async loadClassifier(modelDir: string): Promise<TextClassificationPipeline> {
    return pipeline('text-classification', modelDir, { device: 'cpu', dtype: 'fp32' });
  }

  /**
   * Run three warmup inferences (32/128/512-token filler strings) through the loaded pipeline so the
   * first real request doesn't pay the JIT/graph-optimization cost (T2-02, Pattern 6). Results are
   * discarded. No-op when the classifier is unloaded. The 512-token shape is the load-bearing one.
   */
  private async warmup(): Promise<void> {
    if (!this.classifier) return;
    const opts = { top_k: null } as unknown as { top_k: number };
    for (const n of WARMUP_SHAPES) {
      // Deterministic ASCII filler; word-count ≈ token-count for " word" (~1 token each).
      const filler = Array.from({ length: n }, () => 'word').join(' ');
      await this.classifier(filler, opts); // discarded — this JITs the graph at each shape.
    }
  }

  /**
   * Score `text` for injection risk. Honors the error contract (T2-12) and the inflight cap (T2-11):
   * - disabled / no model → `{ calibratedConfidence: 0, latencyMs: 0 }` immediately.
   * - inflight cap exceeded → zero deferred result immediately (debug-logged), no inference runs.
   * - inference throws/timeouts → `{ calibratedConfidence: 0, latencyMs }`, warn-logged, never rejects.
   *
   * Receives RAW (un-normalized) text per D05; the stub ignores it.
   */
  async scan(text: string): Promise<Tier2Result> {
    // Disabled or no model: return the zero result without touching the inflight counter.
    if (!this.config.enabled || !this.hasModel()) {
      return { calibratedConfidence: 0, latencyMs: 0 };
    }

    // Inflight cap: short-circuit to the zero deferred result rather than queueing (anti-DoS).
    if (!this.tryAcquire()) {
      return { calibratedConfidence: 0, latencyMs: 0 };
    }

    const start = performance.now();
    try {
      const output = await this.runInference(text);
      return {
        calibratedConfidence: output.calibratedConfidence,
        latencyMs: performance.now() - start,
        raw: output.raw,
      };
    } catch (err) {
      // T2-12: any throw/timeout degrades to a zero result; the pipeline continues with Tier 1.
      logger.warn({ err }, 'Tier 2 scan failed; continuing with Tier 1 alone');
      return { calibratedConfidence: 0, latencyMs: performance.now() - start };
    } finally {
      this.release();
    }
  }

  /**
   * Dispose the singleton ONNX session and null the field (Pitfall 7). Optional-chained so absence
   * of `dispose` (some transformers versions) is safe; idempotent and safe to call before
   * `initialize()` (no classifier → nothing to dispose).
   */
  async close(): Promise<void> {
    await this.classifier?.dispose?.();
    this.classifier = null;
    this.initialized = false;
  }

  /**
   * Real inference body (T2-01). Composes the model-independent adapters around the singleton
   * pipeline: tokenize RAW text (D05) → stride-384 chunk (D06) → for each window decode→classify→
   * read the INJECTION-label score → MAX over windows → calibrate (D24).
   *
   * Never logs/persists the scanned or window text (Pitfall 5 / D16 spirit): returns numbers only.
   * Never applies softmax to the pipeline `score` — it is already a probability; `calibrate` handles
   * the logit re-derivation (Pitfall 4). Defensive: returns the zero result if the classifier is
   * unloaded (`scan()` already guards this path, but the seam stays safe to call standalone).
   */
  protected async runInference(text: string): Promise<InferenceOutput> {
    if (!this.classifier) return { calibratedConfidence: 0 };

    const ids = tokenize(text); // RAW text (D05); [] when the tokenizer is unloaded.
    const windows = chunk(ids, { stride: WINDOW_STRIDE, max: WINDOW_MAX });

    let raw = 0;
    for (const win of windows) {
      const windowText = decodeWindow(win);
      // top_k:null → ALL class entries (the pipeline accepts null at runtime to return every label,
      // but its TS option type is `number`, so cast the options); .find('INJECTION') is
      // order-independent (Pattern 1) — never assume the top label is INJECTION.
      const opts = { top_k: null } as unknown as { top_k: number };
      const out = (await this.classifier(windowText, opts)) as Array<{
        label: string;
        score: number;
      }>;
      const inj = out.find((o) => o.label === 'INJECTION');
      raw = Math.max(raw, inj?.score ?? 0); // missing INJECTION label → 0, never NaN.
    }

    return { calibratedConfidence: calibrate(raw, this.config.calibration), raw };
  }

  /** True when a model is configured. Until Slice B installs one, this is false. */
  private hasModel(): boolean {
    return typeof this.config.model_path === 'string' && this.config.model_path.length > 0;
  }

  /**
   * Try to admit one scan into the inflight set. Returns false (and debug-logs) when the cap is
   * already reached, so the caller can defer to Tier 1 (T2-11).
   */
  private tryAcquire(): boolean {
    if (this.inflight >= this.inflightCap) {
      logger.debug(
        { inflight: this.inflight, inflightCap: this.inflightCap },
        'Tier 2 inflight cap reached; deferring to Tier 1',
      );
      return false;
    }
    this.inflight += 1;
    return true;
  }

  /** Release one admitted scan from the inflight set. */
  private release(): void {
    if (this.inflight > 0) this.inflight -= 1;
  }

  /** Current number of admitted-but-not-yet-released scans (exposed for tests). */
  protected get currentInflight(): number {
    return this.inflight;
  }

  /** Whether `initialize()` has run (exposed for diagnostics/tests). */
  get isInitialized(): boolean {
    return this.initialized;
  }
}
