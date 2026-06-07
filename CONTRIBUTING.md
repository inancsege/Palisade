# Contributing to Palisade

Thanks for helping harden Palisade. It's a prompt-injection detection layer for LLM/agent
traffic, so contributions to the **detection patterns** and **attack-sample corpus** are
especially valuable — but tooling, tests, and docs are all welcome.

> **Adding detection patterns or injection samples?** See the dedicated
> **[pattern & corpus contribution guide](./docs/contributing-patterns.md)**.

## Prerequisites

- **Node.js >= 20** (the project uses native `fetch`, `node:` imports, and ESM)
- **npm**

## Setup

```bash
git clone https://github.com/inancsege/Palisade.git
cd Palisade
npm install
npm run build
```

The CLI runs from the build output. To get the `palisade` command from your checkout:

```bash
npm link                       # symlinks the `palisade` bin to this checkout
palisade --help
# …or run it directly without linking:
node dist/cli/index.js --help
```

> **Note:** the `palisade` name on the public npm registry belongs to an unrelated package,
> so install from source as above rather than `npm install -g palisade`.

## Running the checks

All of these must pass before you open a PR:

```bash
npm test               # unit suite (vitest)
npm run typecheck      # tsc --noEmit (strict mode)
npm run lint           # eslint src/
npm run test:coverage  # unit suite with the 80% line-coverage gate enforced
```

Optional, **model-gated** (only relevant if you touch Tier 2 and have run `palisade tier2 install`):

```bash
npm run test:integration   # real-model Tier 2 tests; skips cleanly without PALISADE_MODELS_DIR
```

## Code style

- **Prettier** (`.prettierrc`): semicolons, single quotes, trailing commas, 100-column width,
  2-space indent. Format before committing.
- **TypeScript strict**, **ESM-only**. All internal imports use the `.js` extension suffix
  (Node16 resolution) — e.g. `import { x } from './foo.js'`.
- **Named exports only** — no default exports anywhere.
- **File names** are lowercase kebab-case (`role-markers.ts`).
- Keep new dependencies minimal — prefer what's already in `package.json`.

## Project layout

| Path             | What lives there                                                                    |
| ---------------- | ----------------------------------------------------------------------------------- |
| `src/detection/` | Detection engine — Tier 1 regex patterns, Tier 2 ML classifier, scorer, verdict     |
| `src/proxy/`     | HTTP reverse proxy + provider parsers (Anthropic / OpenAI)                          |
| `src/policy/`    | Policy YAML loader, JSON-Schema validation, defaults                                |
| `src/logging/`   | sql.js (WASM SQLite) event database + logger                                        |
| `src/cli/`       | The `palisade` CLI commands (`serve`, `scan`, `audit`, `report`, `claude`, `tier2`) |
| `src/types/`     | Shared TypeScript types                                                             |
| `test/`          | `test/unit/**` (in the coverage gate) and `test/integration/**`                     |

## Pull requests

1. Branch off `main`.
2. Keep commits **atomic and focused**. Commit subjects are **imperative, sentence-case**, with
   **no** `feat:`/`fix:` prefix — match the existing history (e.g. _"Add homoglyph normalization to
   the encoded-payload decoder"_).
3. Add or update tests for any behavior change. New detection patterns need a positive-match test
   and must not regress the false-positive suite.
4. Make sure `npm test`, `npm run typecheck`, and `npm run lint` all pass.
5. Open the PR against `main` with a clear description of _what_ changed and _why_.

## Reporting security vulnerabilities

Palisade is a security tool, so please **do not open a public issue** for an exploitable
vulnerability — whether it's a flaw in Palisade itself or a **detection bypass that's actively
dangerous against real deployments**. Report it privately first (a
[GitHub security advisory](https://github.com/inancsege/Palisade/security/advisories/new) or direct
contact with the maintainer) so a fix can land before disclosure.

Ordinary detection patterns, paraphrase samples, and **non-weaponized** bypass _examples_ are
welcome as normal issues/PRs — see the [pattern & corpus guide](./docs/contributing-patterns.md).

## License

By contributing, you agree your contributions are licensed under the project's **MIT** license.
