# QMD — Query Markup Documents

- **Source:** https://github.com/tobi/qmd • https://github.com/tobi/qmd/releases (v2.5.1 shipped 2026-05-20, the day of this intake)
- **Encountered:** 2026-05-20, releases page pasted by user; cloned to `reference-repos/qmd`
- **Verdict:** memory note + cross-link — lane 6 for the product, lane 3 (latent) for the chunker substrate

## 1. Core idea (one sentence, your words)

An on-device hybrid search engine for markdown notes/wikis/transcripts: BM25 (SQLite FTS5) + vector similarity (sqlite-vec) + LLM reranking (Qwen3-Reranker via node-llama-cpp), fused with Reciprocal Rank Fusion and a position-aware retrieval/reranker blend, fronted by a CLI and an MCP server.

## 2. Anatomy (concrete walkthrough)

17 TS files, ~15.5K LoC, MIT, 12 runtime deps, Node 22+ / Bun. Three GGUF models auto-downloaded on first use (~2 GB: embeddinggemma-300M-Q8 ≈ 300 MB, Qwen3-Reranker-0.6B-Q8 ≈ 640 MB, qmd-query-expansion-1.7B-q4 ≈ 1.1 GB — the last is Tobi's own fine-tune at `tobil/qmd-query-expansion-1.7B-gguf`).

Load-bearing files:
- `src/store.ts` (5170 LoC) — store API, indexing, RRF fusion at `reciprocalRankFusion()` line 3807 (k=60, original-query ×2 weight, top-rank bonus +0.05 / +0.02). The cleanest piece is ~180 LoC of pure chunking primitives at lines 90–325: `BreakPoint = {pos, score, type}`, `scanBreakPoints` (regex pass keeping the highest-scoring match per byte position), `findBestCutoff` (squared-distance decay over a 200-token window before the target), `mergeBreakPoints` (composes any two break-point streams), `chunkDocumentWithBreakPoints` (sliding window with overlap).
- `src/ast.ts` (403 LoC) — tree-sitter WASM, S-expression queries per language for TS/TSX/JS/Python/Go/Rust. Emits `BreakPoint[]` with the *same* score scale as markdown headings (class/struct/trait/impl = 100, func/method/export = 90, type/enum = 80, import = 60) so `mergeBreakPoints` glues regex + AST signals into one stream and `findBestCutoff` works unchanged. Every failure path returns `[]` and falls back to regex-only chunking (parse fail, grammar load fail, unsupported extension). Grammars are `optionalDependencies`.
- `src/llm.ts` (1979 LoC) — node-llama-cpp wrapping for embed/rerank/expand, GGUF magic-byte validation (catches HTML proxy-error pages downloaded over a captive portal), HuggingFace URI resolution, GPU backend detection (`QMD_LLAMA_GPU=metal|vulkan|cuda|false`).
- `src/db.ts` (103 LoC) — cross-runtime SQLite. Bun uses `bun:sqlite` + `Database.setCustomSQLite()` to swap in Homebrew SQLite on macOS (Apple's system SQLite is built with `SQLITE_OMIT_LOAD_EXTENSION`, blocking sqlite-vec). Node uses `better-sqlite3`. Probes at import time whether vec extensions actually load.
- `src/mcp/server.ts` (870 LoC) — MCP stdio + HTTP daemon (default localhost:8181, PID file at `~/.cache/qmd/mcp.pid`); exposes 4 tools (`query` / `get` / `multi_get` / `status`). Per-session map per MCP spec; LLM models stay loaded in VRAM across HTTP requests, embedding/rerank contexts disposed after 5 min idle.
- `src/bench/` (~550 LoC) — fixture-driven precision@k / recall / MRR / F1 across 4 backends (bm25 / vector / hybrid-no-rerank / full).
- `skills/qmd/SKILL.md` (203 LoC) — Claude Code skill shipped *inside* the npm package; `qmd skill install` writes it to `./.agents/skills/qmd` or `~/.agents/skills/qmd`.

What the user invokes: `qmd collection add <dir>`, `qmd embed`, then `qmd search` (BM25), `qmd vsearch` (vector), or `qmd query` (full hybrid). What an agent sees via MCP: structured `query`/`get`/`multi_get` tools returning docid + path + context + snippet + score.

End-to-end query: parse `intent:`/`lex:`/`vec:`/`hyde:` fields → LLM query expansion (skipped if BM25 top result scores ≥0.85 with a ≥0.15 gap to runner-up — `STRONG_SIGNAL_MIN_SCORE`/`MIN_GAP` at store.ts:329) → parallel FTS + vector per sub-query → RRF fuse → top 30 → LLM rerank → position-aware blend (75/60/40 % RRF by final rank band) → return.

## 3. Deterministic or agentic?

**Hybrid.** Deterministic: smart chunking, AST break-point extraction, BM25 (SQLite FTS5), RRF fusion, position-aware blend, FTS↔vector parallelism. Inference-driven: query expansion, reranking, embeddings (a fine-tuned 1.7 B, Qwen3-Reranker 0.6 B, embeddinggemma 300 M). Quality at the top of the result list — which docs make the final cut — is set by the reranker, not the deterministic plumbing. The architecture diagram in the README is honest about this (labels "LLM Re-ranking" and "Query Expansion"), but a skim could miss it.

License: **MIT** — no blocker for code-borrow or paid reuse.

## 4. Substrate vs. surface

- **Surface:** personal-knowledge-base search (CLI + MCP).
- **Substrate:** (a) the unified break-point chunker — one algorithm, regex and AST as interchangeable input streams; (b) the cross-runtime SQLite layer with the Apple-SQLite/Homebrew workaround; (c) RRF with top-rank bonus + position-aware blend; (d) the bench-harness pattern (fixture format + four backends scored on precision@k/MRR/F1); (e) the MCP-daemon-with-warm-model-pool shape.

The chunker (a) is the only piece borrowable as code in isolation (~180 LoC, pure TS, no deps in the regex-only form; +1 dep for AST via `web-tree-sitter` + N grammar packages).

## 5. Lane (1–6)

**Lane 6 (skip) for the product as a whole.** interlinked is not a markdown KB search tool and has no roadmap for one. qmd's CLI/MCP server is a different category from `interlinked` (KB search vs. agent guardrails).

**Lane 3 (substrate, latent) for the chunker.** Only useful home today is prep for the Tier 3 cloud LLM reviewer (`docs/design/tier-3-async-deep-review.md`) — chunking source files before they hit a model context window. Adjacent to what `narsil-mcp.md` already routed to Phase 4.

**Not lane 5.** The LLM-heavy pieces (node-llama-cpp + GGUF) belong to a different product category (BYO-local-LLM) than interlinked's cloud-roadmap surfaces, which consume hosted models.

## 6. Dependency & displacement

- **Deps:** the full stack adds ~6 substantial runtime deps — `node-llama-cpp` (very heavy native, hundreds of MB), `better-sqlite3` (native compile), `sqlite-vec` + platform-specific binaries, `web-tree-sitter` + 4–5 grammar packages, `@modelcontextprotocol/sdk`, `zod`. Cannot be invoked-as-subprocess for partial borrow — node-llama-cpp is an in-process llama.cpp bridge. The regex-only chunker is dep-free (~180 LoC, pure TS); the AST variant adds `web-tree-sitter` (~5 MB WASM at runtime, ~70 MB on disk across grammar packages).
- **Displacement — overlap with existing decisions, no replacement:**
  - **Symbol resolution:** `docs/design/harness-lsp-symbol-resolution.md` (2026-05-18) explicitly chose LSP over tree-sitter for symbol facts — LSP returns proven answers from the language's own type-checker, tree-sitter still requires our resolver code. qmd's tree-sitter use solves a *different* problem (chunking break points, not symbol identity), so it doesn't contradict the LSP decision — but it does mean adding tree-sitter solely for chunking re-opens a dep-cost conversation that RFC closed for resolution.
  - **AST-aware chunking + BM25/hybrid search:** `narsil-mcp.md` already routed both to Phase 4 (Agent CI). qmd is a simpler, smaller, MIT-licensed alternative — narsil bundles 32-language tree-sitter, taint, CFG/DFG, etc.; qmd does chunking + retrieval cleanly and stops. For a Phase 4 LLM-reviewer chunking step, qmd's substrate is the better fit if narsil's other capabilities aren't needed.
  - **Trigram index:** `trigram-index.ts` accelerates substring/regex search (different recall profile and cost from BM25). No displacement.
  - **Skill packaging:** interlinked already ships complete `skills/enforce/` resources and installs them into `.claude/skills/`, `.agents/skills/`, and `.interlinked/skills/`. qmd's "the CLI installs its own skill from the npm package" is the same pattern at a slightly different surface (per-project + `~/.agents/skills/`). Parity, not displacement.

## 7. Smallest spike

≤1 day: borrow the regex-only chunker (`BreakPoint`, `scanBreakPoints`, `findBestCutoff`, `mergeBreakPoints`, `chunkDocumentWithBreakPoints` — ~180 LoC) into `src/harness/chunker.ts` and run it over `src/harness/*.ts` + `docs/design/*.md` to confirm it chunks both prose and code cleanly along blank-line / heading / paragraph boundaries. Land it as an exported primitive only (no harness wiring) — it sits dormant until Tier 3 design names chunking as a consumer. Skip the AST integration; deferred to whenever a real consuming surface lands.

If the spike is skipped: ensure the chunker is named as a candidate primitive in the next pass of `tier-3-async-deep-review.md` so future-you finds it.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | None. LSP RFC owns symbol resolution; trigram-index owns substring search; no KB-search surface. | n/a | parked |
| Guardrails (P2–3) | None — LLM-rerank-shaped work routes away from sub-second blocking. | n/a | parked |
| Agent CI (P4–5) | Chunker substrate as prep for the Tier 3 LLM reviewer (regex variant first, AST on demand). Synergistic with the chunking slot in `narsil-mcp.md`. | §7 (regex chunker only) | next |

Beyond §8: the "CLI installs its own SKILL.md from the npm package" distribution shape, and the MCP-daemon-with-warm-model-pool pattern, are pattern references with no surface row.

## 9. Artifact

**Memory note + cross-link.** *Should add* pointers from `narsil-mcp.md` (qmd as a lighter MIT alternative for the chunking-for-LLM-input slot) and from `harness-lsp-symbol-resolution.md` (qmd's tree-sitter use is chunking, not resolution — does not re-open the LSP decision). These cross-links are not yet in place; the artifact line records the intended pointers, and `rg qmd docs/design docs/external-pulse` will only find this intake page until the pointers land. The §7 chunker-borrow spike is optional; promote it to a PR only when Tier 3 design names chunking as a needed primitive.

## Notes

- Author: Tobi Lütke (Shopify founder). Signals a well-funded personal/Shopify-adjacent project, not VC-backed; active daily commits (v2.5.1 shipped on the day of this intake).
- The `BreakPoint` abstraction is the cleanest piece of design in the repo: one data type, two producer modules (regex + AST), one `mergeBreakPoints` composition, one `findBestCutoff` consumer. Adopting only the regex producer keeps the borrow dep-free; adding the AST producer later doesn't change any consumer code. Two-stage adoption is the same shape we use elsewhere (e.g. structural checks vs. inline checks).
- `src/db.ts` is worth keeping as a reference if interlinked ever explores Bun support for the harness daemon — the Apple-SQLite-omits-extensions workaround via `setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib")` plus the import-time extension probe is the kind of detail you only learn the hard way.
- The bench harness pattern (fixture → run 4 backends → precision@k/MRR/F1) is more interesting as a *discipline* than as code. If interlinked ever ships a retrieval-shaped check (e.g. a "did the agent find the right doc" eval for the Tier 3 prose-policy match), qmd's fixture format is the right reference. interlinked's `recurrence` aggregator + `.interlinked/e2e-protocol-*` probes cover that ground for guard rules but not for retrieval.
- The `STRONG_SIGNAL_MIN_SCORE` / `MIN_GAP` short-circuit (`store.ts:329-330`) — skip the LLM query expansion when BM25 alone is confident enough — is the same shape as our existing "skip the heavy check when a cheaper signal is decisive" pattern. Worth noting as a reference for any future tier-routing logic.

## Methodology notes

The cleanest reading order for this intake was: README → `package.json` (12 deps is a strong upfront signal of "do not just `import`") → `src/ast.ts` (small, gives you the AST story whole) → `src/store.ts:90-325` (the chunker primitives are the most reusable piece, isolate them) → grep `expandQuery`/`rerank` in store.ts to confirm where the LLM stages sit. Reading the README's "deterministic pipeline" claims without the source would have missed the three LLM stages — the marketing-vs-reality discipline (`codewiki.md` precedent) paid off here, though more mildly: qmd is honest in its architecture diagram, just understated in its prose.
