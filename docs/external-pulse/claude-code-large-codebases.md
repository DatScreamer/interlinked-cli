# Claude Code in large codebases — Anthropic best-practices article

- **Source:** "How Claude Code works in large codebases: Best practices and where to start" — Anthropic blog, *Claude Code at scale* series, 2026-05-14. URL not captured (full text pasted into chat).
- **Encountered:** 2026-05-18, user pasted the full article + `@INTAKE.md` pointer in an interlinked-cli session, asking how to apply it to the harness.
- **Verdict:** RFC (LSP-backed symbol resolution — this article completes a 3-source cluster) + memory note (validates the local-index stance; corroborates `cursor-harness.md`'s recorded "scaffolding decays" disagreement).

## 1. Core idea (one sentence, my words)

Claude Code searches a large codebase by navigating the live filesystem — grep, read, follow references, like an engineer — instead of querying a precomputed index, so its effectiveness at scale is set by the surrounding configuration (context files, hooks, skills, plugins, MCP servers, and especially LSP servers) more than by the model.

## 2. Anatomy (load-bearing claims — prose source)

Six claims worth carrying forward:

1. **Agentic search beats RAG at scale.** A centralized embedding index goes stale faster than an active team commits; live filesystem navigation is never stale. Tradeoff: agentic search needs good *starting* context (CLAUDE.md, skills) to know where to look, or it burns the context window wandering.
2. **"The harness matters as much as the model."** The harness = five extension points (CLAUDE.md, hooks, skills, plugins, MCP servers) + LSP + subagents. Build order matters; each layer builds on the prior.
3. **CLAUDE.md must be lean and layered.** Root file = pointers and critical gotchas only; subdirectory files = local conventions, loaded additively as Claude walks the tree. Anything in the root that doesn't apply broadly is noise that drags every session.
4. **LSP is "one of the highest-value investments"** for multi-language codebases. Symbol-level resolution (find-references / go-to-definition) filters to the *right* references before the agent opens any file; without it the agent text-pattern-matches and lands on the wrong symbol. Enterprises deploy LSP org-wide *before* a Claude Code rollout.
5. **Configuration decays.** Hooks and skills built to compensate for *specific model limitations* become overhead once the limitation is gone (the article's example: a write-intercepting hook forcing `p4 edit` became redundant when Claude Code shipped native Perforce mode). Review config every 3–6 months / after major model releases.
6. **The org layer.** A DRI or "agent manager" must centralize what works or setups stay tribal; governance (who controls skills/plugins; AI-code review parity) surfaces early in regulated orgs.

**Disentangle "harness" first.** The article's "harness" is the *five Claude Code extension points*. interlinked's "harness" is the deterministic guard/lifecycle daemon — which, in the article's taxonomy, is one component plugged into a *single* extension point: **hooks**. So claims 3 and 6, and the skills/plugins parts of claim 2, are *adjacent* to interlinked's harness, not about it. The claims that land *on* interlinked's harness layer are **4** (the harness does symbol resolution — claim 4 says do it with a language server) and **5** (decay applies to harness checks). Claim 1 is a *validation* of an interlinked design choice already made. That triage is the answer to "apply this to our harness": most of the article isn't about it.

## 3. Deterministic or agentic?

Hybrid. **LSP — fully deterministic** (a language server, no model in the loop); this is the one CLI-relevant deterministic extract. **Agentic search** is agent-driven, but its deterministic alternative — a local code index — is exactly what interlinked's trigram index already is (see §6). The one purely agentic slice — a stop hook that *reflects on a session and proposes CLAUDE.md edits* — is LLM-as-judge and auto-routes to lane 5 per `feedback_harness_deterministic_only.md`. License: N/A — a blog post, nothing to borrow as code.

## 4. Substrate vs. surface

N/A as a product split (prose source). The one extractable substrate: a **warm, daemon-hosted LSP client as a deterministic symbol-resolution backend** for the harness's own checks — distinct from `serena.md`'s framing of LSP as an agent-facing MCP *tool*. See §6.

## 5. Lane (1–6)

**Lane 4 (pattern) primary**, with the load-bearing extract in **lane 3** and one slice in **lane 5** — multi-lane for the same reason `narsil-mcp.md` / `cursor-harness.md` are: a best-practices article is a bundle of patterns, not an atomic technique.

- **Lane 3** — LSP as a symbol-resolution substrate for `structural-checks.ts` / `impact-analysis.ts` / `project-graph.ts`. This is **the same finding as `serena.md` §4 lane 3** ("LSP-grounded answers would be higher-fidelity" than the regex/AST heuristics). Not new — escalated. See §Notes (pattern cluster).
- **Lane 5** — stop-hook session-reflection → CLAUDE.md-update proposals. Agentic; cloud-roadmap fodder, not the CLI.
- **Lane 2 (latent, thin)** — a check that warns when a CLAUDE.md / AGENTS.md exceeds a size or nesting threshold (claim 3, "lean and layered"). `/enforce` already parses these files, so the hook point exists. Minor; not the headline.

## 6. Dependency & displacement

- **Deps:** LSP servers are **invoke-as-subprocess** (the binary), so **zero npm runtime deps** — *provided* the JSON-RPC/LSP client is hand-rolled (Content-Length-framed JSON-RPC; on the order of a few hundred lines for `initialize` / `didOpen` / `didChange` / `references` / `definition`, in keeping with the project's hand-rolled-everything stance — do **not** import `vscode-languageserver-protocol`). The LSP *binary* (`typescript-language-server`, …) is an *environmental* dependency, handled by PATH detection + graceful fallback + a `doctor` line. **Cross-find:** this is where LSP beats tree-sitter — `narsil-mcp.md` §"Phase 1" flags tree-sitter as multiple npm deps against the single-runtime-dependency principle; LSP, as a subprocess, has no such cost. The article's LSP recommendation is the dependency-filter-correct choice over narsil's tree-sitter path.
- **Displacement:** overlaps `project-graph.ts`, `structural-checks.ts` (`import_resolution` / `export_surface` / `import_cycles`), and `impact-analysis.ts` (`interface_change_impact`). LSP does not *replace* them — it is a higher-precision *backend* for the same questions, with the existing regex path kept as graceful fallback when no LSP binary is present (the trigram-index / `grep-accelerator.ts` "optional warm accelerator + fallback to the un-accelerated path" shape — four fallback points in `grep-accelerator.ts`, each returning `null` so normal grep still runs). Today those regex checks carry no `[proven]` tag (`classifyDeterminism` returns `null`; they are not in `PROVEN_TOOL_CHECKS`); LSP-backed resolution would let them earn `[proven]`, as tsc-backed checks such as `export_ripple` already do. **New machinery genuinely introduced:** a *long-lived child process*. Every harness subprocess today is one-shot `spawnSync`; an LSP server is the first persistent child — spawn / keep-warm / restart-on-crash / `didChange`-sync / per-language-per-project lifecycle is the RFC's core engineering content.

## 7. Smallest spike

≤1 day, dogfooded on this repo (`feedback_dogfood_harness_from_errors.md`). From the harness daemon, spawn `typescript-language-server --stdio`, hand-roll the Content-Length JSON-RPC framing, `initialize` → `didOpen` one file → issue one `textDocument/references` for a symbol with a known reference count, and diff the LSP result against what `impact-analysis.ts` / `project-graph.ts` produce for the same symbol. Record (a) agreement/disagreement — LSP catches re-exports, type-only imports, and overloads the regex mis-attributes — (b) warm round-trip latency, (c) tsserver cold-start cost. Disagreement that matters is the green light for the RFC.

`serena.md` §5 Spike A (detect Serena on PATH, consume its MCP `find_references`) is the faster-but-throwaway alternative for pure signal. Prefer the native probe: it de-risks the architecture you'd actually ship and adds no Python/uv environmental dependency. Full integration is multi-week — hence the RFC verdict; this probe is only the calibration.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | Native daemon-hosted warm LSP client; `[proven]` symbol resolution for `import_resolution` / `export_surface` / `import_cycles` / `interface_change_impact`, regex checks kept as fallback | §7 | next |
| Agent CI (P4–5) | Whole-repo LSP-backed breaking-change scans (every downstream break for a PR); cold-indexing a large repo is the `narsil-mcp.md` §9 "heavy deterministic → cloud" case | looser — fan-out scan over a warm server pool | parked |

No Guardrails (P2–3) row: symbol resolution feeds warnings and impact, not the sub-second block decision. The one thin touchpoint — a precomputed blast-radius lookup a Cedar policy could read — is already logged in `narsil-mcp.md` §9 and is not driven by this article.

## 9. Artifact

**RFC** — LSP-backed symbol resolution for the harness's structural/impact checks, landing in `docs/design/`. The RFC's central open question is **LSP vs. tree-sitter** as the resolver; §6 argues LSP wins on the dependency filter. It should adopt a native daemon-hosted LSP client rather than `serena.md` §5 Spike A's Serena-MCP-consumer framing (see §7), and cross-reference `narsil-mcp.md` (the tree-sitter alternative). The §7 spike is the PR-able first step. The memory-note dimension of the verdict is satisfied by this file's §Notes — no separate entry. (`serena.md` warrants a one-line forward cross-reference to this file — corpus hygiene; flagged, not done unilaterally.)

## Notes

- **Pattern cluster — "a real resolver beats regex symbol-resolution" is now 3-source.** `serena.md` (LSP via MCP), `narsil-mcp.md` (native tree-sitter — it explicitly *skipped* LSP, choosing tree-sitter), and this article (native LSP, ranked "highest-value") independently say the harness's regex symbol-resolution is the heuristic floor and a real parser/server is the ceiling. Per the corpus's 3rd-affirmation→RFC rule (goose.md, noted in `cursor-harness.md` §Notes), this crossing is the RFC trigger; `serena.md`'s lane-3 LSP finding has sat parked since 2026-04-29 waiting for exactly this. The mechanism split — LSP vs. tree-sitter — is the RFC's open question, not a blocker.
- **Validation, not action — the trigram index.** interlinked's index is local-per-developer, lexical (trigrams, not embeddings), incrementally refreshed, with an in-memory dirty layer (`trigram-index.ts`). That is precisely the article's prescription; its RAG-staleness critique targets *centralized embedding* pipelines and does not bite. The index is an *accelerator* for agentic search, not a RAG substitute — it fails open to plain grep. interlinked's only embedding use is `error-history.ts` (optional, append-only, not a code-search index) — also outside the critique.
- **Decay thesis — corroborates a recorded disagreement.** Claim 5 echoes Cursor's "static guardrails decay" thesis, already logged in `cursor-harness.md` §5 / §Notes as a deliberate disagreement with `feedback_taste_enforcement.md`. But the article's phrasing is the *precise* one: hooks/skills "built to compensate for **specific model limitations**" decay. Taste/safety checks (`rm -rf`, raw-SQL-concat, magic literals) are model-capability-independent invariants, not model crutches — so the article, read precisely, **sharpens rather than overturns** `feedback_taste_enforcement.md`. Actionable residue is thin: interlinked has few model-crutch checks; no new artifact, but a config-review habit is worth adopting.
- **"Harness" is now a two-sense term across the corpus.** `cursor-harness.md` recorded the term *converging* with Cursor's usage (deterministic model-wrapper = interlinked's sense). This article uses it for the *extension ecosystem* (CLAUDE.md / hooks / skills / plugins / MCP). The term has split; pin it so future agent-driven design doesn't conflate them.
- **Out of scope:** the article is about one developer's session in a big repo; interlinked's multi-agent coordination (reservations, cohort) is orthogonal. "Subagents split exploration from editing" is single-user and already supported in spirit.

## Methodology notes

- Second pure-blog-post intake about "the harness" after `cursor-harness.md`. Pattern: a vendor "how our harness works" post is mostly validation + corroboration of existing corpus findings; its value is the *one finding it escalates*. Here it completed the 3-source LSP cluster.
- **A non-new find can still be a high-value intake.** `serena.md` already had the LSP / lane-3 finding; this article adds no fresh finding — yet it changes the verdict (parked → RFC) by completing a cluster. Suggested INTAKE.md note: an intake whose contribution is *escalating an existing corpus finding past the 3-source RFC threshold* is valid output — record it as a cross-reference + verdict change, not a fresh finding.
- "Read the source, not the README" → for a multi-claim article, extract the *specific* claims, not the title. The headline ("best practices and where to start") underplays the load-bearing parts: the LSP "highest-value" ranking and the config-decay caution, neither visible from the section headers.
