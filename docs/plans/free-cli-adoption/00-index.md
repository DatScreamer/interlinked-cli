# Free CLI Adoption Plan — Index

**Status:** Proposed.
**Scope:** All Free-CLI-bucket items from the 22-repo Dicklesworthstone synthesis at `reference-repos/_analysis/SYNTHESIS.md` and the three-product bucketing at `reference-repos/_analysis/BUCKETING.md`.
**Audience:** Engineers implementing the next 1–3 phases of harness work; reviewers approving scope.

## What this folder is

A planning artifact, not a binding spec. Each numbered file inside this folder is one self-contained chunk of work. They are ordered roughly by phase; nothing here is mutually exclusive, and nothing requires the cloud (`Guardrails` / `Agent CI`) to ship.

The Free-CLI bucket is the funnel and the local correctness layer of the three-product architecture. Everything in this folder runs locally, deterministically, with no network on the hot path. Latency budgets per tool class — Read 300 ms p99, Modify 800 ms p99, Side-effect 2000 ms p99 — are the binding constraints.

## File map

| File | Topic | Phase | Source repos | Touches |
|---|---|---|---|---|
| `01-evaluator-architectural-upgrades.md` | DCG architectural patterns: keyword quick-reject, span classification, wrapper normalization, dual-engine regex, allowlist expiry | 1 | DCG | `src/harness/evaluator/rule-matching.ts`, `rules-loader.ts`, `types.ts` |
| `02-destructive-command-rules.md` | 8 missing destructive command rules (kubectl × 3, docker × 2, git × 2, terraform × 2, helm × 1) | 1 | DCG | `src/harness/rules-loader.ts`, inline fallback in `evaluator/pre-tool.ts` |
| `03-resource-bomb-rules.md` | 10 SRPS resource-bomb patterns (fork bomb, dd, seq, xargs, ulimit, etc.) | 1 | system_resource_protection_script | Same as 02 |
| `04-ubs-quality-checks.md` | Top 30 UBS quality checks: NaN comparison, loose equality, mutex unwrap, shell=True, etc. | 1–2 | ultimate_bug_scanner | `src/harness/generic-checks.ts`, `language-profiles.ts`, registry quad |
| `05-trajectory-state-machine.md` | Tool-call state machine: tool-loop, destructive-sequence, unbackedoff-retry, silent-stall | 2 | frankenterm | new `src/harness/trajectory.ts`, `session-state.ts`, `pattern-detector.ts` |
| `06-pagerank-file-impact.md` | PageRank over file-import DAG; ranks findings by file centrality | 2 | beads_viewer | `src/harness/impact-analysis.ts`, `project-graph.ts`, `suggestion-scorer.ts` |
| `07-tarjan-scc-cycles.md` | Tarjan SCC for cyclic-import detection; replaces naive walk | 2 | beads_viewer | `src/harness/project-graph.ts`, `pattern-detector.ts` |
| `08-agent-detection-signatures.md` | 7 new client detections (Cursor, Copilot CLI, Cline, Aider, Amp, Goose, Factory) + env-var probes | 1 | franken_agent_detection, CASS | `src/lib/settings.ts`, `hook-installers.ts` |
| `09-precompact-reminder.md` | PreCompact hook emits AGENTS.md + harness-rules reminder to stdout | 1 | post_compact_reminder | `src/lib/hooks.ts` (generator), `hook-installers.ts` already lists event |
| `10-exit-code-envelope.md` | Exit-code stratification (0–5) + universal `_meta` JSON envelope | 1 | repo_updater, beads_viewer | `src/commands/verify.ts`, `sync.ts`, `status.ts`, `clean.ts` |
| `11-latency-budget-validation.md` | How to measure & enforce per-tool-class budgets in CI | cross-cut | — | `bench/`, `vitest.config.ts`, hook-path instrumentation |
| `12-testing-strategy.md` | Test plan covering all of 01–10: unit, golden, parity, regression | cross-cut | — | `__tests__/` across modules |
| `13-rollout-and-acceptance.md` | Phased rollout, feature flags, telemetry KPIs, acceptance gates | cross-cut | — | `feature-flags.ts`, `telemetry.ts`, release notes |
| `14-credential-and-quota-visibility.md` | Env-var probes for credential paths, JWT expiry parsing, quota snapshot in activity log | 2 | coding_agent_account_manager, coding_agent_usage_tracker | `src/lib/settings.ts`, `auth.ts`, `hooks.ts` |
| `15-disk-pressure-and-safe-clean.md` | Periodic disk-pressure check + `interlinked clean --safe` + 6-category error taxonomy | 2 | storage_ballast_helper, automated_flywheel_setup_checker | new `src/harness/disk-pressure.ts` + `safe-cleanup.ts`, `src/commands/clean.ts` |
| `16-backup-restore-commands.md` | `interlinked backup` / `interlinked restore` for AI agent config dirs (git-versioned, atomic) | 2 | agent_settings_backup_script | new `src/commands/backup.ts`, `restore.ts`, `src/lib/backup-store.ts` |
| `17-replay-testing-and-decision-receipts.md` | HMAC-keyed decision receipts + deterministic replay testing harness + CI corpus | 3 | asupersync, franken_engine, franken_node | new `src/harness/replay.ts`, `decision-receipt.ts`, `src/commands/replay.ts` |
| `18-session-state-signals.md` | Per-session signal snapshot, ring-buffer log access, 4-level health severity, `interlinked tail` | 2 | vibe_cockpit, flywheel_gateway | `src/harness/session-state.ts`, new `ring-buffer.ts`, `health-score.ts`, `src/commands/tail.ts` |
| `19-ascii-diagrams-and-bundle-mode.md` | `verify --check-ascii-diagrams [--fix]` + `verify --bundle [--token-budget N]` | 3 | aadc, source_to_prompt_tui, prepareprojectforllmprompt | new `src/harness/ascii-diagram-check.ts`, `bundle-builder.ts`, `src/commands/verify.ts` |
| `20-negative-evidence-ledger.md` | Per-rule outcome ledger, evidence valence, absence-as-evidence signals, `/enforce outcomes` / `auto-demote` / `auto-invert` | 3 | franken_engine, process_triage, eidetic_engine_cli, CASS | new `src/harness/rule-outcomes.ts`, Cedar context builder, `/enforce` skill, `distilled-rules.overrides.json` |

## Phase summary (cross-cuts BUCKETING.md §10)

### Phase 1 — Free CLI immediate wins (~10 working days)

`01` (architectural upgrades), `02` (destructive rules), `03` (resource-bomb), `08` (agent detection), `09` (PreCompact), `10` (exit codes), top-10 of `04`. Zero new modules; mostly additive to existing files. Net additions: ~30 rules, ~10 generic checks, 1 hook event branch, 1 ranking field.

### Phase 2 — Free CLI quality & coordination (~25 working days)

`04` patterns 11–30, `05` (trajectory), `06` (PageRank), `07` (Tarjan SCC), `14` (credential + quota visibility), `15` (disk pressure + safe clean), `16` (backup / restore), `18` (session-state signals). Five new modules (`trajectory.ts`, `disk-pressure.ts`, `safe-cleanup.ts`, `ring-buffer.ts`, `backup-store.ts`); two new commands (`tail`, `backup`/`restore`); deeper test coverage; new caching layer for graph artifacts.

### Phase 3+ — Free CLI polish (cross-cut work)

`17` (replay testing + decision receipts), `19` (ASCII diagrams + bundle mode), `20` (negative-evidence ledger), confidence scoring on findings, SARIF output mode, cross-language resource-lifecycle counters, full per-section status in JSON envelope. Mostly extensions of work shipped in Phases 1–2.

## Cross-cutting principles

These bind every plan in this folder. If a plan violates one, flag in its Risks section.

1. **Determinism only.** No LLM inference in any check. Any check that "needs context the agent can provide" lives in Guardrails or Agent CI, not here.
2. **Latency budgets are per-tool-class, not blanket.** Read 300 ms / Modify 800 ms / Side-effect 2000 ms p99. PostToolUse runs after the budget but its findings surface in the *next* PreToolUse warnings — so total stack-up matters.
3. **Existing-pattern-first.** New checks follow the 4-touch update pattern from `CLAUDE.md`: detector + canonical registry entry + metadata + legacy mirror, landed atomically.
4. **Inline fallback parity.** Every rule with daemon-routed enforcement also gets an inline fallback in `evaluator/pre-tool.ts` for the daemon-down case. `command-guard-parity.test.ts` enforces.
5. **Severity tiers are deterministic.** No probabilistic auto-allow. Critical = always block. Warning = surfaces in next PreToolUse. Advisory = `verify --all-checks` only, demotion logged in `DEFAULT_ADVISORY_SKIPS`.
6. **Fail-open on safety.** Per project memory: no circuit breakers on the safety layer. If the daemon is down, evaluator falls back to inline patterns; if those fail, the call is allowed with a stderr warning.
7. **Atomic writes for any stateful artifact.** Cache files (PageRank, SCC partition, error history) write through temp + rename.
8. **Pre-build hooks; never tsx-at-runtime.** Per memory `project_harness_performance.md`. The generated `.mjs` ships with zero CLI imports.
9. **Two-tier verify.** `interlinked verify` = high-signal gate (must run clean). `interlinked verify --all-checks` = heuristic deep audit. Pinned by `DEFAULT_ADVISORY_SKIPS` regression test.
10. **Provenance fields on every event.** Every new activity event added by these plans carries `{session_id, agent_source, hook_event, project, ts}` minimum.
11. **No silent adaptive mutation.** Evidence ledgers may propose demotion or PITFALL-style inversion, but rule lifecycle changes require an explicit user command with provenance.

## Composition flow (a typical PreToolUse hot path after all of Phase 1 lands)

```
Bash hook fires
  → daemon socket connect (~0.5 ms)
  → wrapper-normalize (sub-ms; plan 01)
  → span-classify (sub-ms; plan 01)
  → keyword quick-reject (sub-ms; plan 01)
  → rule-loop (sub-5 ms; plans 01 + 02 + 03)
  → trajectory check (sub-ms; plan 05 in P2)
  → return decision
total: <10 ms warm; well inside Read-class 300 ms p99
```

PostToolUse (Edit src/foo.ts) after Phase 2:
```
edit lands on disk
  → tsc/biome/oxlint (existing, ~50–200 ms)
  → all 30 generic UBS checks (~5–15 ms; plan 04)
  → trajectory state check (sub-ms; plan 05)
  → cached PageRank lookup + Tarjan SCC delta (sub-ms warm; plans 06 + 07)
  → emit findings to stderr; ranked via suggestion-scorer with PageRank boost
total: ~60–250 ms; surfaces in next PreToolUse warnings
```

## Out of scope (deferred to Guardrails or Agent CI)

Per `BUCKETING.md`:
- Multi-agent peer-approval workflow with cryptographic signatures (slb v2 → Guardrails)
- Cross-customer learning of finding fix-rates (meta_skill bandit → Guardrails)
- Cross-repo PageRank / impact analysis (multi-Artifact-fork → Agent CI)
- Full LLM coordinator + specialists review (→ Agent CI)
- Mutation testing in Sandbox (→ Agent CI)
- Authoritative signature DB updates (→ Guardrails Vectorize)
- Compact-time `profile.ingest(messages)` Memory write (→ Guardrails)
- Logpush of every tool-call decision to customer SIEM (→ Guardrails Enterprise)
- Cross-tenant rule outcome aggregation and community-tuned rule packs (plan `20` writes only the local substrate)

These are referenced where the corresponding Free-CLI primitive enables them, but no implementation work in this folder.

## Acceptance for Phase 1 as a whole

Independent of any single plan doc, Phase 1 is "done" when:

- `interlinked verify` runs clean on this repo with all new rules + checks active.
- p99 PreToolUse latency on a warm daemon stays under the per-tool-class budgets in a CI bench job (plan `11`).
- No flake or FP regression in `command-guard-parity.test.ts`, `evaluator.test.ts`, `cli-bugs.test.ts`.
- Hook installer correctly detects all 7 new clients without breaking on a system that has none of them (plan `08`).
- The PreCompact reminder fires correctly on Claude Code session compaction in a manual verification (plan `09`).
- Exit-code regression test passes for all 6 codes (plan `10`).
- `npm run docs` regenerates without diff (validates check-metadata stayed in sync; plan `04`).

Per-plan acceptance criteria are stated in each file's `## Acceptance` section.
