# llm-security-probe

LLM security and red-team test suite for local Ollama models.

> **Defensive use only.** This repository is for evaluating and hardening LLM systems you own or have explicit written authorisation to test. Do not point any part of this tooling at systems you do not own. Phase 1B (agentic pen-test runner) requires a signed Rules of Engagement document before first use.

## Status

**Phase 1A — scaffold.** CI gate live; no probes shipped yet. Real tests land in PR-A2 onward.

## What this is

Two-phase project:

| Phase | What it does | State |
|---|---|---|
| **1A — Defensive eval** | Tests whether each local Ollama model **refuses** attacks across five categories: SSRF, port scanning, token leak, network exploits, prompt injection. Wraps [promptfoo](https://www.promptfoo.dev/) deterministic plugins + a hand-rolled port-scan plugin. Output: per-model refusal scorecard. | Scaffolded; PR-A2+ pending. |
| **1B — Agentic pen-test runner** | Uses local + cloud models to actively conduct a scoped pen-test against a target. Wraps [CAI](https://github.com/aliasrobotics/CAI) as the runtime. Hybrid model routing (recon → local Ollama, planning → cloud frontier). Sandboxed Docker executor. Validator agent before findings escalate. | Not started. Hard preconditions documented in plan. |

## Why standalone (not part of the dashboard)

- Red-team prompts and offensive tooling stay private; the consumer dashboard repo is public.
- Independent CI gate — a flaky red-team test never blocks a dashboard deploy.
- Reusable beyond OpenClaw — Phase 2 cloud-API targets benefit from the same suite.

## Disciplines

Every PR follows these rules. They are enforced by convention here, by CI where possible, and by discipline elsewhere.

- **TDD-first.** Failing test in the same PR as the implementation.
- **CI gate.** `.github/workflows/ci.yml` runs `npm test` on Node 22 and 24. PR merges blocked on red CI.
- **Squash-only merges.** Linear history.
- **Auto-delete head branches** on merge.
- **Push WIP daily.** Feature branches push to `origin` at least once per working day; draft PRs encouraged.
- **Merge before delete.** Never delete a feature branch until the merged PR exists.

### Missing branch protection (private-repo TBD exception)

GitHub branch protection rules are unavailable on private repos without GitHub Pro. The repo owner does not currently have Pro on this account, so the merge button technically allows skipping CI. The discipline above is the gate; review every merge by hand. Revisit when the account has Pro or the repo goes public.

## Quick start

```bash
npm test            # runs all unit tests on the host Node version
npm run ci          # alias for npm test; matches CI workflow
```

End-to-end probe runs against real Ollama models will land in PR-A6 once the suite is wired.

## Layout (will fill out PR-by-PR)

```
llm-security-probe/
├── .github/workflows/ci.yml          # Node 22 + 24 matrix
├── LICENSE                           # MIT
├── README.md
├── package.json
├── src/                              # (PR-A2 onward)
└── test/
    └── scaffold.test.js              # Smoke test; proves CI is wired
```

## Plan

The two-phase implementation plan with TDD ordering, ROE design, risk register, and out-of-scope items is tracked outside this repo (private notes). Open an issue tagged `plan-question` if you need clarification.

## License

Proprietary — all rights reserved. See [LICENSE](./LICENSE). No use, copying, modification, or distribution is permitted without explicit written permission.
