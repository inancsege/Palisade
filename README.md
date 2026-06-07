# 🏛️ Palisade

**Runtime prompt injection detection and behavioral sandboxing for AI agents.**

A standalone security layer that sits between any AI agent and its LLM provider, intercepting injected instructions before they reach the model and constraining tool actions that violate declared capabilities. Framework-agnostic — works with OpenClaw, LangGraph, CrewAI, or any agent that routes through an LLM.

---

## Why This Exists

AI agents are under active attack through their own tool ecosystems. The problem is structural, not hypothetical:

- **Cisco's AI Defense team** tested a single community skill and found **9 security vulnerabilities** — including silent data exfiltration via embedded `curl` commands and direct prompt injection that bypassed the agent's safety guidelines without user awareness.
- **The ClawHavoc campaign** planted **800+ malicious extensions** across a major agent skill registry (~20% of the entire marketplace), distributing infostealers disguised as productivity tools.
- **26% of 31,000 agent skills** analyzed across platforms contained at least one exploitable vulnerability: command injection, credential theft, or prompt manipulation.
- **Academic research** (IEEE S&P 2026) shows that adaptive attacks exceed **90% bypass rates** against 12 published prompt injection defenses.

Existing tools address fragments of the problem. **Static scanners** catch threats before installation — but a clean skill can start exfiltrating after deployment. **Infrastructure sandboxes** isolate at the kernel level — but don't understand what the prompt _says_. **LLM-based detectors** add latency and cost per request.

Palisade fills the gap: a **lightweight, local-first runtime layer** that combines fast heuristic filtering with ML-based semantic analysis and behavioral policy enforcement — all in a single process, no GPU required.

## How It Works

Palisade operates as a **proxy middleware** between your agent framework and the LLM API. Today it inspects **outbound requests** before they reach the model; the response-side action gate (the return arrow below) is **planned, not yet implemented**:

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

**Tier 3 — Behavioral Policy Engine (planned — not yet implemented)**
Runtime monitoring of what the agent actually _does_ after receiving the LLM response. Per-tool capability declarations are checked against real execution: a weather tool calling `curl` to an undeclared IP gets blocked, a document summarizer attempting to write to `~/.ssh/` gets blocked, a skill reading `.env` when its manifest declares no filesystem access gets blocked.

### Canary Tokens (planned — not yet implemented)

Palisade injects traceable markers into sensitive context (credentials, user data). If these markers appear in outbound network traffic or tool outputs directed to undeclared endpoints, the source skill/tool is immediately flagged and quarantined.

## Supported Frameworks

| Framework | Integration Method |
|---|---|
| **OpenClaw** | Gateway middleware (intercepts before LLM routing) |
| **LangGraph / LangChain** | Runnable wrapper around ChatModel |
| **CrewAI** | Agent callback hook |
| **Vercel AI SDK** | Middleware function |
| **Direct API** | HTTP proxy mode (point your base URL at Palisade) |
| **Any agent** | Standalone proxy — swap your API base URL |

> **Available today:** the **HTTP proxy mode** (the last two rows) — works with any framework or
> direct API calls. The framework-specific adapters (OpenClaw, LangGraph, CrewAI, Vercel) are
> **planned** and not yet implemented.

The simplest integration requires zero framework changes — run Palisade as a local proxy server and point your `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` at it:

```bash
palisade serve --port 8340 --upstream https://api.anthropic.com
# Then in your agent config:
# ANTHROPIC_BASE_URL=http://localhost:8340
```

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
| Dashboard | **(planned)** | Real-time threat feed — not yet implemented |
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
- [x] **v0.2** — Tier 2 ML classifier (ONNX, CPU-only) wired into the cascade; benchmark suite in progress
- [ ] **v0.3** — Tier 3 behavioral policy engine (YAML capability manifests)
- [ ] **v0.4** — Canary token injection + exfiltration anomaly detection
- [ ] **v0.5** — Dashboard + event log + skill trust scoring
- [ ] **v1.0** — Framework adapters (OpenClaw, LangGraph, CrewAI, Vercel AI SDK)

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
