import type { CorpusEntry } from './corpus.js';

/**
 * The RNG seed `docs/benchmark-protocol.md` locked at pre-registration. Changing it
 * invalidates every published number, so it is a constant, never a parameter default
 * anyone can drift.
 */
export const PINNED_SEED = 20260603;

/** Fraction of each corpus reserved for threshold/fusion calibration (protocol §4). */
export const CALIBRATION_FRACTION = 0.2;

export interface CorpusSplit {
  /** Fits the Tier 2 decision threshold and the fusion calibration ONLY. */
  calibration: CorpusEntry[];
  /** Read only by the evaluator — the source of every published number. */
  evaluation: CorpusEntry[];
}

/** mulberry32 — small, fast, fully deterministic for a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over a copy, driven by the seeded RNG. */
function shuffled<T>(items: T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Partition a corpus 20/80 into calibration and evaluation splits.
 *
 * The split is taken over paraphrase GROUPS, not individual entries. Splitting a group
 * would leak: the canonical attack would fit the threshold while its near-identical
 * paraphrases were scored as held-out, inflating the headline number. Entries with no
 * group (`paraphraseOf === null`) are their own group.
 */
export function splitCorpus(entries: CorpusEntry[], seed: number = PINNED_SEED): CorpusSplit {
  const groups = new Map<string, CorpusEntry[]>();
  for (const entry of entries) {
    const key = entry.paraphraseOf ?? `__solo__:${entry.id}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }

  const order = shuffled([...groups.keys()], mulberry32(seed));
  const target = Math.round(entries.length * CALIBRATION_FRACTION);

  const calibration: CorpusEntry[] = [];
  const evaluation: CorpusEntry[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    // Fill calibration until it would overshoot the target; everything else is eval.
    if (calibration.length + group.length <= target) calibration.push(...group);
    else evaluation.push(...group);
  }

  return { calibration, evaluation };
}
