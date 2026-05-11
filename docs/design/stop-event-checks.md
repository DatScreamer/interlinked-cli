# Stop-event checks — backlog and design principle

**Origin:** 2026-05-11 conversation triggered by `docs/external-pulse/failproofai.md`. Failproofai ships five `require-*-before-stop` policies (commit / push / PR / no-conflicts / CI-green) that form a *forward-march* pipeline pushing the agent toward `git push` as the path of progress. We adopted Tier 1 below and explicitly rejected the failproofai gate set as the wrong *direction* for our culture.

## Design principle

**Stop hooks should make the agent reflect before claiming done, not push it to ship.** Reuse signals only available at session boundaries (trajectory, cumulative edits, tool-use patterns). Prefer warnings / `instruct`-style nudges over hard denies — denies should be reserved for things genuinely unsafe to leave unfinished.

Three corollaries:

1. **Bias-aware.** Our culture biases toward *ship more carefully*. A Stop hook that fires "you have unpushed commits — run `git push` now" is actively hostile to that. Pushing should be an explicit user decision or instruction, never something a hook demands. Mirror the wording already used in `formatStopNudge` ("Don't push — leave that to the user.").
2. **Don't duplicate PreToolUse work.** If a check could fire at edit time, fire at edit time. Stop hooks are for *trajectory-level* signals that only make sense at session boundaries.
3. **Stop has a more forgiving latency budget than PreToolUse.** Per `feedback_hook_latency_budget.md`, per-event hooks have no sub-10 ms budget; Stop in particular is fine spending hundreds of milliseconds on `git fetch` / `gh api` calls because the agent is already stopping.

Reference for the failproofai shape we *didn't* take: `docs/external-pulse/failproofai.md` §"smarter Stop hooks."

## Tier 1 — shipped 2026-05-11

Code: `src/harness/verification-stop-checks.ts`, wired into `src/harness/server.ts` Stop / SessionEnd branch. Tests: `src/harness/__tests__/verification-stop-checks.test.ts`. Config: `verification_stop_checks` in `rules/default-config.ts` (default-on per kind, all stderr-only).

| Detector | Signal | Fires when |
|---|---|---|
| `warn_unverified_code` | `verification_observed` Set tracks Bash commands matching tsc / vitest / cargo test / pytest / biome / eslint / npm run build / etc. | Session has code-file edits AND no correctness signal (typecheck / test / lint / build) was observed |
| `warn_ui_not_interacted` | same set tracks browser MCP (`mcp__chrome-devtools__*` / `mcp__playwright__browser_*`) and dev-server starts | Session has UI-file edits (.tsx / .jsx / .html / .css / .vue / .svelte / .astro) AND neither browser nor dev-server was observed |
| `warn_stubs_introduced` | `stubs_introduced` array populated at PostToolUse by `scanForStubs(content/new_string)` | Array is non-empty (TODO / FIXME / `throw new Error("not implemented")` / `it.skip(` / `xdescribe(` matches) |

Signal capture lives in two places:
- `session-state.ts::recordEvent` — `classifyVerificationCommand(command)` on Bash + `classifyBrowserToolName(tool_name)` on MCP browser tools. Captures intent to verify (a failed `bun test` still counts — the agent did engage the verifier).
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

## Tier 3 — cleanup-before-stop (deferred)

Quality signals beyond the verification axis. Lower priority than Tier 2.

### 3A. Last test invocation failed

**Signal:** parse `session.test_runs` (already tracked in `session-state.ts`) for the most recent entry with `status === "fail"`. If no subsequent successful run of the same file → warn.

**Warning:** `"Last test run on <file> failed at step N. Either fix the failure or document the regression before stopping."`

**Why this is Tier 3, not Tier 1:** `test_runs` only tracks runs where the agent invoked a test file directly. The signal misses `bun run test` (whole-suite) entirely. Would need broader test-output parsing to be reliable.

### 3B. Session has many small experimental commits

**Signal:** `git log <base>..HEAD --oneline` + regex on commit messages for `\b(wip|fixup|squash|tmp|debug|scratch)\b`. Count.

**Warning:** `"Branch has N WIP-style commits since <base>. Consider \`git rebase -i\` to clean up before opening a PR."` Note: still doesn't suggest pushing.

**Open questions:**
- False positives on legitimate `fixup!` commits the agent is intentionally leaving for an autosquash.

### 3C. Debug toggle left on

**Signal:** trajectory-level — detect Write/Edit events that set `DEBUG=true`, `verbose: true`, `console.log(`, or known logger boilerplate without a subsequent Edit reverting. Expensive to do reliably; current confidence is too low to ship.

### 3D. New exported symbol with no test importing it

**Signal:** cross-reference `session.files_written` against the project graph (`project-graph.ts`). For each exported symbol introduced this session, check whether any `*.test.{ts,js}` file references it. We have impact-analysis machinery for this already.

**Why this is Tier 3:** needs project-graph staleness handling (was the graph refreshed since the agent's edits?) and the signal has high FPs in early TDD — an exported symbol can legitimately not have a test yet if the test file is the next thing the agent will write.

## Implementation patterns to reuse

When picking up any of these, mirror the existing scaffolding:

- **Pure formatter file:** `src/harness/<concern>-stop-checks.ts` exporting `formatXxxWarning(opts): string | null` functions. Pattern is in `commit-cadence.ts` and `verification-stop-checks.ts`.
- **Config interface:** add a `XxxStopChecksConfig` to `types.ts::GuardRulesConfig`, default-on in `rules/default-config.ts`. Per-kind boolean flags + master `enabled` toggle.
- **Signal capture lives close to the event:** trajectory-only signals in `session-state.ts::recordEvent`; content-bearing signals (`tool_input.content` / `new_string` / `edits`) in `evaluator/post-tool.ts`. Stop-branch (`server.ts:666`) only *reads* — never scans content there.
- **Test pattern:** mirror `commit-cadence.test.ts` and `verification-stop-checks.test.ts` — pure-function unit tests for each formatter with positive and negative cases per axis. No e2e harness wiring needed at this layer.

## What we explicitly rejected from failproofai

| Failproofai policy | Why we didn't take it |
|---|---|
| `require-commit-before-stop` (hard deny) | We already have `formatStopNudge` (warning). Hard-blocking at Stop is "the lever held in reserve" per `commit-cadence.ts`. |
| `require-push-before-stop` | Wrong direction — see "Design principle" above. |
| `require-pr-before-stop` | Same direction problem. PRs are explicit user decisions. |
| `require-no-conflicts-before-stop` | The merge-tree primitive is good (`git merge-tree --write-tree`) but the gate fires too late — by Stop, the conflict has already been brewing. Better surface is a *PreToolUse* check on `git push` itself, not Stop. Filed as a separate consideration, not on this roadmap. |
| `require-ci-green-before-stop` | Same direction problem. CI is a downstream concern, not a session-end gate. |

The one piece of failproofai infrastructure worth reconsidering separately is the `git merge-tree --write-tree` primitive in `require-no-conflicts-before-stop` — it's the cleanest known way to detect would-be merge conflicts locally without performing the merge. Worth a separate spike whenever conflict detection enters scope.
