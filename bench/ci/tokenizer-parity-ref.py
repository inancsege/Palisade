#!/usr/bin/env python3
"""FOUND-06 — Python AutoTokenizer reference (Phase 1, plan 01-02).

Reads the C4 corpus (bench/corpus/attacks.jsonl + benign.jsonl), tokenizes each entry's
`text` with the SAME model tokenizer the Node side uses, and writes a JSON map
{id: [token_id, ...]} to the path given as argv[1] (default: bench/ci/.parity-ref.json).

The Node counterpart (tokenizer-parity-node.mjs) emits the identical shape; the assert
(tokenizer-parity-assert.mjs) diffs the full arrays. Identical token IDs across all 200+
C4 inputs is the FOUND-06 proof.

Corpus is built in plan 01-01 Task 3 (GPT-4 paraphrase expansion — blocked on OPENAI_API_KEY).
If the corpus is absent, this prints a clear pending message and exits 0 so the workflow stays
green on FOUND-04 while FOUND-06 activates once the corpus lands.

Run (CI):  python bench/ci/tokenizer-parity-ref.py bench/ci/.parity-ref.json
"""
import json
import os
import sys

MODEL = "protectai/deberta-v3-small-prompt-injection-v2"
CORPUS_FILES = ["bench/corpus/attacks.jsonl", "bench/corpus/benign.jsonl"]


def load_corpus():
    rows = []
    for path in CORPUS_FILES:
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                rows.append((str(obj.get("id", len(rows))), obj["text"]))
    return rows


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "bench/ci/.parity-ref.json"
    corpus = load_corpus()
    if corpus is None:
        print("C4 corpus pending (bench/corpus/*.jsonl absent) — FOUND-06 parity deferred. exit 0.")
        json.dump({"_pending": True}, open(out_path, "w"))
        return

    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(MODEL)
    ids = {}
    for entry_id, text in corpus:
        ids[entry_id] = tok(text).input_ids

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(ids, fh)
    print(f"python ref: tokenized {len(ids)} C4 inputs with {MODEL} -> {out_path}")


if __name__ == "__main__":
    main()
