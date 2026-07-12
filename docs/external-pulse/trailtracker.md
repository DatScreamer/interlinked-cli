# TrailTracker

- **Source:** https://jonathanpopham.com/trailtracker-site/ · https://jonathanpopham.com/trailtracker-site/benchmark.html
- **Encountered:** 2026-07-08, user prompt ("deep research on the TrailTracker site") — surfaced while analyzing its public renderer sibling [[ontoloom]].
- **Verdict:** **Compound.** *Parked* on the tool itself (private preview, unusable — §6). *PR* on the one cleanly-liftable method — deterministic archetype classification (§7). **Same vendor as [[supermodel]]**: Jonathan Popham / Supermodel Tools (GitHub company field, verified 2026-07-08). So this is the `project_supermodel_deprecation_graph_oracle_reanchor` thread, not a new vendor.

## 1. Core idea (one sentence, my words)

One airgapped, zero-dependency Rust binary that statically parses a repo into a canonical graph and derives seven deterministic "ontologies" from structure alone — headline being bounded-context/domain recovery from the dependency graph with **no LLM** — i.e. [[supermodel]]'s server engine minus the cloud upload and minus the cosmetic LLM domain-*naming*, rewritten as a single local binary for regulated/airgapped buyers.

## 2. Anatomy (concrete walkthrough)

Marketing site is the **only** artifact (private preview; no source, no binary, no third-party trace). Two pages read firsthand:

- **Overview** — "Seven ontologies, one graph": **Structural** (files/functions/calls/imports), **Data** (entities/typed fields — ORM/Salesforce), **Workflow** (Apex/Flow specs), **Lexicon** (identifier classification), **Archetype** (Controller/Aggregate/Repository/EventHandler — "per-language rules plus structure"), **Layer** (Domain/App/Infra/Presentation — "violations flagged, CI-enforceable"), **Domain** (bounded contexts "from dependency structure alone — rename-proof… zero LLM"). CLI verbs shown: `trailtracker brief|explain|arch-verify|extract|query`. Claims: 58 languages parsed, 0 deps, 0 network, 0.08s/540-file repo, "15 tools over MCP" serving budgeted agent context (12× less than grep-and-read).
- **`benchmark.html`** — unusually rigorous: 11 pinned open-source repos, dev/holdout dropout split, a permanent **shape gate** (top-share <50%, 3–25 domains, junk=0, ≥2 core layers), a **semantic axis** (coverage/purity/macro-F1, floor 0.70) scored against two *independent* ground truths (one hand-derived path-based, one LLM-derived) that the tool never produced, a **metamorphic verification lattice** (permutation, consistent-rename→byte-identical, additive/scope/duplication/cache stability), 20k-input property fuzz, whole-repo lossless self-analysis, a **Kani bounded formal proof** of parser losslessness, hash-attestable report — and a plainly-stated **limits** section (6 of 58 languages validated; "ontologies are heuristics with measured accuracy, not oracles"; semantic axis n=2).

The one **source-verified** slice is the `trailtracker export ontoloom <repo>` wire format (from [[ontoloom]]'s committed eShop fixture): `view:"hierarchy"` nodes at `level ∈ {domain,unit,file,symbol}` + `CONTAINS`/`DEPENDS_ON(count)` edges. "Data model" and "workflows" as distinct outputs appear only on the marketing page — unverifiable.

## 3. Deterministic or agentic? (+ license)

**Deterministic — mechanism credible, accuracy unproven.** No-LLM-in-pipeline is plausible and **well-precedented**: rule-based archetype recovery (Stereocode, IEEE SCAM 2024, GPL3 — a rule engine over srcML, no ML) and expert-system architecture recovery (CAESAR, JKSU-CIS 2023) are established LLM-free disciplines. The metamorphic evidence (rename-invariance especially) is what a genuinely deterministic tool would ship; the only LLM in the story is one of two *benchmark ground truths*. Adversarial attempts to pin a hidden LLM on it were **refuted 0-3**. **But everything is vendor-asserted/source-closed**, and the real soft spot is **accuracy, not a hidden model**: reliable bounded-context extraction from a monolith is an open problem (arXiv 2601.23141: "identifying effective service boundaries remains… unresolved"), so "macro-F1 1.000 / LLM-grade" is marketing on n=2, not fact.

**License: N/A** — no source, private preview. Nothing to code-borrow; only the *method* transfers.

## 3b. Role in its native architecture — and does it transfer?

Native role: the deterministic **oracle** of the Geist Stack (analyzer/emitter; [[ontoloom]] renders it, agents query its MCP). In our topology it would be an **index-time enrichment** of the `structure` ArtifactGraph (archetype/domain facts), not a per-edit gate. The role transfers; the *tool* does not (private). We re-implement the method on our own TS toolchain — exactly the re-anchor already decided for [[supermodel]].

## 4. Substrate vs. surface

- **Substrate:** the deterministic extractors — archetype rules, dependency-graph domain clustering, layer inference. Borrowable **only as re-implementation** (no source).
- **Surface:** the CLI, the single-file HTML "dossier", the 15-tool MCP nav-pack. Adjacent to our trigram grep-accelerator (a different answer to "budgeted agent context").

## 5. Lane (1–6)

**Lane 3 (substrate)** — the archetype/domain extractors, re-implemented. Secondary **Lane 4 (pattern)** — the metamorphic-relations determinism gate + the "two independent ground truths, never grade your own homework, disclose limits" benchmark discipline are directly adoptable to *our own* graph/check determinism and eval rigor.

## 6. Dependency & displacement

- **Deps:** **none addable** — unlike [[supermodel]]'s MIT Go CLI (which we can subprocess-invoke), TrailTracker is private, so "invoke over import" is closed. The only path is re-implementation, zero new dep (reuse the `typescript` optional-dep already loaded by `cyclomatic-ast.ts`).
- **Displacement / equivalence (capability × our status):**

| Capability | Our equivalent | Status |
|---|---|---|
| Structural graph (files/calls/imports) | `project-graph.ts` (file-level; TT is per-statement CFG/def-use) | **shipped** |
| Blast radius / impact | `impact-analysis.ts` | **shipped** |
| Layer *enforcement* (boundary rules) | `structure` `layer` nodes + `layer-boundary.ts` | **shipped** |
| Layer *inference* (auto-assign strata) | — (we declare, don't infer) | **absent** |
| **Archetype** classification | — | **absent** ← §7 |
| **Domain / bounded-context** clustering | only via the deprecating [[supermodel]] `.graph` `domains` field; internal graph returns `[]` | **absent** ← the re-anchor hole |
| Symbol graph | `ExportedSymbol` / `public_symbol` (file→file; TT+SM have fn-level calls) | **shipped** |
| Data-model / Workflow ontologies | — (ORM/Salesforce-specific; not our TS focus) | **absent, irrelevant** |
| Budgeted agent context (MCP) | trigram grep-accelerator (different mechanism) | **shipped** |

## 7. Smallest spike (≤1 day)

**Deterministic archetype classifier.** A pure `classifyArchetype(node, ctx): Archetype` in `src/harness/checks/archetype.ts`, reusing the `createRequire("typescript")` + walk pattern from `cyclomatic-ast.ts` (add `ts.isClassDeclaration`/`isInterfaceDeclaration`, heritage clauses, decorators). Rules (Stereocode's two-stage shape): per-symbol from name-suffix (`*Controller|*Repository|*Service|*Handler|*Store|*Factory`) + structural signals (decorators `@Controller`/`@Injectable`; `extends`/`implements`; key imports — ORM→Repository, router→Controller, `EventEmitter`→EventHandler); then roll the file/module archetype up from its symbols' distribution. Surface it as a new optional `archetype` field on `PublicSymbolEntry` (`structure/types.ts:150`, emitted by `module-extractor.ts`) rendered by `interlinked structure` — **descriptive fact, not a gate** (heuristic accuracy → advisory). ≥3 positive + ≥3 negative cases per archetype. No new dep, no FP-risk to existing gates. Domain clustering (Louvain over `DEPENDS_ON`) is a fatter follow-up, also advisory.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|---|---|---|---|
| Free CLI (P1) | Archetype rules (deterministic, per-file → CLI fact); domain clustering (deterministic mechanism, accuracy-risky → **advisory**, never a gate) | §7 | now (archetype) / next (domains) |
| Guardrails / Agent CI (P2–5) | — the whole tool is deterministic+local; nothing routes to cloud on determinism grounds | — | n/a |

## 9. Artifact

**Compound:** (a) **PR** — the archetype-classifier spike (§7), borrowing the method; (b) **memory** — the convergence (this Geist Stack = [[supermodel]]/Popham; TrailTracker is his private deterministic rewrite; this investigation = the re-anchor thread); (c) **parked** — the tool itself (private, can't depend on it).

## Notes

- **Marketing-vs-reality:** "58 languages" — only 6 benchmark-validated (C#/TS/Python/Go/Java/Rust), and the *site itself* discloses this. "Any repository" is hyperbolic. "data model"/"workflows" outputs are marketing-only (absent from the verified wire format). "macro-F1 1.000" is n=2. To the site's credit, its `benchmark.html` states most of these limits itself — rare honesty for a vendor page.
- **The determinism nuance that matters:** per our own [[supermodel]] teardown, Supermodel's domain *clustering* is already deterministic — only the domain *label/name* is a cosmetic LLM call (with a `DOMAIN_RELATES` fallback). So TrailTracker's "zero LLM" is **less novel than it markets**: it drops one cosmetic naming call and the cloud upload. Its real differentiator is *packaging* — one airgapped binary — which directly answers Supermodel's biggest trust liability (Supermodel uploads your code to Azure despite "we don't store your code"). That packaging is the whole pitch to defense/healthcare/regulated buyers.
- **Weaker evidence:** the CAESAR, core-transformation, and LLM-unreliability findings were 2-1 split votes leaning on single/N=1 sources. The "deterministic discipline exists" result proves a model *isn't required* — it does **not** prove TrailTracker is deterministic.
- **Availability:** PRIVATE PREVIEW, not among Popham's 55 public repos, `trailtracker export ontoloom` = 0 GitHub hits (no public caller), no price/waitlist/contact. `trailtrackerdemo.netlify.app` is a hiking-app name collision — ignore.
- **Category context (2026):** code-graph-for-agents is crowded — [[supermodel]], Trail of Bits' *Trailmark*, AWS's DDD-MCP posts. TrailTracker is one entrant; our structure graph + grep-accelerator are our own answer.
- Related: [[supermodel]], [[ontoloom]], memories `reference_supermodel_company_gtm.md`, `project_supermodel_deprecation_graph_oracle_reanchor.md`.
