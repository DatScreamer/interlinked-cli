# narsil-mcp

- **Source:** https://github.com/postrv/narsil-mcp (cloned to `reference-repos/narsil-mcp`, MIT OR Apache-2.0, v1.7.0, last commit 2026-05-12, 1,763 tests)
- **Encountered:** 2026-05-15, direct pointer for adoption evaluation
- **Verdict:** PR (FP-suppression borrows) + RFC (declarative content-check format; narsil-as-Tier-3-subprocess). Not a skip — substrate-rich, permissively licensed, deterministic.

## 1. Core idea (one sentence, your words)

A Rust MCP server that gives an agent 90 tools for deep, offline code intelligence — tree-sitter parsing of 32 languages, symbol/call-graph/CFG/DFG analysis, flow-sensitive taint tracking, and a YAML-driven security-rule engine (~13 rulesets, 4,862 lines of OWASP/CWE/crypto/secret patterns).

It is the **opposite surface** from interlinked-cli: narsil is a tool the agent *reaches for* (MCP server); the harness is the thing that *reaches around* the agent (PreToolUse/PostToolUse interceptor). They don't compete — narsil is a substrate quarry.

## 2. Anatomy (concrete walkthrough)

Annotated directory map (`reference-repos/narsil-mcp/`, ~58.7K lines Rust in `src/`):

```
rules/*.yaml          13 files, 4,862 lines — the security-rule CORPUS (declarative)
src/security_rules.rs 4,844 lines — the rule ENGINE: RuleType enum + evaluators + entropy
src/taint/            analyzer.rs (1,326) + patterns.rs (1,449) + types.rs (709)
                      — real source→sink→sanitizer taint, DFG-backed, 71 patterns
src/ccg/ + docs/ccg-spec.md  Code Context Graph — tiered L0-L3 RDF/JSON-LD repo representation
src/index.rs          8,326 lines — tree-sitter parse → DashMap symbol index → search
src/callgraph.rs cfg.rs dfg.rs dead_code.rs   classic static-analysis graphs
src/mcp.rs tool_handlers/   the 90-tool MCP surface
```

Four load-bearing pieces, in my words:

1. **`security_rules.rs` — the rule engine.** `RuleType` is a serde-tagged discriminated union with five variants: `Pattern { patterns, safe_patterns }`, `Secret { patterns, entropy_threshold }`, `Crypto { weak_algorithms, insecure_modes, min_key_size }`, `ControlFlow { required_before, sink }`, `TaintFlow { sources, sinks, sanitizers }` (`security_rules.rs:456-497`). 13 YAML rulesets are `include_str!`-baked at compile time and parsed at startup. `evaluate_pattern_rule` runs each regex over file content, then suppresses a hit if any `safe_pattern` matches the *same line* or the line is comment-only (`security_rules.rs:910-970`). Every finding carries `cwe`, `owasp`, `remediation`, and line/col.

2. **`rules/*.yaml` — the corpus.** Pure declarative content: `bash.yaml`, `iac.yaml`, `crypto.yaml`, `config.yaml`, `secrets.yaml`, `owasp-top10.yaml`, `cwe-top25.yaml`, plus 6 language packs. Each rule is regex `patterns` + `safe_patterns` + CWE/OWASP tags + a `message` + a `remediation` string. This is the highest-value, lowest-risk asset in the repo.

3. **`taint/` — flow-sensitive taint.** A genuine source→sink→sanitizer analysis: `SourcePattern`/`SinkPattern`/`SanitizerPattern` (`taint/patterns.rs:11-53`), 71 built-in patterns (`flask_request`, `express_request`, `env_var`, `java_servlet_request`...), `SinkKind`→`VulnerabilityKind` mapping (`taint/types.rs:107-127`), DFG-backed propagation in `analyzer.rs`. This is what interlinked's `taint-tracker.ts` is *not* — see §3.

4. **CCG (`ccg/` + `docs/ccg-spec.md`).** A tiered, machine-consumable repo representation: L0 manifest (~2KB, "always in context") → L1 architecture (~50KB) → L2 symbol index → L3 full RDF/N-Quads. Explicit design goal: "L0+L1 always fits in an LLM context window." See §Notes — this is a near-exact independent re-derivation of interlinked's structure artifact graph.

What the user invokes: `narsil-mcp --repos . --git --call-graph` (an MCP server over stdio). What the agent sees: 90 tool schemas (~12K tokens; presets cut to 26/51).

End-to-end session: agent calls `scan_security` → engine selects rules whose `languages` includes the file's language (or is empty = all) → runs each `Pattern` regex over content → drops hits matched by a `safe_pattern` → for `Secret` rules, computes Shannon entropy of the matched span and drops it below `entropy_threshold` (`security_rules.rs:1100-1106`) → returns `SecurityFinding[]` with CWE/OWASP/remediation.

## 3. Deterministic or agentic?

**Overwhelmingly deterministic.** tree-sitter parsing, regex rule evaluation, Shannon-entropy gating, DFG-based taint, BM25/TF-IDF search, SBOM/OSV/license — all deterministic, no model in the loop. The *only* agentic component is optional neural embeddings (`--neural`, Voyage/OpenAI API or local ONNX), off by default. narsil clears interlinked's determinism filter cleanly — rare for a tool this capable.

**License: MIT OR Apache-2.0.** Permissive — code-borrow (lane 3) and reuse (lane 5) are both unblocked. The `rules/*.yaml` corpus is shippable as data; the engine is portable; the binary is `cargo install`-able and invoke-as-subprocess is unconditionally fine. (The CCG *spec* is CC BY 4.0 — a spec, not code; fine to implement against.)

## 4. Substrate vs. surface

- **Surface:** the 90-tool MCP server. Not adoptable — interlinked-cli is not an MCP server, and a 12K-token tool schema is the opposite of what the harness wants. Skip the surface entirely.
- **Substrate, cleanly separable:**
  - (a) the `rules/*.yaml` corpus — just data, copy it;
  - (b) the `RuleType` declarative schema — a format, re-implementable in ~150 lines of TS;
  - (c) FP-suppression helpers — `calculate_entropy`, `is_security_exemplar_file`, `strip_inline_test_code`, `is_comment_only_line` — each <30 lines, independently liftable;
  - (d) the flow-sensitive taint *engine* — NOT separable cheaply (needs tree-sitter + DFG; ~3.5K lines); but its 71-pattern *catalog* is data and is liftable;
  - (e) the whole binary — invoke as a subprocess from a non-latency-critical tier.

## 5. Lane (1–6)

**Primary: Lane 2 (detection technique).** Secondary: **Lane 3** (substrate — declarative content-check format), **Lane 4** (pattern — CCG convergence), **Lane 5** (cloud — narsil-as-subprocess for Tier 3).

Justification for multi-lane (the rubric says pick one or two): narsil is a 58K-line *repo*, not an atomic technique or tool. The INTAKE rubric implicitly assumes the unit of evaluation is small. A repo this size legitimately decomposes into pieces that each land in a different lane. The discipline the rubric wants is still applied — each candidate below is named with its own lane, spike, and surface, and the Lane-1 (no imperative content) and Lane-6 (neural/WASM/LSP/SPARQL/frontend/SBOM) verdicts are explicit rejections, not omissions.

## 6. Smallest spike

**Entropy-gated secret detection** — ≤½ day, PR-ready, Lane 2.

interlinked's `src/harness/quality-checks/secret-detection.ts` is verified pure-regex: `containsSecrets()` does `pattern.test(content)` with zero entropy confirmation. A regex match for a 40-char base64 span fires on `AKIAXXXXXXXXXXXXXXXX`, `sk_test_00000000000000000000`, doc placeholders, and lockfile hashes alike. narsil's fix is `calculate_entropy` (`security_rules.rs:2136-2153`, ~15 lines of Shannon entropy) used as a *confirmer*: drop a match whose entropy is below threshold.

Spike: port `calculateShannonEntropy(s: string): number`; in `containsSecrets`, after a pattern matches, extract the matched span and require entropy ≥ ~3.5 before reporting (skip for structurally-unambiguous patterns like `-----BEGIN ... PRIVATE KEY-----`). Per `feedback_generalize_across_codebases.md`, ship with ≥3 positive (real high-entropy keys) and ≥3 negative (`AKIA` + repeated chars, `sk_test_0000…`, sequential placeholders) cases.

## 7. Artifact

- **PR #1 (this spike):** entropy gate in `secret-detection.ts`.
- **PR #2 (~½ day, Lane 2):** `isSecurityExemplarFile()` — skip files that *are* security-rule definitions (regex-pattern-dense by design). interlinked's harness scans its own `src/harness/checks/*.ts`; verify via dogfooding (`feedback_dogfood_harness_from_errors.md`) whether content checks self-fire there, and on any user repo with a `rules/`-style directory.
- **PR #3 (~1 day, Lane 2/3):** inline-test-region stripping with line-number preservation — narsil's `strip_inline_test_code` blanks `#[cfg(test)]` regions (spaces, keep newlines) so scans don't fire on intentional test vulnerabilities. interlinked already excludes *whole* test files; the delta is in-source colocated tests (`describe`/`it`, `if (import.meta.vitest)`).
- **RFC #1 (Lane 3):** a declarative content-check format — a `RuleType::Pattern`-equivalent. Today every harness check is hand-coded TS (`CheckRegistration.fn`); the `guard-rules.json`/`distilled-rules.json` declarative path covers only PreToolUse *tool-input* matching, not PostToolUse *file-content* analysis. A generic `patternCheck(patterns, safePatterns)` factory + a YAML/JSON loader would let narsil's corpus load as data. Defensible against `feedback_taste_enforcement.md`: taste checks stay hand-coded; *security-correctness* rules (bash/IaC/crypto coverage interlinked lacks) are not taste and earn a data-driven path. The `ControlFlow` rule type (operation A must precede sink B — line-order, deterministic) is a check *kind* interlinked has no equivalent for.
- **RFC #2 (Lane 5):** invoke `narsil-mcp` as a subprocess from Tier 3 async deep review (`docs/design/tier-3-async-deep-review.md`). The heavy machinery — call graph, CFG/DFG, flow-sensitive taint, dead-code — is too expensive for the per-edit PostToolUse budget but is exactly a pre-push deep-review payload. Don't reimplement narsil's 3.5K-line taint analyzer in TS; `cargo install narsil-mcp` and shell out. License permits it unconditionally.

## 8. Surface

`interlinked-cli` (PRs #1–3, RFC #1) + `guardrails-cloud` / `agency-cloud`
(RFC #2 and the code-intelligence mapping below — narsil as the Phase 4/5
deep-analysis step).

## 9. Code-intelligence & quality half — phase mapping

§1–8 cover narsil's security machinery. The other ~90% of the repo is
code-intelligence: symbol index, call graph, CFG, DFG (reaching defs, dead
stores, uninitialized vars), dead-code, complexity metrics, type inference,
import graph, AST-aware chunking, BM25/TF-IDF search, incremental
Merkle-tree indexing. **All of it is deterministic** — tree-sitter parsing
plus graph algorithms, no model in the loop (the lone exception, neural
embeddings, is off by default).

**Determinism does not place it.** The INTAKE filter routes *agentic* work
to cloud; it is necessary-not-sufficient for CLI placement. narsil's
code-intelligence is deterministic yet most of it still lands in cloud
phases — because the binding constraint is **compute budget × surface**,
not determinism. A whole-repo tree-sitter call-graph build does not fit a
per-edit PostToolUse budget no matter how deterministic it is.

| narsil capability | Phase | Rationale |
|---|---|---|
| Symbol index, import graph, circular imports, blast radius | **1** (partial today) | Harness already has regex analogs in `project-graph.ts` / `structural-checks.ts` / `impact-analysis.ts`, daemon-resident and incremental. The trigram index (`interlinked index build`) proves Phase 1 can host an incrementally-updated code index. |
| Complexity, dead exports/imports | **1** (present today) | Harness has heuristic versions. narsil is the accuracy ceiling, not a rewrite mandate — `feedback_taste_enforcement`. |
| Call graph, CFG, DFG (reaching defs, dead stores, uninitialized) | **4/5** | Too heavy for per-edit; deterministic facts for the LLM deep-review coordinator to reason over instead of re-deriving. |
| Dead-code (unreachable blocks), function hotspots | **4/5** | Whole-repo, AST-backed; pre-push payload. |
| AST-aware chunking, BM25/hybrid search | **4** | Retrieval substrate for the LLM reviewer. Harness already has trigram search for Phase 1. |
| CCG L0/L1 tiered manifest | **4** | Purpose-built "context-efficient codebase representation for LLMs with limited context windows" — the natural input artifact for the Phase-4 Coordinator+Specialists reviewer. |
| SBOM / OSV / license | **5** | Phase 5 already plans a `sbom-license` step (cdxgen + OSV); narsil is a drop-in alternative. Harness has `dep-audit` for Phase 1. |
| Type inference (`infer_types`, `check_type_errors`) | **— skip** | Redundant. The harness already shells to real `tsc` / `mypy`, strictly more accurate than narsil's inference. |

**Phase 1 (Free CLI / harness).** The harness already has the regex-grade
analogs, and the trigram index proves a daemon-resident, incrementally-
refreshed code index works inside the per-edit budget. Going *narsil-grade*
(tree-sitter call-graph / CFG / DFG) means taking a tree-sitter dependency —
against the project's stated single-runtime-dependency principle (`commander`
only). That makes accurate structural analysis an **RFC-level decision**, not
a quick win. The narrow Phase-1 borrow: `find_dead_stores` /
`find_uninitialized` could become heuristic harness checks if a lightweight
(non-DFG) version clears the FP bar.

**Phase 4/5 (Agent CI).** The strong home for the full machinery. narsil
runs as a subprocess deep-analysis step inside `ScanCoordinatorWorkflow`,
beside the already-planned `mutation-run` / `test-suite` / `sbom-license`
steps, emitting structured facts — call graph, CFG/DFG, dead code,
complexity, taint — that the `gpt-oss-120b` coordinator consumes rather than
re-derives. CCG L0/L1 is the context artifact. This is the
`ai-agent-orchestration-patterns` shape: deterministic facts → shared
context file → specialists. Don't port narsil to TS; `cargo install` it and
shell out (license permits it unconditionally).

**Phase 2/3 (Guardrails).** Weak fit. Guardrails is tool-dispatch Cedar
policy enforcement, not code analysis. One narrow exception: a precomputed
import-graph / blast-radius lookup could let a Cedar policy reason about what
a tool call's target file affects ("block edits inside the auth module's
blast radius"). Minor — not a phase driver.

## Notes

- **CCG ≈ structure artifact graph — independent convergence.** narsil's Code Context Graph (`docs/ccg-spec.md`) and interlinked's generic artifact structure (`docs/generic-artifact-structure-v1-spec.md`) independently arrived at the same shape: a tiered, size-bounded, progressive-detail representation of a codebase, justified by "the small layers always fit in an LLM context window." narsil: L0 manifest → L1 architecture → L2 symbol index → L3 full RDF. interlinked: L0 `structure.json` → L1 committed artifacts → L2 generated cache. The layer *semantics* differ (interlinked L1 is human-authored; narsil L1 is generated) but the spine is identical. Two findings: (1) the convergence is external validation of the structure-graph direction; (2) CCG is a concrete *interop export target* — an `interlinked structure export --ccg` emitting L0/L1 JSON-LD would let other tools (and the codecontextgraph.com registry) consume interlinked's graph. RFC-worthy, not urgent.
- **Taint terminology collision.** interlinked's `taint-tracker.ts` is session-level Bell-LaPadula *classification* (label a session Public→Confidential, ratchet up, block network egress above a threshold). narsil's taint is classic flow-sensitive *source→sink→sanitizer* data-flow over a DFG. Same word, different mechanisms — don't conflate them in any future RFC. narsil's 71-pattern source/sink/sanitizer catalog is borrowable data; its DFG engine is not borrowable cheaply.
- **What's deliberately skipped (Lane 6):** neural embeddings, WASM build, LSP integration, SPARQL/RDF Oxigraph store, the Cytoscape visualization frontend, SBOM/OSV supply-chain (interlinked already has `dep-audit`), the tool-preset/token-budget machinery (irrelevant — the harness exposes no MCP tools), Forgemax Code Mode.
- **Verified, not assumed:** `secret-detection.ts` is pure-regex (read it); the `RuleType` enum has exactly 5 variants (`security_rules.rs:456`); `calculate_entropy` is Shannon over char frequency (`security_rules.rs:2136`); narsil is MIT/Apache and actively maintained (commit 2026-05-12).
- **Related external-pulse entries:** `serena.md` (LSP-based code intelligence), `failproofai.md` (deterministic-policy competitor), `cursor-harness.md`. narsil is closest to the "deterministic code-intelligence substrate" category — distinct from the policy-enforcement competitors.

## Methodology notes

The rubric's "pick one or two lanes" instruction frays on a large multi-capability repo. A 58K-line repo is not the rubric's natural unit — it's a quarry, and the honest output is per-capability lane assignment, not a single verdict. Suggested INTAKE.md edit if this recurs: add a line to §"The six lanes" — *"For a large multi-capability repo, decompose into capabilities and lane each one; the repo's overall verdict is the union. Still name an explicit Lane-6 rejection list so 'skip' isn't silent omission."* The per-capability table in §6/§7 above is the working pattern.

The determinism filter is necessary-not-sufficient for CLI placement. INTAKE.md frames it as "agentic → lane 5 (cloud), deterministic → CLI." narsil §9 is the counter-case: deterministic code-intelligence that still belongs in cloud phases because the binding constraint is compute budget, not model-in-the-loop. Suggested INTAKE.md edit: §"The dominant filter" should note that determinism *clears* a capability for the CLI but a second gate — per-edit compute budget — still applies; heavy deterministic work routes to the deep-review tier just as agentic work does.
