// FOUND-03 — Tier 2 small-vs-base bake-off (Phase 1, plan 01-02).
// Runs BOTH candidate models over the C4 corpus, computes paraphrase consistency and 4-column
// latency, and emits the ship decision: lowest-latency model with paraphrase consistency >= 0.75,
// OR the D04 cancel-Tier-2 decision if NEITHER reaches 0.75.
//
// Corpus + model dependent: needs bench/corpus/*.jsonl (plan 01-01 Task 3, blocked on OPENAI_API_KEY)
// and downloads both ONNX models. Intended to run locally or in CI once the corpus exists.
//
// Run: node bench/ci/bakeoff.mjs   (writes a JSON result; docs/tier2-bakeoff.md is authored from it)

import { pipeline } from '@huggingface/transformers';
import { readFileSync, existsSync } from 'node:fs';

const MODELS = [
  { id: 'protectai/deberta-v3-small-prompt-injection-v2', size_mb: 280 },
  { id: 'protectai/deberta-v3-base-prompt-injection-v2', size_mb: 700 },
];
const REVISION = process.env.MODEL_REVISION || 'main';
const SHIP_THRESHOLD = 0.75; // D03/D04
const CORPUS_FILES = ['bench/corpus/attacks.jsonl', 'bench/corpus/benign.jsonl'];

function loadCorpus() {
  const rows = [];
  for (const path of CORPUS_FILES) {
    if (!existsSync(path)) return null;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean)) {
      rows.push(JSON.parse(line));
    }
  }
  return rows;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] * 100) / 100;
}

// Paraphrase consistency: of the attacks whose canonical form is detected, the fraction of their
// GPT-4 paraphrases (grouped by `paraphrase_of` in the MANIFEST/corpus) ALSO detected (RESEARCH).
function paraphraseConsistency(records) {
  const groups = new Map();
  for (const r of records) {
    if (r.label !== 'attack') continue;
    const key = r.paraphrase_of ?? r.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let total = 0;
  let consistent = 0;
  for (const group of groups.values()) {
    const canonical = group.find((g) => (g.paraphrase_of ?? g.id) === g.id) ?? group[0];
    if (!canonical.detected) continue; // only score groups whose canonical attack was caught
    for (const g of group) {
      if (g.id === canonical.id) continue;
      total++;
      if (g.detected) consistent++;
    }
  }
  return total === 0 ? 0 : consistent / total;
}

async function evalModel(model, corpus) {
  const classify = await pipeline('text-classification', model.id, { device: 'cpu', dtype: 'fp32', revision: REVISION });
  // warmup
  await classify('warmup');
  const latencies = [];
  let coldMs = null;
  const scored = [];
  for (const entry of corpus) {
    const t = performance.now();
    const out = await classify(entry.text);
    const ms = performance.now() - t;
    if (coldMs === null) coldMs = ms;
    else latencies.push(ms);
    const isInjection = Array.isArray(out) && out[0]?.label === 'INJECTION';
    scored.push({ ...entry, detected: isInjection });
  }
  latencies.sort((a, b) => a - b);
  return {
    model: model.id,
    size_mb: model.size_mb,
    cold_first_call_ms: Math.round(coldMs ?? 0),
    warm_p50_ms: percentile(latencies, 50),
    warm_p95_ms: percentile(latencies, 95),
    warm_p99_ms: percentile(latencies, 99),
    paraphrase_consistency: Math.round(paraphraseConsistency(scored) * 1000) / 1000,
  };
}

async function main() {
  const corpus = loadCorpus();
  if (corpus === null) {
    console.log('C4 corpus pending (bench/corpus/*.jsonl absent) — bake-off deferred (FOUND-03 blocked on OPENAI_API_KEY). exit 0.');
    return;
  }
  const results = [];
  for (const m of MODELS) results.push(await evalModel(m, corpus));

  const passing = results.filter((r) => r.paraphrase_consistency >= SHIP_THRESHOLD);
  let decision;
  if (passing.length === 0) {
    decision = { ship: false, reason: 'D04', detail: `no model reached paraphrase consistency >= ${SHIP_THRESHOLD}; cancel Tier 2 from v0.2` };
  } else {
    // lowest warm_p95 latency among passing models
    const winner = passing.sort((a, b) => a.warm_p95_ms - b.warm_p95_ms)[0];
    decision = { ship: true, model: winner.model, paraphrase_consistency: winner.paraphrase_consistency, warm_p95_ms: winner.warm_p95_ms };
  }
  console.log(JSON.stringify({ ok: true, results, decision }, null, 2));
}

main().catch((err) => {
  console.error('bake-off FAILED:', err && err.message ? err.message : err);
  process.exit(1);
});
