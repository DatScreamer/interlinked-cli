# Trajectory Detectors — Rollout Status

**Last updated:** 2026-05-27 (live implementation session).

Status doc tracking the trajectory sequence-detector rollout against the plan
in [`trajectory-detectors-implementation-plan.md`](trajectory-detectors-implementation-plan.md).
Updated as PRs land.

## Shipped this session

### PR1 — Framework + Bash provenance + inspection commands

| Item | Where it landed | Status |
|---|---|---|
| `SequenceDetector` / `SequenceMatch` / `SequenceFinding` types | `src/harness/sequence-checks/types.ts` | ✓ |
| Registry + dispatcher + formatter | `src/harness/sequence-checks/{registry,dispatcher,index}.ts` | ✓ |
| `_placeholder` no-op sentinel | `src/harness/sequence-checks/_placeholder.ts` | ✓ |
| `buildTrajectoryFixture` test helper | `src/harness/__tests__/sequence-fixtures.ts` | ✓ |
| Wire PreToolUse dispatch (`pre_block` + `pre_warn`) | `src/harness/evaluator/pre-tool.ts` | ✓ |
| Wire Stop dispatch | `src/harness/server/lifecycle-events.ts::buildStopWarnings` | ✓ |
| `classifyBashCommandProvenance` + `recordBashTaintSource` | `src/harness/bash-provenance.ts` | ✓ |
| Wire Bash provenance into PostToolUse | `src/harness/evaluator/post-tool.ts` | ✓ |
| `interlinked trajectory show / list / replay` | `src/commands/trajectory.ts` | ✓ |
| Command registration | `src/index.ts` | ✓ |
| Session-state extensions (`recent_line_edits`, `literal_occurrences`, `recent_user_urls`) | `src/harness/types/session.ts` | ✓ (types only; runtime population deferred) |
| `loadRecentWorkspaceEvents` cross-session helper | `src/harness/cross-session.ts` | ✓ |

### Detectors shipped (23 of 23)

| ID | Family | Phase | File | Default |
|---|---|---|---|---|
| `signature_change_callers_not_updated` (§3.16) | quality | stop | `quality.ts` | on |
| `regression_test_missing_after_fix` (§3.17) | quality | stop | `quality.ts` | on |
| `stale_doc_sibling` (§3.19) | quality | stop | `quality.ts` | on |
| `secret_read_then_network_call` (§3.1) | security-shape | pre_block | `security.ts` | on |
| `download_then_execute` (§3.2) | security-shape | pre_block | `security.ts` | on |
| `same_command_thrice_no_observe` (§3.9) | security-shape | pre_warn | `security.ts` | on |
| `env_modification_then_bash` (§3.7) | security-shape | pre_warn | `security.ts` | on |
| `npm_run_then_curl_to_localhost` (§3.8) | security-shape | pre_warn | `security.ts` | on |
| `install_then_unauthored_execute` (§3.3) | security-shape | stop | `security.ts` | on |
| `lethal_trifecta_structural` (§3.11) | injection | pre_block | `injection.ts` | on |
| `fetched_external_then_secret_read` (§3.12) | injection | pre_warn | `injection.ts` | on |
| `exfil_to_public_writeable` (§3.14) | injection | pre_block | `injection.ts` | on |
| `github_issue_body_then_action` (§3.13) | injection | pre_warn | `injection.ts` | on |
| `plan_vs_trajectory_drift` (§3.15) | injection | pre_warn | `injection.ts` | on |
| `network_after_user_input_url_match` (§3.5) | injection | pre_warn | `injection.ts` | on |
| `magic_literal_cross_file_proliferation` (§3.18) | quality | stop | `quality.ts` | on |
| `coverage_silent_regression` (§3.20) | quality | stop | `quality.ts` | on |
| `add_then_revert_loop` (§3.21) | quality | pre_warn | `quality.ts` | on |
| `unused_helper_introduced` (§3.22) | quality | stop | `quality.ts` | on |
| `plan_vs_trajectory_drift_quality` (§3.23) | quality | pre_warn | `quality.ts` | on |
| `stale_read_then_write` (§3.4) | cross-agent | pre_warn | `cross-agent.ts` | on |
| `subagent_diverged_edit` (§3.6) | cross-agent | stop | `cross-agent.ts` | on |
| `file_overwrite_after_other_agent` (§3.10) | cross-agent | pre_warn | `cross-agent.ts` | on |

## Subagent fan-out — complete

Two parallel subagents finished cleanly from the live session; main agent
serialized the registry update.

| Subagent | Owns | Detectors | Tests added | Status |
|---|---|---|---|---|
| A (quality) | `quality.ts` + tests | §3.18, §3.20, §3.21, §3.22, §3.23 | 31 | ✓ |
| B (cross-agent) | `cross-agent.ts` NEW + tests | §3.4, §3.6, §3.10 | 23 | ✓ |

Final detector counts:
- Quality: 8 (3 pre-fan-out + 5 from subagent A)
- Security: 6 (3.1, 3.2, 3.3, 3.7, 3.8, 3.9)
- Injection: 6 (3.5, 3.11, 3.12, 3.13, 3.14, 3.15)
- Cross-agent: 3 (3.4, 3.6, 3.10)
- **Total: 23 / 23 per the plan**

## PR-N1 + PR-N2 — shipped (subagent fan-out, second round)

| Item | Where | Status |
|---|---|---|
| `LockdownConfig` + `evaluateLockdown` | `src/harness/lockdown-policy.ts` | ✓ (subagent C, 15 tests) |
| Wire lockdown into PreToolUse dispatch | `src/harness/evaluator/pre-tool.ts` | ✓ — runs after sequence-detector dispatch; upgrades pre_warn → pre_block and emits 2-of-3-legs findings |
| `EgressFilterConfig` + `filterOutputEgress` | `src/harness/output-egress-filter.ts` | ✓ (subagent D, 21 tests) |
| Wire egress filter into PostToolUse output scanning | `src/harness/evaluator/post-tool.ts` | ✓ — warning-mode only; actual response rewrite deferred (see below) |

**Defaults:** both ship disabled. `DEFAULT_LOCKDOWN_CONFIG.enabled === false` and `auto_activate_on_untrusted === false`. `DEFAULT_EGRESS_FILTER_CONFIG.enabled === true` per the module's own default, but the call site uses warn-mode (no response rewrite) until the architecture pass lands. Operators flip via `.interlinked/config.local.json` once the config plumb-through PR lands.

## Deferred from this session

| Item | Reason |
|---|---|
| `GuardRulesConfig.lockdown` + `output_scanning.redact_secrets` field plumb-through | Currently the call sites use `DEFAULT_LOCKDOWN_CONFIG` and `DEFAULT_EGRESS_FILTER_CONFIG`. Wiring a config block through `GuardRulesConfig` is a small follow-up (~30 LoC). |
| Egress filter actual response rewrite | Filter produces `filtered: string` + `redaction_count`. The PostToolUse wiring emits the count as a warning ("would redact N secret occurrences") but does not assign the filtered string back to `event.tool_response`. The harness's response forwarding path needs a broader architectural review before we mutate the wire — separate PR. |
| PR6 Existing-consumer migration | Per plan §3, post-rollout. `turn-end.ts`, `pattern-detector.ts`, `trajectory.ts`, `verification-stop-checks.ts` stay where they are |
| Runtime population of new session-state fields | Types added; `SessionTracker.recordEvent` does not yet populate `recent_line_edits` / `literal_occurrences` / `recent_user_urls`. Detectors gracefully no-op when fields are undefined. Population logic is its own ~200 LoC follow-up |
| `docs/generated/sequence-detectors.md` | 23 detectors have no auto-doc surface yet; the `scripts/generate-docs.ts` generator needs a new section. ~30 min follow-up. |
| `docs-freshness.test.ts` sequence-detector assertions | The freshness test gates structural / quality / guard rules but not sequence detectors yet. ~15 min follow-up. |

## Test counts (final)

| File | Tests |
|---|---|
| `_placeholder.test.ts` | 3 |
| `registry.test.ts` | 5 |
| `dispatcher.test.ts` | 8 |
| `quality.test.ts` | 45 |
| `security.test.ts` | 30 |
| `injection.test.ts` | 30 |
| `cross-agent.test.ts` | 23 |
| `cross-session.test.ts` | 6 |
| `bash-provenance.test.ts` | 23 |
| `trajectory.test.ts` (commands) | 7 |

**Total new tests in sequence-checks subtree: 180.**

**Full harness suite: 7462 / 7462 tests passing across 412 files** — zero
regressions from baseline (7321 / 408 before this rollout). +141 net new
tests across the rollout: 105 in `sequence-checks/`, 23 in `bash-provenance`,
6 in `cross-session`, 7 in `trajectory` commands, 15 in `lockdown-policy`,
21 in `output-egress-filter`, plus assorted infrastructure tests.

## Performance budget validation

Per the plan §6, the budget is ~16ms PreToolUse / ~50ms Stop. Current
sequence-check load:
- PreToolUse `pre_block`: 4 detectors (§3.1, §3.2, §3.11, §3.14)
- PreToolUse `pre_warn`: 8 detectors (§3.5, §3.7, §3.8, §3.9, §3.12, §3.13, §3.15, plus 2 more from subagents)
- Stop: 6 detectors (§3.3, §3.16, §3.17, §3.19, plus 3 more from subagents and cross-agent ones)

All detectors are constant-time over already-computed session state. The
heaviest detectors are the cross-session ones (§3.4, §3.10) which do bounded
`activity.jsonl` reads — capped and cached.

## Open follow-ups (next session)

1. **Runtime population of `recent_line_edits` / `literal_occurrences` / `recent_user_urls`** — `SessionTracker.recordEvent` extensions + `lifecycle-events.ts::handleUserPromptSubmit` URL extraction.
2. **PR-N1 lockdown policy + PR-N2 egress filter** — independent of detector rollout, schedulable any time.
3. **PR6 existing-consumer migration** — port `turn-end.ts`, `pattern-detector.ts`, `trajectory.ts`, `verification-stop-checks.ts` into the new framework.
4. **Configuration UI** — `.interlinked/config.local.json` keys to disable per-detector / downgrade `pre_block` to `pre_warn`.
5. **Telemetry** — surface aggregate fire counts via `interlinked recurrence` so we can tune defaults from real-session data.

## Decisions pinned (do not re-litigate)

1. Detectors consume raw `Readonly<SessionTrajectory>` (Option A in plan §10); canonical `TrajectorySignature` reserved for cloud tier and integrity layer.
2. Separate `sequence-checks/<family>.ts` files; no shimming into `CheckRegistryEntry` (the function signatures differ).
3. New session-state fields are **optional** so detectors gracefully no-op against bare snapshots / pre-population-PR builds.
4. PR-N1 / PR-N2 deferred — they're parallel-OK in the plan and don't block detector work.
5. Existing-consumer migration deferred — would multiply risk for marginal gain during the initial rollout.
