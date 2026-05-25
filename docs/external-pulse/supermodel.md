# Supermodel

- **Source:** https://supermodeltools.com • https://github.com/supermodeltools • https://docs.supermodeltools.com
- **Encountered:** 2026-05-21, user prompt ("reverse engineer Supermodel as thoroughly as possible") — flagged as a potential open-source port target.
- **Verdict:** RFC — full teardown, licensing gate, and port groundwork in [`docs/design/supermodel-port-groundwork.md`](../design/supermodel-port-groundwork.md). **Parked** pending the server graph engine going public. Also refresh the four `reference_supermodel_*` memories — `reference_supermodel_company_gtm.md` is now factually wrong (see §3).

## 1. Core idea (one sentence, my words)

A hosted code-graph API plus a thin Go CLI: you run `supermodel`, it uploads your repo to the cloud, the server parses it with tree-sitter into a multi-layer graph — parse / dependency / call / domain — and the CLI writes plain-text `.graph.*` sidecar files next to each source file so any agent reads structure with `cat`/`grep` instead of re-deriving it every session.

## 2. Anatomy (concrete walkthrough)

13-repo GitHub org; the live product is four repos:

```
supermodeltools/
  cli/     Go   MIT          the product — thin client + shard renderer + watcher daemon (~44k LOC)
  mcp/     TS   MIT          standalone MCP server, one production tool (symbol_context)
  sdk/     TS   UNLICENSED   OpenAPI-generated API client (all-rights-reserved)
  audit/   TS   MIT          "Dead Code Hunter" GitHub Action (wraps `supermodel dead-code`)
  + docs/, mcpbr/ (benchmark runner); 5 archived repos; 1 dead experiment (opencode)
```

Load-bearing CLI files (read firsthand):
- `internal/api/client.go` — the *entire* analysis surface: POST repo zip to `/v1/graphs/supermodel`, poll the async job, decode. The CLI itself does no parsing.
- `internal/shards/render.go` — the `.graph` file format: `[deps]` / `[calls]` / `[impact]` sections + a 3-bucket risk heuristic.
- `internal/shards/daemon.go` — the watcher: UDP `:7734` trigger, 2s debounce, incremental API call + graph merge.
- `internal/shards/graph.go` — in-memory `Cache` indexing the server's node/relationship graph.
- `go.mod` — **four dependencies, no tree-sitter, no parser** — proof the CLI is a thin client.

User invokes: `supermodel` (bare = setup wizard, then watcher daemon). Agent sees: `Foo.py` → `Foo.graph.py` sidecars, instructed (via `supermodel skill >> CLAUDE.md`) to read the sidecar before the source.

End-to-end: `supermodel` → zip repo → `POST /v1/graphs/supermodel` (`X-Api-Key`, `Idempotency-Key`) → server tree-sitter parse + LLM domain naming → async job; CLI re-POSTs the same key to poll → SIR graph JSON returned → CLI renders `.graph.*` sidecars → daemon stays up, re-zips changed files on UDP trigger, merges the partial graph, re-renders → `Ctrl+C` cleans all sidecars.

## 3. Deterministic or agentic?

**Hybrid, mostly deterministic.** Graph construction is deterministic (tree-sitter parse, BFS reachability for dead code, Tarjan's SCC for cycles, reverse-BFS for impact). The **one** agentic leaf: domain *naming* uses an LLM (OpenRouter + Google AI) — but domain *clustering* is algorithmic and the LLM output is a cosmetic label with a `DOMAIN_RELATES` fallback. Canonical "deterministic core, LLM only for a cosmetic overlay" mix.

**License per component — this is the gate for any port:**

| Component | License | Borrowable? |
|---|---|---|
| `cli` (Go) | MIT (© 2026 Supermodel) | Yes, with attribution |
| `mcp` (TS) | MIT | Yes |
| `audit` / dead-code-hunter (TS) | MIT | Yes |
| `sdk` (TS) | **UNLICENSED** | **No** — public repo, no LICENSE file = all rights reserved |
| **server graph engine** | **not public** | **N/A — this is what "may be open-sourced soon" refers to** |

The thing worth porting (the graph engine) is the one thing not yet available. Everything currently public is MIT and already borrowable. Full license decision matrix: design doc §2.

## 4. Substrate vs. surface

- **Surface:** the CLI, the `.graph.*` sidecar convention, the MCP server, the GitHub Action. All MIT, all public.
- **Substrate:** the server-side graph engine — tree-sitter parse → call/dep graph resolution → dead-code ranker → impact BFS → domain clustering → the SIR (Supermodel Intermediate Representation: one bundle, shared node IDs across all four graph layers). **This is behind the API.** It cannot be code-borrowed today — but it *can be invoked* via the MIT Go CLI as a subprocess.

## 5. Lane (1–6)

**Lane 3 (substrate)** primarily — the graph engine is a reusable capability that overlaps `project-graph.ts` / `impact-analysis.ts` / `structural-checks.ts`. Secondary **Lane 4 (pattern)** — the writing-vs-modifying regime, shard economics, and the "polling IS submission" job model are already captured in the four `reference_supermodel_*` memories.

## 6. Dependency & displacement

- **Deps:** porting the engine in-process would add **tree-sitter + one grammar per language** — a heavy hit against the one-runtime-dep stance (INTAKE §6). The answer to beat: **invoke the MIT `supermodel` Go binary as a subprocess** — zero dependency, zero license risk, available today.
- **Displacement:** directly overlaps `src/harness/project-graph.ts` (call/dep graph), `src/harness/impact-analysis.ts` (blast radius), `src/harness/structural-checks.ts` (cycles, export surface), `src/harness/trigram-index.ts` (file index). A port is a *swap/merge* into the existing harness graph layer, not greenfield.

## 7. Smallest spike (≤1 day)

Invoke the already-MIT `supermodel` binary as a subprocess from a throwaway probe; run `supermodel analyze --no-shards -o json` on this repo; diff its call graph against `project-graph.ts`'s. Answers "is their engine actually better than ours?" with zero dep and zero license exposure, with no waiting for open-source. If yes → the port runbook (design doc §8). If no → the whole port question closes here.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|---|---|---|---|
| Free CLI (P1) | Deterministic graph engine — *if* permissively open-sourced. Until then: subprocess-invoke the MIT binary. | §7 | now (subprocess) / parked (in-process port) |
| Guardrails / Agent CI (P2–5) | LLM domain-*naming* — the agentic leaf; routes to a cloud surface per the determinism filter | — | parked |

## 9. Artifact

RFC — [`docs/design/supermodel-port-groundwork.md`](../design/supermodel-port-groundwork.md) holds the full teardown (reference spec to diff against on open-source), the licensing gate, the component→module seam map, the proposed `GraphEngine` scaffold, and the day-it-drops runbook. Re-triage this page when the server engine's license is known.

## Notes

Marketing-vs-reality flags found by reading source (full list in the design doc §4):

- "Supermodel maps every file… in your repo" — the CLI maps nothing; analysis is 100% server-side (`go.mod` carries no parser).
- "Do you store my code? **No.**" — code *is* uploaded to Azure Blob and extracted to worker disk; deleted "in seconds," worst case 60 minutes.
- "offline-first / incremental" — a cold repo *requires* the API; every incremental change also calls it.
- MCP server "brings the **full** code graph API into editors" — the production MCP server exposes exactly **one** tool (`symbol_context`).

Related memories: `reference_supermodel_thesis.md`, `reference_supermodel_dead_code_playbook.md`, `reference_supermodel_api_surface.md`, `reference_supermodel_company_gtm.md`. **The last is wrong** — it states "MIT CLI/SDK/MCP-server"; the SDK is `UNLICENSED`. Refresh on next memory pass.

## Methodology notes

This intake was filed *after* a full reverse-engineering pass (9 repos cloned and read, all 12 blog posts, the docs site, the live API contract), not before — the usual order is reversed because the user asked for the teardown first. The rubric still earns its place: it forced the lane/determinism/dependency triage that the freeform teardown skipped, and surfaced the subprocess-invoke option (INTAKE §6 "invoke over import") that the teardown buried. The deep material lives in the design doc; this page stays one page on purpose.
