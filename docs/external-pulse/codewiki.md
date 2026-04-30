# CodeWiki

- **Source:** https://fsoft-ai4code.github.io/CodeWiki/ • https://github.com/FSoft-AI4Code/CodeWiki • https://arxiv.org/abs/2510.24428
- **Encountered:** 2026-04-29, linked while drafting this rubric
- **Verdict:** memory note (lane 5 primary, lane 3 latent)

## 1. Core idea (one sentence, your words)

CodeWiki ingests a source repo and emits a hierarchical wiki — `overview.md` plus per-module markdown plus a `module_tree.json` — by recursively decomposing the codebase into modules and asking an LLM to write each module's documentation page.

## 2. Deterministic or agentic?

**Hybrid, but the load-bearing decisions are agentic.** The repo splits cleanly:

- **Deterministic substrate** — `codewiki/src/be/dependency_analyzer/`:
  - `ast_parser.py` (7 KB) — multi-language AST parsing across Python, Java, JS, TS, C, C++, C#
  - `dependency_graphs_builder.py` (4.4 KB) — import / dep-graph construction
  - `topo_sort.py` (12.8 KB) — topological ordering
- **LLM-driven decision layer** — `codewiki/src/be/`:
  - `cluster_modules.py` (4.8 KB) — the "dynamic programming-inspired" decomposition. Recursive in shape, with a token-budget cutoff, but the actual *clustering decision* is an LLM call: `response = call_llm(format_cluster_prompt(...), config, model=config.cluster_model)`. The DP framing describes the recursion + token guard, not the algorithm.
  - `agent_orchestrator.py`, `documentation_generator.py` (13.7 KB), `prompt_template.py` (15.4 KB of prompts) — fully LLM-driven, multi-agent recursive delegation.

**Marketing-vs-reality flag.** The README and landing page describe the decomposition as "dynamic programming-inspired" without disclosing that the leaf decision is an LLM. Reading `cluster_modules.py` directly was necessary to settle this — exactly the failure mode the rubric exists to catch.

## 3. Substrate vs. surface

- **Surface:** auto-generated wiki documentation. A documentation product.
- **Substrate:** polyglot dependency analyzer (7 languages) — AST → import graph → topo sort. Conceptually borrowable to extend `project-graph.ts`, which is TS/JS-centric.

The substrate is borrowable in **concept**, not in **code** — it's Python, would need rewrite for the Node harness — and the harness's working surface is JS/TS, so polyglot dep-graph expansion is a nice-to-have, not a constraint currently being hit.

## 4. Lane

**Lane 5 (cloud-only fodder) primarily, with a thin sliver of lane 3.**

The headline product — multi-agent LLM-driven repo wiki — is precisely what the CLI harness is forbidden from hosting (`feedback_harness_deterministic_only.md`). It's also adjacent-but-not-identical to the existing paid-product thesis: guardrails-cloud and agency-cloud are about *guarding AI agents writing code*, not *generating documentation from existing code*. So even on the cloud roadmap, this is a different product category — a hypothetical "docs-cloud" line — not a feature drop into either of the planned products.

The lane-3 substrate (polyglot dep graph) is real but solves a problem we don't currently have.

## 5. Smallest spike

None proposed at present. The cloud-side application would open a new product line out of scope for the current roadmap; the CLI-side substrate borrowing is below the priority bar.

If forced to pick a half-day calibration: run CodeWiki against the `interlinked-cli` repo and record (a) wall-clock + token cost end-to-end, (b) whether the generated wiki adds any signal an agent doesn't already get from `CLAUDE.md` + `docs/`. Useful input to the agency-cloud / supermodel design discussions ("what does multi-agent repo summarization actually buy a cold agent?") even if CodeWiki itself is never adopted. Skip unless that question becomes load-bearing.

## 6. Artifact

Memory note (this file). No PR, no RFC, no roadmap entry today.

## 7. Surface

None today. If revisited:
- Lane-3 substrate borrowing → CLI (would extend `project-graph.ts` toward polyglot)
- Lane-5 product reuse → new "docs-cloud" line, out of current scope

## Notes

- Self-benchmarked on CodeWikiBench (their own benchmark, 21 repos): 68.79% Sonnet-4 vs. 64.06% baseline. Treat the absolute number as low-evidence (single-author benchmark).
- They ship an MCP server at `codewiki/mcp/`. Worth a separate look if/when we want to expose harness or CLI capabilities to clients over MCP — distinct from the CodeWiki product itself.
- Methodology lesson worth carrying into the rubric: "algorithmic" / "DP-inspired" / "deterministic pipeline" framings can hide LLM calls at the leaves. **Always read the load-bearing function in source before classifying determinism**, not the README. This case took one `gh api` call to settle.
