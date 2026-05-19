# LSP-Backed Symbol Resolution for the Harness

**Status:** Draft RFC (2026-05-18). Not approved, not built. Originates from the `docs/external-pulse/claude-code-large-codebases.md` intake.

**Audience:** Future-you (or the agent acting on your behalf) building LSP into the harness. This memo states every design decision and lists open questions explicitly.

**Companion docs:**
- `docs/external-pulse/claude-code-large-codebases.md` — the intake that triggered this RFC; §6–9 are the lane / dependency / phase analysis.
- `docs/external-pulse/serena.md` — LSP-as-an-agent-facing-MCP-tool. This RFC deliberately takes the opposite framing: LSP as the harness's *internal* backend, never exposed to the agent.
- `docs/external-pulse/narsil-mcp.md` — the tree-sitter alternative; §3 explains why this RFC picks LSP instead.
- `docs/design/three-product-architecture.md` §8 — the phase model and per-edit compute budget.
- Memory: `feedback_harness_deterministic_only.md`, `feedback_safety_continuity.md`, `feedback_hook_latency_budget.md`.

---

## 1. Problem statement

The harness resolves symbols, imports, exports, and cross-file references with **regex**. `project-graph.ts` says so in its own header — "Regex-based parsing (no AST library dependency, sub-10ms per file)" — and `project-graph/parser-imports.ts` / `parser-exports.ts` are regex parsers.

Regex cannot *prove* symbol identity. It cannot follow a re-export (`export { x } from "./y"`), cannot distinguish an `import type` from a value import, cannot resolve an overload set, and mishandles declaration merging and namespace aliasing. So the structural and impact checks that depend on symbol resolution — `import_resolution`, `export_surface`, `import_cycles` (`structural-checks.ts`), and `interface_change_impact` (`impact-analysis.ts`) — are **heuristic by construction**. `classifyDeterminism` (`quality-checks.ts:1082-1088`) gives them no `[proven]` tag; `server.ts:2134` defaults their persisted determinism to `"heuristic"`. The agent sees a `[heuristic]` finding it is free to discount.

The harness already buys *proven* structural truth for a couple of checks by shelling out to `tsc` — `export_ripple` and `missing_return_types` are in `PROVEN_TOOL_CHECKS` (`quality-checks/instructions.ts:28-48`). But `tsc` is a one-shot, whole-project compile: far too heavy to run per-symbol on every edit. There is a gap — **no cheap, incremental, *proven* symbol resolution**. A language server fills exactly that gap: it is the language's own type-checker, kept warm, answering `references` / `definition` queries in milliseconds.

This RFC originates from the `claude-code-large-codebases.md` external-pulse intake, which found LSP to be a three-source-corroborated finding (`serena.md`, `narsil-mcp.md`, and Anthropic's large-codebase article, which ranks LSP "one of the highest-value investments" for a codebase).

## 2. Goals and non-goals

**Goals**
- Give `import_resolution` / `export_surface` / `import_cycles` / `interface_change_impact` a **proven** backend — symbol facts from the language's own toolchain, not regex.
- Stay inside the harness's deterministic mandate (`feedback_harness_deterministic_only.md`): a language server is fully deterministic, no model in the loop.
- Add **zero npm runtime dependency** — hand-rolled LSP client, LSP server invoked as a subprocess (§5).
- **Fail open** to the existing regex path whenever LSP is unavailable, cold, slow, or crashed (`feedback_safety_continuity.md`; the `grep-accelerator.ts` precedent).
- Stay within the PostToolUse compute budget when the server is warm (§10).

**Non-goals**
- Not removing the regex parsers — they remain the permanent fallback.
- Not multi-language in v1 — TypeScript/JavaScript only (`typescript-language-server`). Other languages are Phase C (§13).
- Not an agent-facing tool — `serena.md` evaluated *exposing* LSP to the agent over MCP; this RFC keeps LSP entirely internal to the harness.
- Not whole-repo scans — heavy/async, routes to Agent CI (§13 Phase C).
- Not a PreToolUse blocking-gate concern — symbol facts feed PostToolUse warnings and impact, never the sub-second block.

## 3. Decision — LSP, not tree-sitter

The intake left LSP-vs-tree-sitter as the open question. This RFC resolves it: **LSP**.

The decisive argument is the *goal*. We do not want a better parse tree — we want **proven answers** to "what references this symbol" and "what does this import resolve to." tree-sitter gives a syntax tree; *the resolution logic on top of it is still our code* — still heuristic, just less wrong. LSP delegates resolution to the language's own type-checker (`typescript-language-server` drives `tsserver`, which *is* the TypeScript compiler), so the answer is `[proven]` in the strongest available sense.

`narsil-mcp.md` chose tree-sitter because narsil builds its *own* call-graph / CFG / DFG and needs raw syntax as material. interlinked wants the *resolved answer*, already computed by the toolchain. Different goal → different tool.

| | LSP (`typescript-language-server`) | tree-sitter |
|---|---|---|
| What it returns | Resolved answer (`references`, `definition`) | Syntax tree; resolution is still your code |
| Determinism of result | `[proven]` — the compiler resolved it | "more accurate heuristic" — your resolver |
| npm runtime deps | **0** — subprocess (binary) | Several — `tree-sitter` + per-language grammars |
| Dependency-filter verdict | Clears (invoke-as-subprocess) | Starts behind the single-dependency principle (`narsil-mcp.md` §"Phase 1") |
| Multi-language path | One client, N servers — uniform protocol | One grammar + hand-rolled resolver per language |

LSP wins on every axis that matters for this purpose.

## 4. Position in the architecture

The harness daemon (`server.ts`) gains an **`LspPool`** — a manager of long-lived LSP child processes, one per `(language, project root)`. During PostToolUse, after `fileGraph.updateFile()`, the structural checks query the pool; on any miss they fall back to the regex `ProjectGraph`.

```
┌────────────────────────────────────────────────────────────────────┐
│  Agent runner — PostToolUse hook                                     │
└────────────────────────────────┬─────────────────────────────────────┘
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  Harness daemon (src/harness/server.ts) — always-on, ~30 MB          │
│                                                                      │
│  PostToolUse: fileGraph.updateFile(edited)                           │
│         │                                                            │
│         ▼   runStructuralChecks / runImpactAnalysis (server.ts:2094) │
│         │                                                            │
│         ├── LspPool.references(symbol, root) ──── warm ──→ proven    │
│         │        │                                  determinism =    │
│         │        │  timeout / no binary / crash       "proven"       │
│         │        ▼                                                   │
│         └── fallback: ProjectGraph regex resolver ──→ determinism =   │
│                                                          "heuristic" │
│                                                                      │
│  LspPool — lazy spawn · keep-warm · didChange sync · idle-shutdown    │
│            · crash-recovery · keyed per (language, project root)     │
└────────────────────────────────┬─────────────────────────────────────┘
                                 ▼
              typescript-language-server --stdio  (long-lived child)
              JSON-RPC over stdio · hand-rolled client (§5)
```

The pool is an *optional second resolver* handed to the structural checks alongside `fileGraph`. It changes the *fidelity* of an answer, never whether an answer is produced.

## 5. The LSP client — hand-rolled, zero-dependency

The LSP base protocol is `Content-Length`-framed JSON-RPC 2.0 over the child process's stdio. Hand-roll it — on the order of a few hundred lines — as an `LspClient` class. Do **not** import `vscode-languageserver-protocol` / `vscode-jsonrpc`; that violates the single-runtime-dependency principle, and the surface we need is small. This matches the project's hand-rolled formatter/output stance.

`LspClient` wraps one `child_process.spawn`'d server and implements:
- **Message framing** — write/read `Content-Length: N\r\n\r\n<json>`; buffer partial reads.
- **Request/response correlation** — monotonic `id`, a pending-promise map, per-request timeout.
- **The methods we need** — `initialize`, `initialized`, `textDocument/didOpen`, `textDocument/didChange`, `textDocument/references`, `textDocument/definition`, `textDocument/documentSymbol`, `shutdown`, `exit`.

> **New machinery flag.** This is the **first long-lived child process** in the harness. Every existing subprocess — `quality-checks.ts`, `grep-accelerator.ts` (`spawnSync` ripgrep) — is one-shot. Process lifecycle (§6) is therefore genuinely new code, and the largest engineering risk in this RFC.

## 6. Lifecycle — the `LspPool` (mirrors the trigram index)

The trigram index is the lifecycle template: load at startup (`server.ts:446-470`), incremental refresh on SessionStart (`server.ts:695-728`), in-memory dirty layer at PostToolUse. The `LspPool` follows the same shape, with one difference — a child process, not an in-memory structure.

- **Lazy spawn.** Do *not* spawn at daemon startup. A cold `tsserver` indexing the repo costs seconds and hundreds of MB; sessions that never trigger a structural check should pay nothing. Spawn the child on the **first structural check** for a given `(language, root)`. A `structural.lsp.eager_warmup` config flag (§11) opts into SessionStart warm-up.
- **Keep warm.** Once spawned, the child lives for the daemon's lifetime (the daemon is always-on, idle-timeout 0 — `server.ts:306-315`).
- **`didChange` sync.** On every PostToolUse edit, send `textDocument/didChange` for the edited file — the same edit signal the trigram dirty layer consumes. `tsserver` re-analyses incrementally; the server stays consistent with the working tree.
- **Per-child idle-shutdown.** The daemon has an idle timer for *itself*; the pool needs one *per child*. If no query has hit a given LSP server for `idle_shutdown_ms`, `shutdown`+`exit` it to reclaim memory. Re-spawns lazily on the next query.
- **Crash recovery.** If a child exits unexpectedly (crash, OOM), mark it dead, fail the in-flight query over to regex, re-spawn on the next check. Never retry in a loop; never block.
- **Daemon shutdown.** The early SIGTERM/SIGINT handler (`server.ts:263-288`) must also `exit` every LSP child, or they orphan — the failure mode `doctor-system.ts countOrphanHarnesses()` already exists to detect for daemons.

## 7. Integration with the structural checks

The integration point is the `runStructuralChecks` / `runImpactAnalysis` block at `server.ts:2094-2199`. The pool is passed alongside `fileGraph`. Two integration styles, chosen per check:

- **Replace** — `import_resolution`: "does this import resolve to a real exported symbol?" LSP `definition` answers exactly. When the pool is warm, its answer replaces the regex resolver's.
- **Confirm / upgrade** — `interface_change_impact`, `export_surface`, `import_cycles`: the regex graph runs first (fast, always available) and proposes a reference/dependent set; if the pool is warm, `references` replaces that set with the proven one, and the result is re-tagged (§8). `runImpactAnalysis` already escalates `severity: "critical"` to `postDecision.decision = "block"` — a *proven* critical impact is a stronger basis for that block than a heuristic one (but see §14.7 on calibration).

Regex always runs. LSP, when available, overwrites the answer with a proven one. A check never has *no* answer because LSP was down.

## 8. Determinism tagging — a per-result field

Determinism is **static** today: `classifyDeterminism` (`quality-checks.ts:1082-1088`) is a pure check-id lookup (`REGISTRY_DETERMINISM` → `PROVEN_TOOL_CHECKS` → `TOOL_CHECK_INSTRUCTIONS` → `null`), and `server.ts:2134` injects `determinism: STRUCTURAL_CHECK_META[r.check]?.determinism ?? "heuristic"` from static metadata.

That assumption breaks here. An LSP-backed check is `[proven]` **when LSP ran** and `[heuristic]` **when it fell back to regex** — same check id, determinism varying per run. Tagging it statically would mislabel a regex-fallback result as `[proven]`, which is worse than no tag.

**Required change:** add an optional per-result determinism field.
- Add `determinism?: "proven" | "heuristic"` to `StructuralCheckResult` (`types.ts:1111-1124` — no such field today).
- The LSP-backed check sets it at evaluation time: `"proven"` if the pool answered, `"heuristic"` if it fell back.
- `server.ts:2134` reads `r.determinism ?? STRUCTURAL_CHECK_META[r.check]?.determinism ?? "heuristic"`.

This is small and contained, and can land independently of the LSP code. Note: CLAUDE.md's rule "add the id to `PROVEN_TOOL_CHECKS`" does **not** apply here — that set is for *unconditionally* tool-backed checks. LSP-backed checks are *conditionally* proven; the per-result field is the mechanism, not the static set.

## 9. Fail modes — fail-open everywhere

Per `feedback_safety_continuity.md`: no circuit breakers on a safety-adjacent layer; degrade, never die.

| Failure | Detection | Handler |
|---|---|---|
| No LSP binary on PATH | spawn ENOENT / `doctor` check | Regex fallback for all structural checks. One-time SessionStart log (mirrors the ripgrep note at `server.ts:723`). |
| Child cold / mid-reindex | query exceeds `query_timeout_ms` | Regex fallback for that check; child keeps warming for next time. |
| Child crash / OOM | child `exit` event | Pool marks dead → regex fallback → re-spawn on next check. |
| Malformed LSP response | JSON parse / schema error | Regex fallback; log raw response. |
| Query slower than the PostToolUse budget | hard timeout below the budget | Regex fallback. Never block the budget on LSP. |

The structural checks **never hard-depend on LSP**. LSP is a precision upgrade; its absence lowers a finding's determinism tag from `[proven]` to `[heuristic]` — it never removes a finding or weakens a block.

## 10. Compute budget

Per `three-product-architecture.md` §8, PostToolUse is the modify-class budget (~800 ms). A **warm** `references` query is low-ms — comfortably inside it. A **cold** start is seconds — which is the whole reason for lazy-spawn + keep-warm + never-block-on-cold. Every query carries a hard `query_timeout_ms` well under the budget; exceeding it → regex fallback (§9).

`feedback_hook_latency_budget.md`: the LSP query lives on the PostToolUse path, **not** the sub-10ms PreToolUse path — so it has room — but the timeout-and-fallback discipline is still mandatory.

**Memory** is the real cost. The daemon is ~30 MB today; a warm `tsserver` can be hundreds of MB. Mitigations: lazy spawn, per-child idle-shutdown (§6), a configurable per-child memory ceiling (§14.3), and v1 default-off (§11) so the cost is opt-in until calibrated.

## 11. Configuration

A `lsp` block inside the existing structural config object (the one already carrying `impact_analysis` / `impact_high_threshold`, read at `server.ts:2104`):

```jsonc
"structural": {
  "lsp": {
    "enabled": false,            // v1 default off; flip on after calibration (§13)
    "languages": ["typescript"], // v1: TS/JS only
    "server_cmd": "typescript-language-server --stdio", // overridable
    "query_timeout_ms": 250,
    "idle_shutdown_ms": 600000,  // kill an unused child after 10 min
    "eager_warmup": false        // spawn on SessionStart instead of first check
  }
}
```

Default-off in v1 mirrors the advisory-check rollout pattern and the Tier-2 shadow→enforce cadence (`docs/design/tier-2-llm-policy-gate.md` §12).

## 12. `doctor` integration

`interlinked doctor` checks config, hooks, and system resources but performs **no tool-presence checks today** (`doctor-system.ts:132-169` — `runSystemChecks` covers CPU, memory, orphan daemons). Ripgrep presence is checked only as a SessionStart side effect (`findRipgrep()`, `server.ts:723`).

Add a `checkToolPresence("typescript-language-server")` to `runSystemChecks()` (or a tool-availability section in `doctorCommand`). When `structural.lsp.enabled` is true and the binary is missing, emit a **warn** (not an error — the harness still works via fallback) with install instructions (`npm i -g typescript-language-server`), exactly as the ripgrep warning does.

## 13. Phasing

Maps to the intake's §8 phase table.

- **Phase A — Spike (≤1 day).** The intake §7 probe: from a throwaway script (or a `harness lsp-probe` dev command), spawn `typescript-language-server --stdio`, hand-roll the JSON-RPC framing, `initialize` → `didOpen` one file → one `textDocument/references` for a symbol with a known reference count in *this* repo, and diff against `impact-analysis.ts` / `project-graph.ts`. Record: agreement/disagreement, warm latency, cold-start cost, memory. **Gate:** if LSP disagrees with regex in ways that matter (re-exports, type-only imports, overloads), proceed to B.
- **Phase B — Free CLI (the body of this RFC).** `LspClient` + `LspPool`, TypeScript/JavaScript only; lazy-spawn, daemon-hosted, `didChange` sync; the per-result `determinism` field (§8); the four checks LSP-backed with regex fallback; `doctor` check; config default-off → calibrate on real sessions → default-on.
- **Phase C — Agent CI (parked, separate RFC).** Additional languages (`rust-analyzer`, `clangd`, `gopls` — the same `LspClient`, the protocol is uniform). Whole-repo LSP-backed breaking-change scans for pre-push / PR review: heavy, async, fan-out over a warm server pool — the `narsil-mcp.md` §9 "heavy deterministic → cloud" case. Lands in Agent CI, not the CLI.

Unlike Tier 2, there are **no external prerequisites** — this is entirely CLI-local. The only gate is the Phase-A spike result.

## 14. Open decisions

1. **`typescript-language-server` vs talking to `tsserver` directly.** tsserver speaks Microsoft's older non-LSP protocol. **Leaning:** `typescript-language-server` — uniform LSP means `rust-analyzer` / `clangd` / `gopls` reuse the exact `LspClient` in Phase C; tsserver-direct would be a TS-only one-off.
2. **Lazy-spawn vs eager warm-up.** **Leaning:** lazy in v1 (don't pay cold-start for sessions with no structural edits); `eager_warmup` is the opt-in config flag.
3. **Per-child memory ceiling.** Kill + fall back to regex if a `tsserver` child exceeds a ceiling? **Leaning:** yes, configurable, monitored the way `countOrphanHarnesses()` monitors stray daemons. Open: the exact ceiling (start ~500 MB, tune).
4. **v1 default state — off or on.** **Leaning:** off. Calibrate agreement-vs-regex and FP rate first (shadow-style, like Tier-2 and the advisory-check rollout), flip on per-check once Phase-A/B data is in.
5. **Multi-root monorepos.** One LSP child per project root, or one server with `workspaceFolders`. **Leaning:** per-root child, keyed exactly like `_graphCache` (`server.ts:412-444`) — simpler isolation, and it matches the existing graph-cache shape.
6. **Feed LSP reference data to `recordImpactFollowUps` / the recurrence log?** **Leaning:** yes — a proven impact set is strictly better input; no format change needed.
7. **Does a proven `interface_change_impact` still escalate to `block`?** A proven critical impact is a *more* defensible block than today's heuristic-critical block. **Leaning:** keep it warn-only through Phase-B calibration before letting LSP drive a hard block — per `feedback_safety_continuity.md` and the no-aggressive-ratchet caution recorded in `cursor-harness.md`.

## 15. Implementation order

1. **Phase-A spike** — the probe (§13 A). Gate the rest on its result.
2. **`LspClient`** — hand-rolled `Content-Length` JSON-RPC framing + the ~9 methods. Unit-test against a real `typescript-language-server`, and against a fake in-process server for deterministic CI.
3. **`LspPool`** — spawn / keep-warm / idle-shutdown / crash-recovery / per-root keying. Wire `exit` into the `server.ts:263-288` SIGTERM path so children can't orphan.
4. **Per-result `determinism` field** — add to `StructuralCheckResult`, change the `server.ts:2134` read. Contained; can land independently and first.
5. **Wire one check** — `import_resolution` (the cleanest "replace" case), behind the default-off config flag. Calibrate agreement vs regex on this repo (dogfood — `feedback_dogfood_harness_from_errors.md`).
6. **Extend** to `export_surface`, `import_cycles`, `interface_change_impact`.
7. **`doctor`** tool-presence check.
8. **Calibrate** → flip `structural.lsp.enabled` default to on.
9. **Phase C** — separate RFC: more languages; whole-repo scans → Agent CI.
