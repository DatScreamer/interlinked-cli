# Serena

- **Source:** https://github.com/oraios/serena (clone at `reference-repos/serena`)
- **Encountered:** 2026-04-29, third worked example after CodeWiki and agent-ci
- **Verdict:** lane 3 (substrate-integration via MCP) + lane 4 (pattern reinforcement). MIT-licensed, no license gate.

## 1. Core idea (one sentence, your words)

Serena wraps language servers (LSP) and JetBrains IDE backends behind an MCP server, exposing IDE-grade symbol-level operations (find_symbol, references, rename, type hierarchy, AST-aware edits) as tools that coding agents consume — explicitly positioning itself as "the IDE for your coding agent" rather than as an agent itself.

## 2. Deterministic or agentic?

**Deterministic.** Serena performs no LLM inference. Quote: *"Serena provides the necessary tools for coding workflows, but an LLM is required to do the actual work, orchestrating tool use."* The agent (Claude, Cursor, etc.) decides what to do; Serena returns ground-truth symbol metadata from the language server. This is a clean detection-vs-decision split (cf. `reference_sondera_architecture.md` in memory).

**License:** MIT. No gate.

## 3. Substrate vs. surface

- **Surface:** MCP server, launched by `serena` CLI (installed via `uv`). HTTP-exposable for remote agents.
- **Substrate** (in `src/`): `solidlsp` is their LSP-wrapper abstraction (the load-bearing piece — handles 40+ languages via per-language LSP servers); `serena` is the MCP tool surface; `interprompt` is prompt-template management for agent interactions. The substrate is real and reusable in concept — the MCP-tool packaging on top of LSP is the architectural bet.

The substrate is borrowable in concept (write our own LSP wrapper) but not in code (Python implementation, would need rewrite for the Node harness). And the harness's primary surface is JS/TS where TS Server already runs — a polyglot LSP wrapper is overkill for current scope.

## 4. Lane

**Lane 3 (substrate integration via MCP) + lane 4 (pattern reinforcement).**

- Lane 3 — `interlinked verify` could optionally query Serena's MCP for symbol-grounded checks (e.g., "is this exported function actually referenced from anywhere outside this file?"), then fold the answer into existing structural-checks output. Today our impact-analysis and dead-export checks lean on regex/AST heuristics; LSP-grounded answers would be higher-fidelity. Integration-only — we don't embed Serena, we consume its MCP surface.
- Lane 4 — Serena is the third project in this directory affirming "MCP server is the right surface for exposing semantic tools to agents" (codewiki ships an MCP server too; agent-ci's `--json` NDJSON stream is the same idea on a different protocol). Three independent affirmations across different niches make this RFC-worthy, not just a memory note. The angle: expose interlinked-cli's own state (recent activity, sensitivity classifications, active reservations, harness findings queue) via an `interlinked mcp` server so agents can introspect what the harness knows without having to parse our human-readable output.

Not lane 5 — Serena is OSS, local-first, MIT. No paid-product reuse pressure.

## 5. Smallest spike

Pick one of two half-day spikes; they're independent.

- **Spike A — consume Serena from `interlinked verify`.** Detect whether `serena` is on PATH; if so, launch its MCP server, call `find_references` for each symbol changed in the current diff, surface "modified symbol with N inbound references" alongside harness findings. License-clean (MCP consumer). Skips silently if Serena isn't installed. Calibrates whether LSP-grounded reference checks add signal beyond the existing structural-checks suite.
- **Spike B — expose interlinked over MCP.** Add `interlinked mcp` that runs an MCP server exposing 3–5 read-only tools: `get_recent_activity`, `get_sensitivity_classification(path)`, `list_active_reservations`, `get_harness_findings(session_id)`. Self-contained; no Serena dependency. Validates whether the MCP-as-tool-surface pattern earns its complexity for our state. Half a day.

Spike B is more strategically interesting (we own the surface; pattern reinforcement); Spike A is faster signal on whether LSP-grounded checks beat regex/AST.

## 6. Artifact

Memory note now; **RFC** for "interlinked-as-MCP-server" once a third unrelated project affirms the pattern (this is that third project — RFC moment is here, when the user wants it).

## 7. Surface

- **interlinked-cli** (both spikes).
- *Possibly* **agency-cloud** down the line: agents running under agency-cloud could be configured to use both Serena (symbol tools) and interlinked-MCP (harness state) as cooperative tool surfaces. But that's a roadmap consideration, not a current adoption.

## Notes

- 40+ languages supported via LSP — that's the polyglot leverage point. The interlinked harness today is JS/TS-centric; if we ever extend to other languages, *consuming* Serena's MCP rather than reimplementing per-language analysis is the cheaper path.
- "End users are essentially AI agents" — direct alignment with the interlinked thesis. Serena and interlinked are operating on adjacent layers of the same stack: Serena gives agents *capabilities* (symbol ops), interlinked gives them *constraints* (rules, ratchets, reservations). Co-deployment is natural.
- The detection-vs-decision split (Serena = detection, LLM = decision) maps onto `reference_supermodel_thesis.md` (deterministic graph > probabilistic narrator) and `reference_sondera_architecture.md` (Detect → Decide separation). Three different projects converging on the same boundary; the pattern is real.
- `solidlsp` (their LSP wrapper) is worth a deeper read if we ever pursue Spike A or build polyglot harness checks ourselves. Also worth understanding their hot-reload / file-watching strategy — that's the hard part of LSP integration.
- Their `CLAUDE.md` and `AGENTS.md` symlink pattern (one source of truth, surfaced under both filenames) is a small ergonomic detail worth mirroring if we end up writing both file types ourselves.

## Methodology notes

- Third project in `external-pulse/` lands cleanly via the rubric — five minutes from "open template" to "lane assigned" once homepage + structure + LICENSE are read. Friction is starting to amortize.
- **Pattern-cluster signal:** when three independent external projects converge on the same architectural decision (here: "MCP server is the right tool-surface for agents"), the signal is strong enough to escalate from memory-note to RFC. Worth folding into INTAKE.md as a "Pattern cluster" check at the bottom.
