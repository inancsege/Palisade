/**
 * Fetch and sha-pin corpora C1-C3 (docs/benchmark-protocol.md §2).
 *
 * C4 is repo-authored and already lives in bench/corpus/. C1-C3 come from third parties,
 * so this script snapshots them at a PINNED upstream revision and records a sha256 over
 * the written file. The pin is what makes the published rows reproducible (§7): a
 * re-fetch that produces different bytes fails the corpus check in src/bench/corpora.ts
 * rather than silently changing a number.
 *
 * Run once per snapshot, then commit the output:
 *   node bench/fetch-corpora.mjs
 *
 * Attack-only sources (C2, C3) carry no benign half. They reuse the shared FP control set
 * (§2) via bench/corpus/benign.jsonl — see the benignPath in src/bench/corpora.ts.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'bench', 'corpora');

// Pinned upstream revisions. Bump deliberately; a bump changes the sha and the numbers.
const PINS = {
  C1: '4f61ecb038e9c3fb77e21034b22511b523772cdd', // huggingface.co/datasets/deepset/prompt-injections
  C2: '04737b65e90a6794ec227012e4a255a7def6344b', // huggingface.co/datasets/Lakera/gandalf_ignore_instructions
  C3: '089ed468cf3ed0322acc66b0211f26d9d90dbf60', // github.com/ethz-spylab/agentdojo
};

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** The datasets-server caps a page at 100 rows, so walk offsets until the split is drained. */
async function hfRows(dataset, split) {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const url =
      `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}` +
      `&config=default&split=${split}&offset=${offset}&length=100`;
    const page = await getJson(url);
    rows.push(...page.rows.map((r) => r.row));
    if (rows.length >= page.num_rows_total) return rows;
  }
}

/**
 * AgentDojo renders `important_instructions` as a template filled per injection task, so the
 * attack strings only exist inside a recorded run. One user task per suite is enough — the
 * injected string does not vary with the user task, and identical strings are deduped.
 */
const AGENTDOJO_TASKS = {
  banking: [0, 1, 2, 3, 4, 5, 6, 7, 8],
  slack: [1, 2, 3, 4, 5],
  travel: [0, 1, 2, 3, 4, 5, 6],
  workspace: [0, 1, 2, 3, 4, 5],
};
const AGENTDOJO_RUN = 'claude-3-5-sonnet-20240620';

async function agentdojoStrings() {
  const seen = new Set();
  for (const [suite, tasks] of Object.entries(AGENTDOJO_TASKS)) {
    for (const task of tasks) {
      const url =
        `https://raw.githubusercontent.com/ethz-spylab/agentdojo/${PINS.C3}/runs/` +
        `${AGENTDOJO_RUN}/${suite}/user_task_0/important_instructions/injection_task_${task}.json`;
      const run = await getJson(url);
      for (const text of Object.values(run.injections ?? {})) {
        if (typeof text === 'string' && text.trim()) seen.add(text);
      }
    }
  }
  return [...seen];
}

const jsonl = (entries) => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex');

function write(corpus) {
  const dir = join(OUT, corpus.id);
  mkdirSync(dir, { recursive: true });

  const attacks = jsonl(corpus.attacks);
  writeFileSync(join(dir, 'attacks.jsonl'), attacks, 'utf-8');
  const manifest = {
    attacks_sha256: sha256(attacks),
    attack_count: corpus.attacks.length,
    benign_sha256: null,
    benign_count: 0,
  };

  if (corpus.benign) {
    const benign = jsonl(corpus.benign);
    writeFileSync(join(dir, 'benign.jsonl'), benign, 'utf-8');
    manifest.benign_sha256 = sha256(benign);
    manifest.benign_count = corpus.benign.length;
  }

  writeFileSync(
    join(dir, 'MANIFEST.yaml'),
    [
      `# Snapshot written by bench/fetch-corpora.mjs — do not hand-edit.`,
      `corpus_id: ${corpus.id}`,
      `name: ${JSON.stringify(corpus.name)}`,
      `license: ${JSON.stringify(corpus.license)}`,
      `language: ${corpus.language}`,
      `role: ${JSON.stringify(corpus.role)}`,
      `source: ${JSON.stringify(corpus.source)}`,
      `pinned_revision: ${PINS[corpus.id]}`,
      `snapshot_date: ${new Date().toISOString().slice(0, 10)}`,
      `train_overlap: ${corpus.trainOverlap}`,
      `contamination_note: >`,
      ...corpus.contamination.map((l) => `  ${l}`),
      `attack_count: ${manifest.attack_count}`,
      `attacks_sha256: ${manifest.attacks_sha256}`,
      `benign_count: ${manifest.benign_count}`,
      `benign_sha256: ${manifest.benign_sha256 ?? 'null # shared FP control set — see benign_source'}`,
      `benign_source: ${JSON.stringify(corpus.benignSource)}`,
      '',
    ].join('\n'),
    'utf-8',
  );

  console.log(`${corpus.id}: ${manifest.attack_count} attacks, ${manifest.benign_count} benign -> ${dir}`);
}

const SHARED_CONTROL = 'bench/corpus/benign.jsonl (shared FP control set, protocol §2)';

console.log('C1 deepset/prompt-injections (test split) ...');
const c1 = await hfRows('deepset/prompt-injections', 'test');
write({
  id: 'C1',
  name: 'deepset/prompt-injections (test split)',
  license: 'CC-BY-4.0',
  language: 'German + English',
  role: 'Cross-lingual signal',
  source: 'https://huggingface.co/datasets/deepset/prompt-injections',
  trainOverlap: 'partial',
  contamination: [
    'Public dataset predating the Tier 2 model. The classifier was very likely trained on',
    'overlapping data, so these rows are an IN-DISTRIBUTION (contaminated) result and must',
    'never source a headline number (§3).',
  ],
  benignSource: 'own (label 0 rows of the same split)',
  attacks: c1
    .filter((r) => r.label === 1)
    .map((r, i) => ({ id: `c1-atk-${i}`, text: r.text, label: 'attack', category: 'injection' })),
  benign: c1
    .filter((r) => r.label !== 1)
    .map((r, i) => ({ id: `c1-ben-${i}`, text: r.text, label: 'benign', category: 'benign' })),
});

console.log('C2 Lakera/gandalf_ignore_instructions (test split) ...');
const c2 = await hfRows('Lakera/gandalf_ignore_instructions', 'test');
write({
  id: 'C2',
  name: 'Lakera/gandalf_ignore_instructions (test split)',
  license: 'MIT',
  language: 'English',
  role: 'Canonical ignore-instructions corpus',
  source: 'https://huggingface.co/datasets/Lakera/gandalf_ignore_instructions',
  trainOverlap: 'partial',
  contamination: [
    'The canonical public ignore-instructions corpus. Almost certainly inside the Tier 2',
    'model training mix — an IN-DISTRIBUTION (contaminated) result, reported side-by-side',
    'for transparency only (§3).',
  ],
  benignSource: SHARED_CONTROL,
  attacks: c2.map((r, i) => ({
    id: `c2-atk-${i}`,
    text: r.text,
    label: 'attack',
    category: 'override_phrase',
  })),
});

console.log('C3 AgentDojo important_instructions ...');
const c3 = await agentdojoStrings();
write({
  id: 'C3',
  name: 'AgentDojo important_instructions attack strings',
  license: 'Apache-2.0',
  language: 'English',
  role: 'Agentic-pattern coverage',
  source: 'https://github.com/ethz-spylab/agentdojo',
  trainOverlap: 'none',
  contamination: [
    'Agentic tool-use injections rendered from the AgentDojo important_instructions template.',
    'Marked none per the protocol table, but this is UNVERIFIED against the Tier 2 model',
    'training set — treat it as weaker evidence than C4, which is repo-authored.',
  ],
  benignSource: SHARED_CONTROL,
  attacks: c3.map((text, i) => ({
    id: `c3-atk-${i}`,
    text,
    label: 'attack',
    category: 'role_marker',
  })),
});
