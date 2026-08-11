import { describe, it, expect } from 'vitest';
import { PINNED_SEED, splitCorpus } from '../../../src/bench/split.js';
import type { CorpusEntry } from '../../../src/bench/corpus.js';

function corpus(n: number): CorpusEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `e-${i}`,
    text: `entry ${i}`,
    label: i % 3 === 0 ? ('benign' as const) : ('attack' as const),
    category: 'override_phrase',
    paraphraseOf: null,
  }));
}

describe('splitCorpus (protocol §4)', () => {
  it('pins the seed the protocol locked forever', () => {
    expect(PINNED_SEED).toBe(20260603);
  });

  it('partitions 20% calibration / 80% eval', () => {
    const { calibration, evaluation } = splitCorpus(corpus(100), PINNED_SEED);
    expect(calibration).toHaveLength(20);
    expect(evaluation).toHaveLength(80);
  });

  it('is deterministic for a fixed seed', () => {
    const a = splitCorpus(corpus(50), PINNED_SEED);
    const b = splitCorpus(corpus(50), PINNED_SEED);
    expect(a.evaluation.map((e) => e.id)).toEqual(b.evaluation.map((e) => e.id));
  });

  it('produces a different partition for a different seed', () => {
    const a = splitCorpus(corpus(50), PINNED_SEED);
    const b = splitCorpus(corpus(50), PINNED_SEED + 1);
    expect(a.evaluation.map((e) => e.id)).not.toEqual(b.evaluation.map((e) => e.id));
  });

  it('is a true partition — no entry lost, none duplicated', () => {
    const all = corpus(37);
    const { calibration, evaluation } = splitCorpus(all, PINNED_SEED);
    const ids = [...calibration, ...evaluation].map((e) => e.id).sort();
    expect(ids).toEqual(all.map((e) => e.id).sort());
    expect(new Set(ids).size).toBe(all.length);
  });

  it('does not mutate the input corpus order', () => {
    const all = corpus(20);
    const before = all.map((e) => e.id);
    splitCorpus(all, PINNED_SEED);
    expect(all.map((e) => e.id)).toEqual(before);
  });

  it('keeps every member of a paraphrase group on the same side of the split', () => {
    // Splitting a group across calibration/eval would leak: the canonical would be
    // threshold-fitted and its paraphrases scored as held-out.
    const grouped: CorpusEntry[] = [];
    for (let g = 0; g < 20; g++) {
      const canonical = `atk-${g}`;
      for (let m = 0; m < 4; m++) {
        grouped.push({
          id: `${canonical}-${m}`,
          text: 't',
          label: 'attack',
          category: 'override_phrase',
          paraphraseOf: canonical,
        });
      }
    }
    const { calibration, evaluation } = splitCorpus(grouped, PINNED_SEED);
    const side = new Map<string, string>();
    for (const e of calibration) side.set(e.paraphraseOf!, 'cal');
    for (const e of evaluation) {
      if (side.get(e.paraphraseOf!) === 'cal') {
        throw new Error(`group ${e.paraphraseOf} straddles the split`);
      }
    }
    expect(calibration.length + evaluation.length).toBe(grouped.length);
  });
});
