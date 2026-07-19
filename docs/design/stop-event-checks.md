# Stop-event checks — backlog and design principle

**Origin:** 2026-05-11 conversation triggered by `docs/external-pulse/failproofai.md`. Failproofai ships five `require-*-before-stop` policies (commit / push / PR / no-conflicts / CI-green) that form a *forward-march* pipeline pushing the agent toward `git push` as the path of progress. We adopted Tier 1 below and explicitly rejected the failproofai gate set as the wrong *direction* for our culture.

**Related.** `runtime-pipeline-staging.md` — the Tier 1 stop-event checks here are Stage 5 in the seven-stage pipeline; this doc's Tier 2/3 backlog enumerates Stage 5 deep gates (diff-mutation testing, counterfactual Graph Prediction Protocol, property-based testing, patch-level cloud review). Multi-agent debate / synthesis and Tier 3 prose-policy review have been relocated to Stage 6 (pre-push hook + on-demand), not Stage 5.

## Design principle

**Stop hooks should make the agent reflect before claiming done, not push it to ship.** Reuse signals only available at session boundaries (trajectory, cumulative edits, tool-use patterns). Prefer warnings / `instruct`-style nudges over hard denies — denies should be reserved for things genuinely unsafe to leave unfinished.

Three corollaries:

1. **Bias-aware.** Our culture biases toward *ship more carefully*. A Stop hook that fires "you have unpushed commits — run `git push` now" is actively hostile to that. Pushing should be an explicit user decision or instruction, never something a hook demands. Mirror the wording already used in `formatStopNudge` ("Don't push — leave that to the user.").
2. **Don't duplicate PreToolUse work.** If a check could fire at edit time, fire at edit time. Stop hooks are for *trajectory-level* signals that only make sense at session boundaries.
3. **Stop has a more forgiving latency budget than PreToolUse.** Per `feedback_hook_latency_budget.md`, per-event hooks have no sub-10 ms budget; Stop in particular is fine spending hundreds of milliseconds on `git fetch` / `gh api` calls because the agent is already stopping.

Reference for the failproofai shape we *didn't* take: `docs/external-pulse/failproofai.md` §"smarter Stop hooks."

## Tier 1 — shipped (2026-05-11, extended through 2026-07)

Orchestration: `src/harness/server/lifecycle-stop-warnings.ts` (`buildStopWarnings` → `buildCommitCadenceNudge` + `buildVerificationStopWarnings`), called from the Stop branch in `server/lifecycle-events.ts::handleStop` (which also runs the plan-drift nudge directly). Formatters: `verification-stop-checks.ts`, `commit-cadence.ts`, `dead-on-arrival.ts`, `fixture-leak.ts`, `plan-drift.ts`. Tests: `src/harness/server/lifecycle-stop-warnings.test.ts` (wiring) + per-formatter suites (`__tests__/verification-stop-checks.test.ts`, `commit-cadence.integration.test.ts`, …). Config: `verification_stop_checks` / `commit_cadence` / `plan_capture` in `rules/default-config.ts`. All stderr-only; none block.

The original 2026-05-11 set was three detectors; the shipped set has grown to fourteen nudges:

| Nudge | Gate | Fires when |
|---|---|---|
| commit-cadence (`formatStopNudge`) | `commit_cadence.enabled` | Too many uncommitted code-file edits this session (wording escalates by token band; never says push) |
| unverified-code | `warn_unverified_code` | Code edits with the verify-to-edit ratio far below the measured best-model floor (0.1) |
| verify-not-run | `warn_verify_not_run` | Individual tools ran but never the full verify suite; suppressed when unverified-code already fired (single-nudge invariant) |
| ui-not-interacted | `warn_ui_not_interacted` | UI-file edits (.tsx / .html / .css / …) with neither browser MCP nor dev-server observed |
| stubs-introduced | `warn_stubs_introduced` | `stubs_introduced` non-empty (TODO / FIXME / `throw new Error("not implemented")` / `it.skip(` / `xdescribe(`) |
| fixture-leaks | `warn_fixture_leaks` | Untracked orphan test fixtures left under `src/` after a test's cleanup didn't run |
| tdd-regression | always-on | A TDD cycle ended the session in `regression` state (went green, then red again) |
| unresolved-red | `warn_unresolved_red` | A check observed red never went green again: typecheck / build / lint via `observed_checks`, per-file test reds via `tdd_cycles`, and — since 2026-07 — whole-suite test runs via the `test-suite` observed-check kind (backlog 3A, now closed) |
| deferred-coverage | `per_edit_coverage.enabled` | The per-edit coverage gate deferred obligations that are still open at Stop (claimed-done coverage nothing ever ran) |
| bisect-not-reset | always-on | A `git bisect` started this session with no `bisect reset` after it |
| wip-commits | always-on (skips sessions with no baseline sha or no git-commit command) | The session created commits whose subjects read as scratch (`wip` / `fixup` / `tmp` / `temp` / `squash`); suggests `git rebase -i` before a PR (backlog 3B, now closed) |
| dead-on-arrival | always-on | A file edited this session whose fresh graph shard shows zero dependents and no callers (stays silent on stale/missing shards) |
| doc-marker-drift | always-on | Gen-markered doc fact sources edited without a `docs:build` run |
| plan-drift (lifecycle-events.ts) | `plan_capture` | Session trajectory diverged from the `declared_plan` captured at PreToolUse / UserPromptSubmit |

Signal capture lives close to the event, never in the Stop branch:
- `session-state.ts::recordEvent` — `classifyVerificationCommand(command)` on Bash + `classifyBrowserToolName(tool_name)` on MCP browser tools. Captures intent to verify (a failed `bun test` still counts — the agent did engage the verifier).
- `server/post-tool-pipeline-tracking.ts` — observed *outcomes*: `trackTestRun` (per-file test red/green → `test_runs` + `tdd_cycles`) and `trackVerificationOutcome` (typecheck / build / lint / whole-suite `test-suite` red/green → `observed_checks`), both classified via `classifyObservedOutcome` (tool_outcome-first; interrupted/unproven runs record nothing).
- `evaluator/post-tool.ts::recordStubsIntroduced` — scans `tool_input.content` (Write), `new_string` (Edit), and `edits[].new_string` (MultiEdit) on every `isFileWrite` event. One match per kind per call; capped at `STUB_INTRODUCED_CAP = 50` total per session.

## Tier 2 — reluctance-to-push (deferred)

These are direct inversions of failproofai's push-now bias. Each is a deterministic shell-out + parse, sub-second latency budget.

### 2A. Stale-base-branch warning

**Signal:** `git fetch origin <base> --quiet` (idempotent and cheap) + `git log HEAD..origin/<base> --oneline`. Non-empty output ⇒ branch is behind.

**Warning:** `"You'd be pushing behind N commits on origin/<base>. Rebase before pushing."` Opposite of failproofai's `require-push-before-stop` (which forces push regardless of base state).

**Open questions:**
- Should the `git fetch` happen at SessionStart instead of Stop to amortize cost? Either works; SessionStart is more invisible.
- How to detect the configured base branch — read `git symbolic-ref refs/remotes/origin/HEAD` or accept a config setting?

### 2B. Open PR has unresolved review threads

**Signal:** `gh api repos/{owner}/{repo}/pulls/<n>/reviews` + GraphQL query for `reviewThreads.isResolved == false`. Failproofai's own dogfooded `require-bot-reviews-resolved` (in their `.failproofai/policies/`) uses this pattern.

**Warning:** `"PR #N has N unresolved review threads from <bots>. Address them before stopping."` Especially useful for CodeRabbit / GitHub Copilot review noise that the agent tends to ignore.

**Open questions:**
- Whitelist by reviewer (only flag bots, not humans)? Bots almost always file resolvable nits; human reviews are usually about substance and shouldn't auto-flag.
- Token cost: every Stop fires a `gh api` call. Acceptable if Stop is rare; needs caching if Stop fires multiple times per session.

### 2C. *No `require-push-before-stop`-style gate at all*

Explicit non-feature. Documented here so future readers don't propose it again.

## Tier 3 — cleanup-before-stop (3A/3B/3D shipped 2026-07; 3C deferred)

Quality signals beyond the verification axis.

### 3A. Last test invocation failed — SHIPPED 2026-07

Per-file test reds were already covered (stayed-red `tdd_cycles` flow through `formatUnresolvedRedWarning`); the gap was whole-suite runs (`vitest run` / `npm test` with no file arg), which neither `test_runs` nor `observed_checks` tracked. Closed by extending `ObservedCheck.kind` with `test-suite`: `observedCheckKindFor` (`server/post-tool-pipeline-tracking.ts`) now maps a `test` verification signal to `test-suite` when `detectTestRunFile` resolves no specific file (either the `ALL_TESTS_SENTINEL` or an unrecognized runner). Per-file runs stay deliberately excluded — the TDD cycle owns per-file red/green, and double-tracking would report the same red twice. The existing unresolved-red Stop nudge renders the new kind with no formatter change. Same landing also fixed the latent `trackTestRun` pass/fail bug (a folded `tool_outcome === "error"` on a regular PostToolUse counted as PASSED) by reusing `classifyObservedOutcome`.

### 3B. Session has many small experimental commits — SHIPPED 2026-07

`collectWipCommitSubjects` + `formatWipCommitsNudge` (`commit-cadence.ts`), wired as `checkWipCommits` in `lifecycle-stop-warnings.ts`. Range is `git_session_baseline.head_sha..HEAD` so only this session's commits count; the subject regex is anchored to the start (`fix wip detection` is not a wip commit); deliberate autosquash `fixup!`/`squash!` markers are excluded (the FP the open question named); the git shell-out is gated behind a git-commit-shaped entry in `commands_run` so read-only Stops never fork. Still doesn't suggest pushing.

### 3C. Debug toggle left on

**Signal:** trajectory-level — detect Write/Edit events that set `DEBUG=true`, `verbose: true`, `console.log(`, or known logger boilerplate without a subsequent Edit reverting. Expensive to do reliably; current confidence is too low to ship.

### 3D. New exported symbol with no test importing it — SHIPPED 2026-07

**Signal:** cross-reference `session.files_written` against the project graph (`project-graph.ts`). For each exported symbol introduced this session, check whether any `*.test.{ts,js}` file references it. We have impact-analysis machinery for this already.

Shipped as `detectUntestedExports` + `formatUntestedExportsWarning` (`untested-exports-stop-check.ts`), wired as `checkUntestedExports` in `lifecycle-stop-warnings.ts`. The graph provider is injected and LAZY — `getGraphForFile` is only invoked when the session wrote at least one eligible code file (graph-indexable source, not a test, not `.d.ts`), so read-only Stops never pay graph-build cost. Coverage evidence = a word-boundary reference to the symbol in any *test-file dependent* of the written module (per the daemon's cached project graph, which PostToolUse keeps refreshed via `updateFile`). The staleness + early-TDD FP concerns are handled by failing open on every "can't tell" path (file not indexed, no named exports, unreadable test dependent, graph init throw) and by the warning text naming the TDD carve-out explicitly ("a reminder, not a block"). Reflection only; stderr; never blocks.

## Implementation patterns to reuse

When picking up any of these, mirror the existing scaffolding:

- **Pure formatter file:** `src/harness/<concern>-stop-checks.ts` exporting `formatXxxWarning(opts): string | null` functions. Pattern is in `commit-cadence.ts` and `verification-stop-checks.ts`.
- **Config interface:** add a `XxxStopChecksConfig` to `types.ts::GuardRulesConfig`, default-on in `rules/default-config.ts`. Per-kind boolean flags + master `enabled` toggle.
- **Signal capture lives close to the event:** trajectory-only signals in `session-state.ts::recordEvent`; observed red/green outcomes in `server/post-tool-pipeline-tracking.ts`; content-bearing signals (`tool_input.content` / `new_string` / `edits`) in `evaluator/post-tool.ts`. The Stop branch (`server/lifecycle-stop-warnings.ts`, called from `server/lifecycle-events.ts::handleStop`) only *reads* — never scans content there (a Stop-time `git log` / working-tree scan is fine per corollary 3).
- **Test pattern:** mirror `commit-cadence.integration.test.ts` and `verification-stop-checks.test.ts` — pure-function unit tests for each formatter with positive and negative cases per axis. No e2e harness wiring needed at this layer.

## What we explicitly rejected from failproofai

| Failproofai policy | Why we didn't take it |
|---|---|
| `require-commit-before-stop` (hard deny) | We already have `formatStopNudge` (warning). Hard-blocking at Stop is "the lever held in reserve" per `commit-cadence.ts`. |
| `require-push-before-stop` | Wrong direction — see "Design principle" above. |
| `require-pr-before-stop` | Same direction problem. PRs are explicit user decisions. |
| `require-no-conflicts-before-stop` | The merge-tree primitive is good (`git merge-tree --write-tree`) but the gate fires too late — by Stop, the conflict has already been brewing. Better surface is a *PreToolUse* check on `git push` itself, not Stop. Filed as a separate consideration, not on this roadmap. |
| `require-ci-green-before-stop` | Same direction problem. CI is a downstream concern, not a session-end gate. |

The one piece of failproofai infrastructure worth reconsidering separately is the `git merge-tree --write-tree` primitive in `require-no-conflicts-before-stop` — it's the cleanest known way to detect would-be merge conflicts locally without performing the merge. Worth a separate spike whenever conflict detection enters scope.
