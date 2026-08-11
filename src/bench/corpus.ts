import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * One evaluation entry. Mirrors the JSONL emitted under `bench/corpus/` and the fields the
 * MANIFEST documents: `id`, `text`, `label`, `category`, `paraphrase_of`.
 */
export interface CorpusEntry {
  id: string;
  text: string;
  label: 'attack' | 'benign';
  category: string;
  /** Canonical attack id this entry paraphrases; the canonical points at itself. */
  paraphraseOf: string | null;
}

/** Contamination disclosure carried per corpus (protocol §3). */
export type TrainOverlap = 'none' | 'partial' | 'full';

export interface Corpus {
  id: string;
  name: string;
  trainOverlap: TrainOverlap;
  entries: CorpusEntry[];
  /** sha256 over the raw file bytes, for the §7 reproducibility pin. */
  sha256: string;
}

function parseEntry(line: string, source: string, index: number): CorpusEntry {
  const raw = JSON.parse(line) as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id : `${source}-${index}`;
  const label = raw.label === 'benign' ? 'benign' : 'attack';
  return {
    id,
    text: String(raw.text ?? ''),
    label,
    category: typeof raw.category === 'string' ? raw.category : label,
    paraphraseOf: typeof raw.paraphrase_of === 'string' ? raw.paraphrase_of : null,
  };
}

/** Read a JSONL corpus file, skipping blank lines. */
export function loadCorpusFile(path: string): { entries: CorpusEntry[]; sha256: string } {
  const buffer = readFileSync(path);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const entries = buffer
    .toString('utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((line, i) => parseEntry(line, path, i));
  return { entries, sha256 };
}

/**
 * Load a corpus from its attack + benign halves. The sha256 combines both files so a change
 * to either invalidates the pin.
 */
export function loadCorpus(options: {
  id: string;
  name: string;
  trainOverlap: TrainOverlap;
  attacksPath: string;
  benignPath: string;
}): Corpus {
  const attacks = loadCorpusFile(options.attacksPath);
  const benign = loadCorpusFile(options.benignPath);
  const sha256 = createHash('sha256')
    .update(attacks.sha256)
    .update(benign.sha256)
    .digest('hex');
  return {
    id: options.id,
    name: options.name,
    trainOverlap: options.trainOverlap,
    entries: [...attacks.entries, ...benign.entries],
    sha256,
  };
}
