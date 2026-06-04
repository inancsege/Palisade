// FOUND-06 — Node @huggingface/transformers tokenizer emitter (Phase 1, plan 01-02).
// Tokenizes the SAME C4 inputs as tokenizer-parity-ref.py and writes {id: [token_id,...]} JSON.
// Committed (not scratch/) so GitHub Actions can run it.
//
// Run (CI): node bench/ci/tokenizer-parity-node.mjs bench/ci/.parity-node.json

import { AutoTokenizer } from '@huggingface/transformers';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// Non-gated base model (deberta-v3 small/base share the same tokenizer). Override via PARITY_MODEL.
const MODEL = process.env.PARITY_MODEL || 'protectai/deberta-v3-base-prompt-injection-v2';
const REVISION = process.env.MODEL_REVISION || 'main';
const CORPUS_FILES = ['bench/corpus/attacks.jsonl', 'bench/corpus/benign.jsonl'];

function loadCorpus() {
  const rows = [];
  for (const path of CORPUS_FILES) {
    if (!existsSync(path)) return null;
    const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const obj = JSON.parse(line);
      rows.push([String(obj.id ?? rows.length), obj.text]);
    }
  }
  return rows;
}

async function main() {
  const outPath = process.argv[2] || 'bench/ci/.parity-node.json';
  const corpus = loadCorpus();
  if (corpus === null) {
    console.log('C4 corpus pending (bench/corpus/*.jsonl absent) — FOUND-06 parity deferred. exit 0.');
    writeFileSync(outPath, JSON.stringify({ _pending: true }));
    return;
  }

  const tok = await AutoTokenizer.from_pretrained(MODEL, { revision: REVISION });
  const ids = {};
  for (const [id, text] of corpus) {
    const enc = tok(text);
    // input_ids is a Tensor in transformers.js; normalize to a plain number[].
    ids[id] = Array.from(enc.input_ids.data ?? enc.input_ids).map(Number);
  }
  writeFileSync(outPath, JSON.stringify(ids));
  console.log(`node: tokenized ${Object.keys(ids).length} C4 inputs with ${MODEL} -> ${outPath}`);
}

main().catch((err) => {
  console.error('node tokenizer emit FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
