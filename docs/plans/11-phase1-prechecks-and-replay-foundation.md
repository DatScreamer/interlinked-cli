# Phase 1: Pre-block check expansion, session anchor, parallel dispatch, FP-rate telemetry

The first slice of the multi-phase agent-observability + quality-rail rollout. Strictly local. No server, DO, or Artifact dependencies. Designed so Phase 2 (FP-rate aggregator DO, recurrence promotion, mutation testing) has data to consume on day one.

This plan is the third pass on the architecture; the prior conversation went through several reframes (latency tiers → context-cost first → ~0-FP-as-routing-key). What landed is in the **Decisions already made** section so future revisions don't relitigate.

## Decisions already made

| Decision | Rationale |
|---|---|
| **~0-FP rate is the gate for `pre_block`, not latency.** | Phase A blocks the agent's edit; an FP wastes a turn or trains the agent to suppress. Conservative gate. |
| **Context-window cost > latency cost.** | The user already cut the stale-read class because advisory text bloated transcripts even though it ran fast. Every new check must produce a one-line, file:line message and **only fire on real defects.** |
| **Local-only is the correct default.** | Anything whose answer depends only on (this file, this codebase commit) stays local. Cross-session/cross-repo aggregation moves to a DO in Phase 2. |
| **Phase routing infrastructure already exists** (`CheckPhase = "pre_block" \| "pre_warn" \| "post"` in `src/harness/check-registry/types.ts:30`). No new abstraction. New checks slot into existing entry tables. |
| **`pre_block` semantics: `decision: "ask"` (user-confirm bypass), not hard reject.** | Documented at `check-registry/types.ts:14-22`. Honors user authority for legit edge cases while still presenting the rule as a hard rail to the agent. |
| **Worker_threads not in scope.** | Most parallelism wins are subprocess-bound (tsc/biome/oxlint), parallelizable via `Promise.all`. CPU-bound AST checks share one parse and don't benefit from worker_threads enough to justify the complexity. |
| **FP-rate emission lands in Phase 1 even though aggregation is Phase 2.** | The aggregator needs historical data on day one; emission is cheap (extend existing recurrence write path). |

## Codebase facts this plan respects

Verified by reading source. Each shaped a design decision below.

| Fact | Source | Plan implication |
|---|---|---|
| `CheckPhase = "pre_block" \| "pre_warn" \| "post"` exists; `pre_block` = `ask` decision, ~0 FP discipline | `src/harness/check-registry/types.ts:13-30` | New checks declare phase; no routing layer to build. |
| 16 `pre_block` error checks already deployed (misused_promises, eval_usage, inner_html, dangerously_set_inner_html, etc.) | `src/harness/check-registry/entries-errors.ts:24-` | Established pattern. New checks copy the entry shape exactly. |
| `pre_block` evaluator already runs against proposed file state (alongside biome/tsc diff-overlay) | comment at `src/harness/evaluator/pre-tool.ts:381` | No proposed-state machinery to build. |
| `tool_response` already captured in PostToolUse activity events (keys include `tool_response`, `tool_response_sha256`, `tool_outcome`) | `.interlinked/activity.jsonl` PostToolUse rows; `src/lib/hook-template-chunks/session-state.ts:91` | **Tool-result capture is done.** Drop it from this plan. |
| `session_start_head` captures HEAD SHA only — no working-tree state, no untracked-file listing | `src/lib/hook-template-chunks/session-state.ts:996,1022` | Session-start anchor is partial. Phase 1 extends it to capture dirty tree via `git stash create`. |
| `assertion_density` behavioral check exists; `expectless_test` is covered as session-delta | `src/harness/behavioral-checks.ts:590` | Drop `expectless_test` from net-new check list — already done. |
| `eval_usage` and `inner_html`/`dangerously_set_inner_html` exist as `pre_block` errors | `src/harness/check-registry/entries-errors.ts:68,82,152` | Drop from net-new list. **Verify their non-literal scope during implementation** — if they fire on `eval("constant string")`, tighten to non-literal-only. Otherwise leave alone. |
| `ubs_subprocess_shell_true` covers Python's `subprocess.run(..., shell=True)` only | `src/harness/check-registry/entries-errors.ts:198` | Node's `child_process.exec(userInput)` is **not** covered. New check needed. |
| `ubs_hardcoded_localhost` already exists as `phase: "post"`, `determinism: "heuristic"`, severity warning | `src/harness/check-registry/entries-warnings.ts:885-900` | Phase 1 *promotes* this check, not adds it. Promotion preconditions in Workstream A. |
| `ubs_hardcoded_localhost` fires on documentation files | **Self-evidence: this plan doc triggered it on first write** (the firing was caught at PostToolUse against `docs/plans/11-...md`) | Detector has no file-extension gate today. Tightening it to skip non-source extensions is the precondition for promotion. |
| `quality-checks.ts` dispatch loop is sequential: `for (const [name, check] of Object.entries(checks))` at `:191` | `src/harness/quality-checks.ts:191` | Real parallelism opportunity. Spawn-bound checks are the wins; CPU-bound share parse so already amortized. |
| `runBehavioralChecks` results push to `allCheckResults` only, never to agent-visible warnings | per plan 09 | Out of scope — plan 09 is fixing this. |
| `recordHarnessCaught({check_id, agent_source, session_id, file, message?, cwd?, ts?})` is the recurrence emission API | `src/harness/recurrence.ts:251-259` | Phase 1 extends *the existing call sites* to also record `phase` + `outcome_signal`; no new API. |
| `CheckRegistration.fn: (content, filePath) => InlineMatch[]` — stateless | `src/harness/check-registry/types.ts:53` | New checks must be stateless. Anything needing session state goes into `behavioral-checks.ts`, not the registry. |
| The verify.ts / check-metadata.ts / check-registry.ts (legacy mirror) **four-touchpoint pattern** is required for new registry checks | `CLAUDE.md` "Agent-quality checks" section | Each net-new check needs all four touchpoints landed atomically. |
| `simulateEdit` exists in `tsgo-runner.ts` as `(path, old_string, new_string) → diagnostics` | `src/harness/tsgo-runner.ts:38` | Generic in-memory edit application is **not** abstracted; tsgo-specific. Pre-tool evaluator does its own buffer apply for content checks. Out of scope to generalize. |
| `DEFAULT_ADVISORY_SKIPS` policy list is in `src/commands/verify.ts` and pinned by a regression test | `CLAUDE.md` `interlinked verify` section | New `pre_block` checks default to non-advisory; no skip-list entry needed. New `post` warning checks default to default-gate; demote to advisory only if FP rate observed >0. |

---

## Workstream A: Net-new `pre_block` checks

Six checks, severity=error, `pre_block`, agent_safety pipeline. Each is one entry in `entries-errors.ts`, one detector in `generic-checks.ts`, one metadata entry, one legacy mirror, one verify.ts touch, one test file. Per CLAUDE.md the four are co-dependent — land each check's full set atomically (one PR per check or one Node one-shot per check; NOT four sequential `Edit` calls per check, which the tsc diff-overlay will reject).

### Check inventory

| ID | Severity | Detection (sketch) | FP risk | Notes |
|---|---|---|---|---|
| `child_process_exec_user_input` | error | `child_process.exec(...)` / `execSync(...)` / `spawn(..., {shell: true})` where first arg is **not** a string-literal-only expression. Walk `CallExpression` whose callee resolves to one of those names; check first arg's AST shape. | ~0 (with non-literal gate) | Mirrors `ubs_subprocess_shell_true` for Node. |
| `mixed_sync_async_file_api` | error | Walk function bodies. If the body contains both an identifier ending in `Sync` from `fs`/`fs/promises` AND an `await` of an `fs`/`fs.promises` call, fire on the second occurrence. | ~0 | Almost always a partial-conversion bug. |
| `ubs_hardcoded_localhost` (promote, not add) | error (was warning) | Existing detector; **tighten first**: (a) skip non-source extensions (`.md`, `.txt`, `.yml`, `.yaml`, `.json`); (b) verify the existing test/config/example path gate is robust on this repo; (c) re-eval against the full repo to confirm 0 fires post-tightening. Only then flip `phase: "post" → "pre_block"`, `determinism: "heuristic" → "fully_deterministic"`, `severity: "warning" → "error"`. | ~0 after tightening | Promotion-with-tightening pattern. The current FP rate is non-zero — proven by this plan doc triggering the heuristic on first write. |
| `cookie_missing_security_flags` | error | Regex on diff hunk: `setHeader\(['\"]Set-Cookie['\"]` or `cookies\.set\(` or `res\.cookie\(` invocations whose **arguments** lack both `httpOnly: true` AND `secure: true`. AST-aware version preferred over regex; the regex form has high FP. | ~5% with regex; ~0 with AST | Implement AST-aware. |
| `function_constructor_non_literal` | error | `new Function(...)` calls where args contain at least one non-literal argument. Already partially covered by `eval_usage`? **Verify scope of `eval_usage` first**; if it includes `Function`, drop this check; if not, add it. | ~0 | Possibly redundant with eval_usage. |
| `logger_format_user_input` | error (narrow) | Identify `logger.info\|warn\|error\|debug(...)` calls where the FIRST argument is a non-literal expression containing references to identifiers reachable from `req.\|ctx.\|input\.\|user\.\|params\.`. Narrow seed list; expand only if FP rate stays at 0 in dogfood. | ~0 with narrow gate | Format-string injection / log poisoning. |

### Files per check

For each check `<id>`:

| File | Status | Purpose |
|---|---|---|
| `src/harness/generic-checks.ts` | edit | Add `check<PascalId>(content, filePath): InlineMatch[]` exported function. Keep stateless. |
| `src/harness/check-registry/entries-errors.ts` | edit | Add `CheckRegistration` entry with `phase: "pre_block"`, `severity: "error"`, `pipeline: "agent_safety"`, `tier: 1`, `determinism: "fully_deterministic"`. |
| `src/harness/check-metadata.ts` | edit | Add metadata row for docs generation. |
| `src/harness/check-registry.ts` | edit | Add legacy-mirror entry per CLAUDE.md (keeps the dead flat file in sync). |
| `src/commands/verify.ts` | edit | Add interface field, init, push, streamCqSection — the four co-dependent touchpoints. **Land atomically via Node one-shot.** |
| `src/harness/__tests__/generic-checks-extended.test.ts` (or new file) | edit/new | Test cases: positive (fires correctly), negative (does not fire on legit shapes), edge cases. **Include at least 3 negative cases per check** to lock in the ~0-FP discipline. |
| `src/harness/check-registry/entries-errors.test.ts` | edit | Add row to enumeration test. |

### Detection notes

- **AST vs regex:** all six should be AST-aware where the false-positive rate matters (specifically: `child_process_exec`, `cookie_missing_security_flags`, `logger_format_user_input`, `function_constructor_non_literal`). The repo already uses TypeScript's parser in `generic-checks.ts` for similar checks; reuse that. Regex-only is acceptable for `hardcoded_localhost_in_src` because the test-path gate is the FP control, not the pattern.
- **Diff-aware:** `pre_block` runs on the proposed buffer (whole file). Don't filter by changed-region inside the detector — the existing `pre_block` evaluator handles diff-aware suppression of pre-existing findings via the diff-overlay layer.
- **`content_keywords` pre-filter:** Set this for each check (e.g., `child_process_exec_user_input` → `["child_process"]`). Sub-millisecond `String.prototype.includes` skips per check on files that don't import the relevant module. Pattern documented at `check-registry/types.ts:56-73`.

### Validation

For each check before merge:
1. Unit tests: ≥3 positive, ≥3 negative cases.
2. Run `interlinked verify --all-checks` on this repo. Expected FP count: **0** for any of the six on existing code. If any fires on legit code, either tighten the detection or move the check to `post` warning (not advisory) — do not ship a `pre_block` with non-zero FP rate against this codebase.
3. Dogfood for one week. Track fire rate via the FP telemetry workstream below. If rate >2% suppress-rate or >0% manual-revert-rate, demote to `post` warning.

---

## Workstream B: Session-start anchor extension

Today: `session_start_head` captures HEAD SHA. Sufficient for clean working tree, breaks for dirty tree (which is the common case during active development).

Goal: capture a single SHA that anchors the *complete* world-state at session start, including untracked files.

### Files to change

| File | Status | Purpose |
|---|---|---|
| `src/lib/hook-template-chunks/session-state.ts` | edit | Around `:996-1022` (where `sessionStartHead` is captured). Extend the capture to also: (a) `git stash create` to get a stash-commit SHA representing the current working-tree + index state without touching refs; (b) `git ls-files --others --exclude-standard` to list untracked-but-not-ignored files (these are NOT in the stash commit). Persist as `session_start_anchor: { head: <sha>, worktree: <stash-sha or null>, untracked: string[], branch: string, timestamp: string }`. |
| `src/lib/local-activity.ts` | edit | Extend the session JSON shape (around `:117` where `session_start_head` is declared) with the new `session_start_anchor` object. Keep `session_start_head` populated for backwards compat (read it from `session_start_anchor.head`). |
| `src/lib/hook-template-chunks/session-state.test.ts` | edit | Reuse the existing SHA-injection test pattern (`:28`); the new fields must also be SHA-validated before any `execSync` interpolation. |
| New: `.interlinked/sessions/{session_id}.anchor.json` | runtime artifact | One file per session, written once at SessionStart. Cheaper to query than re-deriving from session JSON. |

### Implementation notes

- **`git stash create` is the right primitive.** Unlike `git stash` (which modifies refs and pops state), `git stash create` only writes commit objects to the object database and prints the SHA. Working tree is unmodified. Cost: ~50–200ms for a typical dirty tree, never modifies user state.
- **Untracked files:** `git stash create` does **not** include untracked files unless `-u` is passed, but the `-u` form is `git stash` (no `create`). Workaround: list them via `ls-files --others` and either (a) record paths only (cheaper, what this plan does) or (b) hash each path's content separately. (a) is sufficient because Phase 1 doesn't ship a replay command — it just lays the data foundation.
- **SHA validation:** All values that could end up in shell interpolation must pass `isGitSha` per the existing test (`session-state.test.ts:32`). The branch name is the only non-SHA field; sanitize to `[a-zA-Z0-9._/-]+` before any shell use.
- **No new Bash spawn beyond what the hook already does.** Hook already runs `git rev-parse HEAD` for `session_start_head`; add two more lightweight git invocations adjacent to it.

### Validation

- Test: dirty tree at SessionStart produces a stash-create SHA that is not HEAD's SHA.
- Test: clean tree produces a stash-create SHA that **equals** HEAD's tree SHA. (Use `git rev-parse HEAD^{tree}` to compare.)
- Test: untracked file list is non-empty when one exists, empty when none.
- Test: session-anchor JSON is created exactly once per session, idempotent under SessionStart replay.

---

## Workstream C: Parallel dispatch in quality-checks loop

Today: `src/harness/quality-checks.ts:191` runs checks via `for (const [name, check] of Object.entries(checks))` — sequential. The CPU-bound checks share a single parse and complete in ~5-50ms each, so per-check parallelism is marginal. **The real win is the spawn-bound checks** (tsc, biome, oxlint, gitleaks, semgrep, dep-audit) — each spawns a subprocess; today they run sequentially.

### Approach

1. Classify each check at registration time as `cpu` or `spawn`. Add `kind: "cpu" | "spawn"` to whatever interface the dispatch loop iterates. (Likely a one-line addition to a per-check descriptor; not the public `CheckRegistration` since that's for inline registry only — this is the higher-level `quality-checks.ts` orchestrator.)
2. Run all `spawn`-kind checks via `Promise.all` instead of sequential `for`. Drop-in `Promise.all([tsc(), biome(), oxlint(), ...])`.
3. Keep `cpu`-kind checks sequential — they share a parse and the dispatch overhead would dominate.
4. Per-check timeout: each spawn-kind check gets a wall-clock budget (configurable per check, default 30s). On timeout, emit a `check_timeout` event to recurrences and surface a `check_skipped` warning to the agent on the next turn. Prevents one slow check from gating PostToolUse delivery.

### Files to change

| File | Status | Purpose |
|---|---|---|
| `src/harness/quality-checks.ts` | edit | Refactor `:191` dispatch loop. Split into two passes: spawn-checks via `Promise.all` (with `Promise.allSettled` semantics so one timeout doesn't kill the rest), then cpu-checks sequentially. Preserve existing result aggregation order in the output. |
| `src/harness/quality-checks/instructions.ts` | edit (likely) | Add `kind` field to whatever per-check descriptor is consumed by the dispatch. Verify location during implementation. |
| `src/harness/__tests__/quality-checks-parallelism.test.ts` | new | Mock spawn-bound checks with controlled delays; verify total wall-clock < sum-of-individual-times. Also verify timeout semantics. |
| `src/harness/latency-log.ts` | edit | Capture per-check wall-clock + dispatch-mode (sequential/parallel). Already exists per `latency.jsonl`; just add the dimension. |

### Validation

- Latency regression test: ratio of total-PostToolUse-time to longest-individual-check-time must be ≤2.0 (not strict ≤1.0 since coordination overhead exists).
- Behavioral test: a check that throws does not affect other checks' results.
- Behavioral test: timeout on one check does not gate others; surfaces `check_timeout` to recurrences.
- Manual: profile a real edit cycle against this repo before/after; record p50/p95/p99 latency in the PR description.

---

## Workstream D: FP-rate telemetry emission

Goal: emit per-check-fire telemetry that Phase 2's aggregator will consume. Schema-stable, append-only, in `recurrences.jsonl` (existing log).

### Schema additions

Today's `harness_caught` event:
```json
{ "ts", "kind", "check_id", "agent_source", "session_id", "file", "message?", "cwd?" }
```

Phase 1 extension (additive only, optional fields):
```json
{
  "ts", "kind", "check_id", "agent_source", "session_id", "file",
  "phase": "pre_block" | "pre_warn" | "post",
  "severity": "error" | "warning",
  "outcome_signal": null,
  "outcome_reason": null
}
```

`outcome_signal` is filled in by **separate emission paths** later in the session lifecycle, not at fire time. Possible values:
- `null` — fire was emitted, outcome unknown (default)
- `"agent_fixed"` — within N turns, the file was edited in a way that would no longer fire this check (auto-derived; PostToolUse lookup)
- `"agent_suppressed"` — agent added a suppression directive (`@ts-ignore`, `// biome-ignore`, etc.) on a line within ±2 of the firing line
- `"user_overrode"` — user explicitly approved the bypass via the `pre_block` `decision: "ask"` flow
- `"check_reverted"` — agent reverted the change that triggered the fire

`outcome_reason` is a free-text one-liner explaining the signal (for `agent_suppressed`: the directive text + justification; for `user_overrode`: timestamp of approval).

The `agent_fixed` signal is the implicit positive — by far the most common, and the one the FP-rate aggregator will use as the denominator base. The other three are FP candidates.

### Files to change

| File | Status | Purpose |
|---|---|---|
| `src/harness/recurrence.ts` | edit | Extend `recordHarnessCaught` signature with optional `phase`, `severity` fields. Backwards compatible. ~10 LOC. |
| `src/harness/server.ts` | edit | Existing call sites that invoke `recordHarnessCaught` (around `:2237-2252` per plan 09) populate `phase` + `severity` from the `CheckResultEntry`. ~5 LOC delta. |
| `src/harness/recurrence.ts` (further edits) | edit | New function `markOutcome(check_id, file, session_id, signal, reason?)` — appends an `outcome_marker` event to the same JSONL with the `tool_use_id` cross-reference. Idempotent on (check_id, file, session_id, fire_ts). |
| `src/harness/server.ts` (post-tool path) | edit | After PostToolUse processing, scan recent fires for the same file. If a check that fired previously would no longer fire on the current content, emit `markOutcome(check_id, file, session_id, "agent_fixed")`. ~30 LOC. |
| `src/harness/server.ts` (suppression detection) | edit | Existing suppression-tracking infrastructure (`src/harness/suppressions.ts` per CLAUDE.md) — wire into `markOutcome` when a suppression directive lands within ±2 lines of a fire. ~15 LOC. |
| `src/harness/__tests__/recurrence-fp-telemetry.test.ts` | new | Tests for fire→fix, fire→suppress, fire→override, fire→revert paths. |

### Validation

- Schema test: `recurrences.jsonl` rows always include `phase` for new fires; existing rows without `phase` continue to read correctly.
- Behavioral test: edit a file to trigger a known check, then fix it — `outcome_signal: "agent_fixed"` lands in the log.
- Behavioral test: trigger a check, add `@ts-ignore` — `outcome_signal: "agent_suppressed"` lands.
- No aggregation in this workstream. Phase 2 reads the log; Phase 1 only writes.

---

## Sequencing

Workstreams are independent except for one dependency: Workstream A (new checks) should land **after** Workstream D (FP telemetry) so the new checks emit FP signals from day one. The other workstreams can land in any order.

| Order | Workstream | Reason |
|---|---|---|
| 1 | D (FP telemetry) | No new checks; just extends emission. Lowest risk. Lands the schema first so subsequent check additions write the new fields. |
| 2 | C (parallel dispatch) | Independent of A/B/D. Can ship anytime; sequencing here for early latency win. |
| 3 | B (session anchor) | Hook-template change; touches the runtime hook that's regenerated by `interlinked enable`. Need to test the regeneration path. |
| 4 | A (six new checks) | Per-check atomic land. Can be split into 6 PRs or one batch. Recommend one PR per check for review focus. |

Total estimated effort: **3–5 working days** for someone familiar with the codebase. Workstream A is the bulk (six checks × ~half-day each); the other three are ~half-day each.

---

## Out of scope (explicit)

Belongs in Phase 2 or later, not Phase 1:

- **FP-rate aggregator DO** (Phase 2) — Phase 1 only emits the data; no aggregation, no auto-demote loop.
- **Recurrence aggregator promotion to DO** (Phase 2) — local JSONL stays.
- **Mutation testing pipeline** (separate plan, `docs/plans/10-mutation-testing.md`).
- **Replay materializer** (`interlinked replay <session_id>`) (Phase 3) — Phase 1 lays the data foundation but ships no command.
- **API surface snapshot Artifacts** (Phase 3).
- **Tool-result capture** — already done; no work needed.
- **Phase routing infrastructure** — already done; new checks slot into existing tables.
- **`expectless_test` content check** — already covered by `assertion_density` behavioral check.
- **`eval_usage` / `inner_html` non-literal tightening** — separate task; if their existing scope is too broad, file as a follow-up. Not gating Phase 1.
- **worker_threads / true CPU parallelism** — out of scope; CPU-bound checks share parse, low ROI.
- **Behavior probe (`node dist --help`)** — Tier 3 from the design conversation. Solid idea but adds spawn cost on every CLI-command edit; defer to a later phase with explicit per-edit-path gating.
- **JSON schema validation as `pre_block`** — depends on per-file schema declaration plumbing not yet built. Defer.

---

## Open questions

1. **`eval_usage` / `inner_html` / `dangerously_set_inner_html` scope.** Verify during Workstream A implementation whether they fire on string-literal arguments. If yes, the question is whether to tighten them (separate task) or leave as-is (acceptable since string-literal `eval` is also a security smell). Decision: leave scope alone in Phase 1; flag as follow-up if tightening is wanted.

2. **`function_constructor_non_literal` redundancy with `eval_usage`.** Same verification. If `eval_usage` already detects `new Function`, drop this check from the inventory; otherwise add. Net outcome: either 5 or 6 new checks.

3. **`outcome_signal: "agent_fixed"` accuracy.** The "would no longer fire on current content" detection assumes idempotent re-evaluation. For checks with side-effects (none currently, but future ones could), need to ensure `markOutcome` re-evaluation is read-only. Current registry contract requires `fn` to be pure — enforce in tests.

4. **Session-anchor stash-create cost on huge dirty trees.** `git stash create` is fast on typical trees but could be slow on monorepos with thousands of dirty files. Worth measuring on a 1000-file dirty tree before merging. Fallback: skip stash-create above a configurable file threshold (e.g., >500 dirty files), record only the file list, accept partial replay fidelity.

---

## Validation gates before merge

The whole Phase 1 must pass:

- [ ] `npm run typecheck` clean.
- [ ] `npx vitest run` all tests pass.
- [ ] `interlinked verify` runs clean on this repo (zero new findings introduced by the new `pre_block` checks).
- [ ] `npm run docs` regenerates without diff (or with reviewable diff).
- [ ] `DEFAULT_ADVISORY_SKIPS` regression test still pinned (no new skips needed for `pre_block` errors).
- [ ] Manual: full edit→PostToolUse→recurrence emission cycle verified by hand against `.interlinked/recurrences.jsonl`.
- [ ] Manual: harness restart mid-session does not lose `session_start_anchor` (re-reads from session JSON).
- [ ] Per-check FP-rate measured against this repo at a minimum: ~0 fires on existing code.

---

## Out-of-band followups this plan creates

These are surfaced for a follow-up plan, not Phase 1 work:

- Add the `kind: "cpu" | "spawn"` field to `CheckRegistration` itself (rather than the higher-level descriptor), so future inline checks can declare their compute profile and the dispatcher can plan accordingly.
- Build the FP-rate aggregator DO (Phase 2 plan) once 1–2 weeks of data has accumulated under Workstream D's emission.
- Audit the existing 16 `pre_block` checks against the same FP-rate-from-telemetry data once it exists. Demote any that drift.
- Generalize `simulateEdit` (currently tsgo-specific) into a shared `applyProposedEdit(content, toolInput)` helper for any future check that needs a buffer to evaluate against.
