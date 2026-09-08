import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { loadCorpus, type Corpus, type TrainOverlap } from './corpus.js';

/**
 * The 4 corpora `docs/benchmark-protocol.md` §2 registered. The 4-corpus cap is an
 * exclusion criterion, not a starting point — nothing is added here after registration.
 *
 * C4 is repo-authored and is the ONLY headline-eligible source (§3). C1-C3 are third-party
 * snapshots written by `bench/fetch-corpora.mjs` at a pinned upstream revision; they are
 * reported side-by-side with their contamination class always visible.
 *
 * C2 and C3 are attack-only upstream, so they borrow the shared FP control set (§2) for
 * their benign half. FPR/TNR on those rows therefore measure the same control set three
 * times — that is the protocol's design, not a bug.
 */
export interface CorpusDescriptor {
  id: string;
  dir: string;
  /** Overridden for attack-only corpora that borrow the shared FP control set. */
  benignPath?: string;
  /**
   * A benign-only control set rather than one of the 4 registered corpora (§2). Reported
   * separately and NEVER merged into a corpus: these are ordinary prompts, so folding them
   * into C4 would dilute its deliberate near-miss controls and improve the false-positive
   * rate for the wrong reason.
   */
  controlSet?: boolean;
}

const SHARED_BENIGN = join('bench', 'corpus', 'benign.jsonl');

export const CORPORA: CorpusDescriptor[] = [
  { id: 'C1', dir: join('bench', 'corpora', 'C1') },
  { id: 'C2', dir: join('bench', 'corpora', 'C2'), benignPath: SHARED_BENIGN },
  { id: 'C3', dir: join('bench', 'corpora', 'C3'), benignPath: SHARED_BENIGN },
  { id: 'C4', dir: join('bench', 'corpus') },
  { id: 'FP-CONTROL', dir: join('bench', 'corpora', 'FP-CONTROL'), controlSet: true },
];

interface Manifest {
  corpus_id?: string;
  name?: string;
  train_overlap?: TrainOverlap;
  attacks_sha256?: string;
  benign_sha256?: string | null;
  benign_source?: string;
  pinned_revision?: string;
  source?: string;
}

function readManifest(dir: string): Manifest {
  return (parse(readFileSync(join(dir, 'MANIFEST.yaml'), 'utf-8')) ?? {}) as Manifest;
}

const fileSha = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Fail loudly when a snapshot no longer matches the sha its MANIFEST pinned.
 *
 * An unchecked pin is decoration: without this, a re-fetch that quietly returned different
 * upstream rows would publish a different number under the same provenance table. Only the
 * third-party snapshots carry these fields — C4 is repo-authored and versioned by git.
 */
export function verifyPin(dir: string, manifest: Manifest): void {
  const checks: Array<[string, string | null | undefined]> = [
    ['attacks.jsonl', manifest.attacks_sha256],
    ['benign.jsonl', manifest.benign_sha256],
  ];
  for (const [file, expected] of checks) {
    if (!expected) continue;
    const actual = fileSha(join(dir, file));
    if (actual !== expected) {
      throw new Error(
        `Corpus pin mismatch for ${join(dir, file)}: MANIFEST says ${expected}, file is ${actual}. ` +
          'Re-run bench/fetch-corpora.mjs or restore the snapshot — do not publish numbers from a drifted corpus.',
      );
    }
  }
}

export interface RegisteredCorpus extends Corpus {
  /** Paraphrase consistency is only defined where the corpus ships paraphrase groups. */
  hasParaphraseGroups: boolean;
}

/** Load one registered corpus, verifying its pin first. */
export function loadRegisteredCorpus(
  descriptor: CorpusDescriptor,
  cwd: string = process.cwd(),
): RegisteredCorpus {
  const dir = resolve(cwd, descriptor.dir);
  const manifest = readManifest(dir);
  verifyPin(dir, manifest);

  const corpus = loadCorpus({
    id: manifest.corpus_id ?? descriptor.id,
    name: manifest.name ?? descriptor.id,
    trainOverlap: manifest.train_overlap ?? 'partial',
    attacksPath: join(dir, 'attacks.jsonl'),
    benignPath: descriptor.benignPath
      ? resolve(cwd, descriptor.benignPath)
      : join(dir, 'benign.jsonl'),
  });

  return {
    ...corpus,
    hasParaphraseGroups: corpus.entries.some((e) => e.paraphraseOf !== null),
  };
}

/** Resolve a comma-separated id list (default: all registered corpora, in protocol order). */
export function selectCorpora(ids?: string): CorpusDescriptor[] {
  if (!ids) return CORPORA;
  const wanted = ids.split(',').map((s) => s.trim().toUpperCase());
  const unknown = wanted.filter((id) => !CORPORA.some((c) => c.id === id));
  if (unknown.length > 0) {
    throw new Error(`Unknown corpus id(s): ${unknown.join(', ')}. Registered: ${CORPORA.map((c) => c.id).join(', ')}`);
  }
  return CORPORA.filter((c) => wanted.includes(c.id));
}
