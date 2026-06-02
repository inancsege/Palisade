// FOUND-06 — tokenizer parity assertion (Phase 1, plan 01-02).
// Diffs the FULL token-ID array per C4 input between the Python reference and the Node tokenizer.
// Exits 1 on the FIRST mismatch (printing the offending input id + both arrays). Also asserts
// each tokenization begins with [CLS] and ends with [SEP] (catches P3.4 boundary drift).
//
// Run (CI): node bench/ci/tokenizer-parity-assert.mjs bench/ci/.parity-ref.json bench/ci/.parity-node.json

import { readFileSync } from 'node:fs';

// DeBERTa-v3 special tokens: [CLS]=1, [SEP]=2 (SentencePiece config). Override if a model differs.
const CLS_ID = Number(process.env.CLS_ID ?? 1);
const SEP_ID = Number(process.env.SEP_ID ?? 2);

const refPath = process.argv[2] || 'bench/ci/.parity-ref.json';
const nodePath = process.argv[3] || 'bench/ci/.parity-node.json';

const ref = JSON.parse(readFileSync(refPath, 'utf8'));
const node = JSON.parse(readFileSync(nodePath, 'utf8'));

if (ref._pending || node._pending) {
  console.log('C4 corpus pending — tokenizer parity deferred (FOUND-06 activates when bench/corpus/ lands). exit 0.');
  process.exit(0);
}

const refIds = Object.keys(ref);
const nodeIds = Object.keys(node);
if (refIds.length === 0) {
  console.error('parity FAILED: reference produced 0 tokenizations');
  process.exit(1);
}
if (refIds.length !== nodeIds.length) {
  console.error(`parity FAILED: input count differs (python ${refIds.length} vs node ${nodeIds.length})`);
  process.exit(1);
}

let checked = 0;
for (const id of refIds) {
  const a = ref[id];
  const b = node[id];
  if (!Array.isArray(b)) {
    console.error(`parity FAILED: node missing tokenization for input ${id}`);
    process.exit(1);
  }
  // Boundary check (P3.4).
  if (a[0] !== CLS_ID || a[a.length - 1] !== SEP_ID) {
    console.error(`parity FAILED: input ${id} python tokenization not [CLS]...[SEP]:`, a.slice(0, 3), '...', a.slice(-2));
    process.exit(1);
  }
  // Full array diff.
  if (a.length !== b.length || a.some((tokenId, i) => tokenId !== b[i])) {
    console.error(`parity MISMATCH on input ${id}:`);
    console.error('  python:', JSON.stringify(a));
    console.error('  node:  ', JSON.stringify(b));
    process.exit(1);
  }
  checked++;
}

console.log(`FOUND-06 tokenizer parity PASSED — ${checked} C4 inputs, identical token IDs (python == node).`);
