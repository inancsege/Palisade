# 🏛️ Palisade

**Runtime prompt injection detection and behavioral sandboxing for AI agents.**

A standalone security layer that sits between any AI agent and its LLM provider, intercepting injected instructions before they reach the model and constraining tool actions that violate declared capabilities. Framework-agnostic — works with OpenClaw, LangGraph, CrewAI, or any agent that routes through an LLM.

---

## Why This Exists

AI agents are under active attack through their own tool ecosystems. The problem is structural, not hypothetical:

- **Cisco's AI Defense team** scanned OpenClaw's top-ranked community skill and found **9 security vulnerabilities** (two critical) — including silent data exfiltration via an embedded `curl` command and direct prompt injection that bypassed the agent's safety guidelines without user awareness. ([Cisco Blogs](https://blogs.cisco.com/ai/personal-ai-agents-like-openclaw-are-a-security-nightmare))
- The **ClawHavoc campaign** planted **800+ malicious skills** across OpenClaw's ClawHub marketplace, distributing infostealers disguised as productivity tools. ([VirusTotal](https://blog.virustotal.com/2026/02/from-automation-to-infection-how.html))
- **26% of 31,000+ agent skills** analyzed across two major marketplaces contained at least one exploitable vulnerability — prompt injection the most prevalent. ([_Agent Skills in the Wild_, arXiv:2601.10338](https://arxiv.org/abs/2601.10338))
- A 2025 study from OpenAI, Anthropic, and Google DeepMind shows adaptive attacks exceed **90% bypass rates** against all 12 published prompt-injection defenses tested. ([_The Attacker Moves Second_, arXiv:2510.09023](https://arxiv.org/abs/2510.09023))

Existing tools address fragments of the problem. **Static scanners** catch threats before installation — but a clean skill can start exfiltrating after deployment. **Infrastructure sandboxes** isolate at the kernel level — but don't understand what the prompt _says_. **LLM-based detectors** add latency and cost per request.

Palisade fills the gap: a **lightweight, local-first runtime layer** that combines fast heuristic filtering with ML-based semantic analysis and behavioral policy enforcement — all in a single process, no GPU required.

## How It Works

Palisade operates as a **proxy middleware** between your agent framework and the LLM API. It inspects **outbound requests** before they reach the model (Tiers 1–2) and gates **incoming responses** on the way back — detecting tool calls that violate declared capabilities and blocking or rewriting them (Tier 3):

```
Agent Framework ──► Palisade ──► LLM Provider
       ▲                              │
       └──── Palisade (action gate) ◄─┘
```

### Detection Pipeline

**Tier 1 — Pattern Matching (~1ms)**
Fast regex and heuristic filters that catch known injection signatures before any heavier analysis runs. Handles role marker injection (`SYSTEM:`, `[INST]`), delimiter escapes, encoded payloads (base64, URL encoding, Unicode homoglyphs), and common override templates ("ignore previous instructions").

**Tier 2 — ML Classifier (~20ms warm, CPU-only)**
A fine-tuned DeBERTa classifier that scores the input from 0.0 (safe) to 1.0 (injection), splitting long inputs into overlapping windows and taking the highest score. Runs a local ONNX model (~738MB), downloaded once via `palisade tier2 install` and cached on disk — no external API calls, no GPU.

**Tier 3 — Behavioral Policy Engine**
Every tool call in an LLM response is classified against the policy's per-tool capability manifests (`network_egress`, `filesystem`, `shell_exec`) — a weather tool calling `curl` to an undeclared IP gets blocked, a document summarizer attempting to write to `~/.ssh/` gets blocked, a skill reading `.env` when its manifest declares no filesystem access gets blocked. Configurable `block` / `warn` actions; hard 403 (optionally with response rewrite) for non-streaming responses, and hold-back gating for streaming (SSE) responses — text deltas flow while tool_use blocks are held until they can be evaluated and replaced or passed through.

### Canary Tokens & Exfiltration Detection (v0.4)

Palisade injects a rotating, deployment-wide canary token into every request's system prompt (opt-in via `detection.canary.enabled`). A token appearing in a response is evidence of data exfiltration: non-streaming responses are hard-blocked with 403, streaming responses are aborted before the token-bearing content reaches the client, and every hit is recorded as a `canary_triggered` event. Tokens rotate on `rotate_interval` (with a 15-minute grace window for in-flight requests). A companion egress anomaly tracker watches Tier 3 gate results per source IP — bursts of calls to the same host or floods of newly-seen hosts fire `anomaly_detected` events (fixed thresholds: 5 same-host calls or 5 distinct hosts per 60s).

### Dashboard, Event Log & Skill Trust (v0.5)

Every request, gate decision, canary hit and anomaly is persisted to the SQLite event log
(`palisade.db` by default). Start the proxy with `--dashboard` and open the built-in
read-only dashboard at `/_palisade/` on the proxy port — a live threat feed of
request/block/warn/allowed stats, recent events, top triggered patterns, and a **skill
trust scoreboard**:

```bash
palisade serve --port 8340 --upstream https://api.anthropic.com --dashboard
# Browser: http://127.0.0.1:8340/_palisade/
```

The dashboard's JSON endpoints are also usable directly for automation:

- `GET /_palisade/stats` — totals plus top patterns (`?since=<seconds>` window)
- `GET /_palisade/events` — recent event log (`?limit=&offset=&action=&eventType=` filters)
- `GET /_palisade/skills` — per-skill trust records, riskiest first

**Skill trust scoring.** When an agent harness tags its requests with an `x-palisade-skill:<name>`
header, Palisade attributes each verdict to that skill: total requests, blocked/warned counts,
and a 0–1 trust score (starts at 1.0 for a new skill; blocks subtract 0.8, warns 0.15, clean
allows recover 0.1). Skills that repeatedly trigger injection violations are instantly visible
on the dashboard scoreboard — the signal for disabling or re-reviewing them.

## Supported Frameworks

| Framework | Integration Method | In-process guard? |
|---|---|---|
| **Vercel AI SDK** | `LanguageModelV2Middleware` | ✅ full — request scan, canary, tool-call gate (generate + stream) |
| **LangGraph / LangChain** | `BaseChatModel` proxy wrapper | ✅ request scan, canary, tool-call gate on `invoke`; streamed tool calls not gated |
| **OpenClaw** | Gateway routing preset (`openclaw.json`) | ➖ via proxy — OpenClaw exposes no pre-LLM hook |
| **CrewAI** | Gateway routing preset (Python) | ➖ via proxy — CrewAI is Python-only; a JS `kickoff` guard exists for the unofficial TS ports |
| **Direct API / any agent** | HTTP proxy mode — swap your base URL | ✅ full |

> **Verified against the real SDKs.** The Vercel and LangChain adapters are tested through the
> actual `ai` and `@langchain/core` packages (`test/unit/adapters/`), and `npm run
> typecheck:tests` fails if either framework's published contract drifts from what Palisade
> implements. `ai`/`@langchain/core` are **optional peer dependencies** — nothing is imported at
> runtime unless you use that adapter.

The simplest integration requires zero framework changes — run Palisade as a local proxy server and point your `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` at it:

```bash
palisade serve --port 8340 --upstream https://api.anthropic.com
# Then in your agent config:
# ANTHROPIC_BASE_URL=http://localhost:8340
```

### Vercel AI SDK (middleware)

```ts
import { wrapLanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { PalisadeAdapter, createPalisadeMiddleware } from '@inancsege/palisade';

const adapter = new PalisadeAdapter({ policy: defaultPolicy });
const guarded = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: createPalisadeMiddleware(adapter),
});
```

### LangGraph / LangChain (chat-model wrapper)

```ts
import { PalisadeAdapter, wrapLangChainModel } from '@inancsege/palisade';
import { ChatOpenAI } from '@langchain/openai';

const llm = wrapLangChainModel(new ChatOpenAI({ model: 'gpt-4o' }), new PalisadeAdapter({ policy: defaultPolicy }));
```

### CrewAI (gateway routing)

CrewAI is a **Python** framework, so the supported integration is routing its LLM through
`palisade serve`. Generate the environment (both `*_BASE_URL` and `*_API_BASE` are set, because
CrewAI 1.12.x does not map `base_url` onto LiteLLM's `api_base` — [crewAI#5139](https://github.com/crewAIInc/crewAI/issues/5139)):

```js
import { buildCrewAIEnv, crewAILlmSnippet } from '@inancsege/palisade';

buildCrewAIEnv({ upstream: 'openai', proxyPort: 8340 });
// → { OPENAI_BASE_URL: 'http://127.0.0.1:8340/v1', OPENAI_API_BASE: '…', OPENAI_API_KEY: '…' }

console.log(crewAILlmSnippet({ upstream: 'openai', model: 'gpt-4o' })); // ready-to-paste Python
```

For the unofficial TypeScript ports (`crewai-ts` and friends), `wrapCrewAI` guards `kickoff()`
in-process — it scans every string leaf in the input dict and appends the canary to
`task_description`:

```ts
import { PalisadeAdapter, wrapCrewAI } from '@inancsege/palisade';

const guardedCrew = wrapCrewAI(myCrew, new PalisadeAdapter({ policy: defaultPolicy }));
await guardedCrew.kickoff({ task_description: 'Summarize the incident notes' });
```

### OpenClaw (gateway routing)

```bash
palisade serve --port 8340 --upstream https://api.openai.com/v1
```

OpenClaw has no pre-LLM hook, so the preset routes a model provider through `palisade serve`.
It emits the shape OpenClaw actually reads — a JSON5 config at `~/.openclaw/openclaw.json`
(override with `OPENCLAW_CONFIG_PATH`) with providers nested under `models.providers.<id>`:

```js
import { openclawConfigJson, OPENCLAW_CONFIG_PATH } from '@inancsege/palisade';

console.log(openclawConfigJson({ upstream: 'openai', proxyPort: 8340, model: 'gpt-4o' }));
// merge the output into OPENCLAW_CONFIG_PATH (~/.openclaw/openclaw.json)
```

## Benchmark

Numbers come from the **pre-registered** protocol in [`docs/benchmark-protocol.md`](docs/benchmark-protocol.md),
which fixed the corpora, split and metric set *before* any result was measured. Regenerate with
`npm run benchmark`; the full per-corpus tables live in [`BENCHMARK.md`](BENCHMARK.md).

All four registered corpora, eval splits only, pinned seed `20260603`, Windows / i7-12700H / Node v24:

| Corpus | Source | train_overlap | Eval | Recall (`tier1+2+3`) | Precision | FPR on benign |
|---|---|---|---|---|---|---|
| **C4** | repo-authored held-out | **none** | 168 | 0.6514 | 1.0000 | 1.69% |
| C3 | AgentDojo `important_instructions` | none (unverified) | 82 | 0.3333 | 1.0000 | 1.64% |
| C2 | Lakera `gandalf_ignore_instructions` | **partial — contaminated** | 150 | 0.2935 | 1.0000 | 0.00% |
| C1 | deepset `prompt-injections` | **partial — contaminated** | 93 | 0.1000 | 1.0000 | 0.00% |

C1 and C2 are public corpora the Tier 2 model was very likely trained on, so their rows are an
**in-distribution** result and never a headline. Only C4 (and, weakly, C3) is `train_overlap: none`.

**Tier 2 currently earns very little.** Across all four corpora it fires on 4.17% / 8.54% / 0.00% /
2.15% of inputs (C4/C3/C2/C1) and changes exactly **one verdict** in 493 evaluated entries — an
`encoded_payload` catch on C4 that lifts that category's recall 0.7931 → 0.8276 and end-to-end
paraphrase consistency 0.6490 → 0.6573. On C1, C2 and C3, `tier1+2` is identical to `tier1` to four
decimals. That is the cost of a 738MB download and a p99 of ~39 ms, and it is the strongest argument
in this repo for revisiting the ambiguous band the cascade gates on.

Per-category recall on C4, `tier1+2+3` — precision is 1.0000 in every attack category, so these are
misses, not false alarms:

| Category | Recall | F1 | Support |
|---|---|---|---|
| role_marker | 0.9375 | 0.9677 | 16 |
| encoded_payload | 0.8276 | 0.9057 | 29 |
| delimiter_escape | 0.6250 | 0.7692 | 16 |
| exfiltration | 0.5417 | 0.7027 | 24 |
| override_phrase | 0.3750 | 0.5455 | 24 |

**Read these honestly.** Recall on `override_phrase` is 0.3750 — the cascade misses most reworded
override attacks — and 0.1000 on a German-language public corpus. The ~1.7% false-positive rate is
the number to weigh against those misses. None of this is the 0.978 in
[`docs/tier2-bakeoff.md`](docs/tier2-bakeoff.md): that gate scored the Tier 2 model in isolation over
a whole corpus, and the two are not comparable.

**Soak test (§5): inconclusive by the pre-registered metric, no leak by the evidence.** A 1-hour run
at 9.14 req/s completed 32,919 scans. The locked estimator is an RSS slope with a ≤ 5 MB/hour gate,
and it reads 22.85 MB/hour — but RSS spans 21 MB over the run, so a straight line through it cannot
resolve a 5 MB/hour signal either way. Over the final third of the run RSS spans **0.15 MB across 51
samples**: memory rises during warm-up, then stops. A leak keeps climbing; this does not. The slope
stands as measured because changing a pre-registered estimator after seeing the data is a protocol
decision, and the raw series is committed under `bench/results/soak/` so that call can be made on
evidence.

**Reproducibility (§7).** These C4 detection numbers are byte-identical to the previously published
Apple M3 / Node v22 run — every per-category recall, F1, FPR and TNR matches to four decimals across
a different OS, CPU and Node major. Only latency differs. Corpora C1–C3 are snapshotted at pinned
upstream revisions and their sha256 is re-verified on every run, so a drifted corpus aborts the run
rather than quietly changing a number.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                      PALISADE RUNTIME                      │
│                                                            │
│  ┌──────────┐   ┌──────────────┐   ┌───────────────────┐  │
│  │  Tier 1   │   │    Tier 2     │   │      Tier 3       │  │
│  │  Pattern  │──►│ ML Classifier │──►│ Behavioral Policy │  │
│  │  Filter   │   │ (CPU, ~738MB) │   │   Engine (YAML)   │  │
│  └──────────┘   └──────────────┘   └───────────────────┘  │
│       │                │                     │             │
│       ▼                ▼                     ▼             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Verdict: allow / warn / block           │   │
│  └─────────────────────────────────────────────────────┘   │
│       │                                                    │
│       ▼                                                    │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           Canary Token Monitor (async)               │   │
│  │     Tracks markers in outbound traffic/tool calls    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Event Log (SQLite)                      │   │
│  │   Blocked actions · Threat scores · Skill trust      │   │
│  └─────────────────────────────────────────────────────┘   │
├────────────────────────────────────────────────────────────┤
│  Dashboard (optional)     │    CLI: palisade scan/serve    │
│  Real-time threat feed    │    palisade audit <skill_dir>  │
│  Skill trust scoreboard   │    palisade report             │
└────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Component | Technology | Rationale |
|---|---|---|
| Core runtime / proxy | **TypeScript** (Node.js ≥ 20) | Native compatibility with major agent frameworks |
| Tier 1 patterns | **Regex pattern registry** (TypeScript) | Compiled-once, ReDoS-tested injection signatures |
| Tier 2 classifier | **@huggingface/transformers** (ONNX, in-process) | Local CPU inference in the Node process — no separate service, no GPU |
| ML model | **ONNX Runtime** (CPU) | Cross-platform, no GPU dependency, ~738MB (downloaded on demand via `palisade tier2 install`) |
| Policy definitions | **YAML + JSON Schema** (AJV) | Declarative policy config, human-readable |
| Event log | **sql.js** (WASM SQLite) | Local-first, zero-config, no native build step |
| Dashboard | **Built-in `/_palisade` (no framework)** | Self-contained HTML + JSON API, opt-in via `--dashboard` |
| CLI | **commander** (TypeScript) | `palisade serve / scan / audit / report / claude / tier2` |

## Relationship to Existing Tools

| Tool | Scope | What Palisade Adds |
|---|---|---|
| **Cisco Skill Scanner** | Pre-install static analysis | Runtime detection — catches skills that mutate post-install |
| **Cisco DefenseClaw** | Admission gating + audit on OpenShell | Framework-agnostic, no OpenShell dependency, semantic analysis |
| **NVIDIA NemoClaw** | Kernel-level container isolation | Understands prompt _content_, not just process boundaries |
| **StackOne Defender** | Tool-call injection filtering | Adds behavioral policy enforcement + canary token tracking |
| **Rebuff** | Multi-layer injection detection | Actively maintained, ONNX-based (no OpenAI dependency), behavioral layer |
| **Meta Prompt Guard** | Transformer classifier | CPU-only (no GPU), runs in-process with no external API and zero per-request cost |
| **OpenAI Guardrails** | LLM-based function call validation | No external API dependency, zero per-request cost |

Palisade is **not** a replacement for infrastructure sandboxing. Use it _alongside_ container isolation. Palisade is the **semantic layer** — it understands what instructions mean, not just what processes run.

## Roadmap

- [x] **v0.1** — Tier 1 pattern engine + proxy mode + CLI (`palisade serve`, `palisade scan`)
- [x] **v0.2** — Tier 2 ML classifier (ONNX, CPU-only) wired into the cascade; benchmark suite shipped (see [Benchmark](#benchmark))
- [x] **v0.3** — Tier 3 behavioral policy engine (YAML capability manifests) + response-side action gate
- [x] **v0.4** — Canary token injection + exfiltration anomaly detection
- [x] **v0.5** — Dashboard + event log + skill trust scoring
- [x] **v1.0** — Framework adapters (OpenClaw, LangGraph, CrewAI, Vercel AI SDK)

## Quick Start

```bash
# Install from source (the `palisade` name on npm is an unrelated package — install from this repo)
git clone https://github.com/inancsege/Palisade.git
cd Palisade
npm install && npm run build
npm link            # makes the `palisade` command available from this checkout

# Scan a directory for injection patterns
palisade scan ./my-agent-skill/

# Run as a proxy (zero-config integration), then point ANTHROPIC_BASE_URL at it
palisade serve --port 8340 --upstream https://api.anthropic.com

# Wrap the Claude Code CLI with injection protection in one command
palisade claude

# Run with a policy file
palisade serve --policy ./policy.yaml --port 8340
```

### Policy File Example

```yaml
# policy.yaml
version: "1"

defaults:
  network_egress: deny
  filesystem: read_only
  shell_exec: deny

tools:
  weather-lookup:
    network_egress:
      allow:
        - "api.openweathermap.org"
        - "api.weatherapi.com"
    filesystem: none
    shell_exec: deny

  document-summarizer:
    network_egress: deny
    filesystem:
      read_only:
        - "./workspace/docs/"
    shell_exec: deny

  code-runner:
    network_egress: deny
    filesystem:
      read_write:
        - "./workspace/sandbox/"
    shell_exec:
      allow:
        - "python3"
        - "node"
      deny:
        - "curl"
        - "wget"
        - "nc"

detection:
  tier1:
    enabled: true
    action: block          # block | warn | log
  tier2:
    enabled: true
    threshold: 0.75        # 0.0 - 1.0
    action: block
  tier3:
    enabled: true
    action: block          # block | warn
    unknown_tool: warn     # tools not declared in any manifest
    block_response: false  # true = hard 403; false = rewritten response + violation headers
  canary:
    enabled: true
    rotate_interval: 3600  # seconds
```

## Contributing

Contributions welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

Priority areas:
- Injection pattern corpus (real-world attack samples, anonymized)
- Framework adapter implementations
- ML classifier training data and model improvements
- Policy template library for common tool types

## License

MIT

---

**Author:** Ege · [GitHub](https://github.com/) · [LinkedIn](https://linkedin.com/)
