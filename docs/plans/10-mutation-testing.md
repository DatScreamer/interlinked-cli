# Mutation Testing — Phased Rollout

> **RETIRED 2026-08-07 — superseded by a different architecture. Do not build the CLI
> described here.** This plan proposes an async `interlinked mutate --diff` command
> writing into `recurrences.jsonl`; neither the command nor that recurrence kind exists,
> and neither should. What shipped is a **synchronous per-edit gate** in
> `src/harness/mutation/` with stable mutant identity and its own manifest — see
> `docs/design/per-edit-cloud-mutation-testing.md` for the architecture and
> `docs/plans/15-survivor-elimination-campaign.md` (now BACKGROUND priority) for the
> cleanup campaign. Kept for the phased-rollout reasoning and the case for mutation
> testing, which still hold.

Mutation testing as a hook-triggered, async-executed quality signal. Three phases: local detached subprocess (Phase 1), cloud fan-out (Phase 2), cross-session aggregation (Phase 3). Each phase is independently shippable and strictly composes with the next — the agent-facing surface is identical across phases; only the compute location moves.

## TL;DR

- Mutation testing's cost shape (`mutants × test_suite`, minutes to hours) excludes it from any synchronous hook. The harness can never *run* it inside a PreToolUse or PostToolUse round-trip.
- The harness *can* trigger it asynchronously and *consume* its output. Triggering is a fire-and-forget subprocess (Phase 1) or a fire-and-forget HTTP POST (Phase 2). Consumption is a single-line read of `recurrences.jsonl`.
- All three phases share one agent-facing surface: PostToolUse warnings on edits to files with surviving mutants, plus a UserPromptSubmit `additionalContext` injection at the start of each agent turn listing the worst offenders.
- **Depends on `docs/plans/09-local-runtime-quality-hooks.md` shipping first.** That plan establishes the recurrence-driven warning surface; this plan reuses it. Don't build mutation testing before assertion density and coverage land — without those cheaper signals running first, mutation findings have no proven consumption path.
- **Depends on `docs/plans/08-hook-server-protocol-mismatch.md` being resolved.** PreToolUse warnings need to actually reach the agent (`additionalContext` is the load-bearing surface for the UserPromptSubmit injection); the framed-RPC vs raw-JSON split silently breaks every PreToolUse advisory in the current build. Phase 1 ships fine without that fix because PostToolUse stderr already works, but Phase 1's UserPromptSubmit injection requires the fix.

## Goal

Catch the most expensive form of the test-quality failure mode: tests that *exist*, *run*, and *assert*, but assert against the wrong invariant. The mutation tester provides the only deterministic answer to "does this test actually verify what it claims to verify?"

The user's framing captures it precisely: coverage tells you what was *executed*; mutation tells you what was *checked*. A test suite at 98% line coverage with surviving mutants is a test suite that runs your code without verifying it. The two earlier plans (assertion density at the test-file level; coverage at the line level) catch the cheaper versions of this failure. This plan catches what they miss.

## Context

The harness already has all the consumption infrastructure needed:

- `recurrences.jsonl` (`src/harness/recurrence.ts`) is the universal append-only log for repeating-pattern findings. Three existing `kind` values: `harness_caught`, `harness_missed`, `codebase_existing`. Adding `mutation_surviving` is a one-line registration.
- `proposeAction` ratchets recurring rows from advisory → default → block over time. No new escalation logic.
- The PostToolUse fan-out at `server.ts:1514` already iterates per file and surfaces warnings via the existing decision pathway.
- Claude Code's `additionalContext` mechanism (per the recent commit `42c47f2`, "route Claude Code PreToolUse advisories via additionalContext") gives a path to inject standing context at the start of each agent turn — load-bearing for the "agent sees surviving mutants before deciding what to edit" surface.
- `SECURITY_DOMAIN_RE` in `src/harness/behavioral-checks.ts:18` already classifies auth/crypto/oauth/etc. paths. Phase 2's fan-out queue uses this for prioritization.

What's missing: the *runner* (Phase 1) and the cloud orchestrator (Phase 2). Both write into the existing recurrence pipeline; the harness side is purely consumption.

## The agent-facing surface (phase-invariant)

This is the contract every phase honors. Build it first, validate it with hand-written fixtures before the runner exists.

### PostToolUse warning on edit

When the agent edits `src/foo.ts` and `recurrences.jsonl` has at least one row with `kind: "mutation_surviving"` and `file: "src/foo.ts"`:

```
[heuristic] mutation_surviving: foo.ts has 3 surviving mutants from last run:
  line 42 (== → !=)
  line 89 (x → null)
  line 134 (>= → >)
Strengthen the test asserting these behaviors before adding more impl edits.
```

Determinism tag is `[heuristic]`: the mutator's "this mutation isn't caught by your tests" claim is provably true (the mutated code passed every test), but mapping that back to "you need a stronger assertion *here*" is heuristic — the assertion that should kill it might live in a totally different test file.

### UserPromptSubmit `additionalContext` injection

At the start of each agent turn, if `recurrences.jsonl` has surviving mutants in any file the agent has touched this session, inject:

```
Surviving mutants in files you've touched this session:
  src/auth/jwt.ts: 5 surviving mutants (CRITICAL — security domain)
  src/lib/parser.ts: 3 surviving mutants
  src/utils/clamp.ts: 1 surviving mutant
Killing these (i.e., strengthening tests so they fail under the mutation) is higher-priority than new feature work in these files.
```

This is the load-bearing surface. PostToolUse warnings catch the agent at the moment of edit; `additionalContext` catches them at the moment of *planning*, before they decide what to edit.

### TDD commit gate integration

When `git commit` is detected (existing logic at `server.ts:1087`), `checkTddCommitGate` already runs. Add a sibling `checkMutationGate` that returns `error` severity if any file in `session.files_written` has `mutation_surviving` rows newer than the most recent test pass for that file. Mode-respecting: `nudge` → info, `warn` → warning, `enforce` → block.

## Phase 1 — Local detached runner

### Scope

- New CLI command: `interlinked mutate --diff [--file PATH]`. Runs Stryker (TS/JS) or `mutmut` (Python) or `cargo-mutants` (Rust) in incremental/diff mode, writes results to `recurrences.jsonl`.
- Hook trigger: PostToolUse on Write/Edit fires a detached `interlinked mutate --diff --file <path> &` when a heuristic budget says it's worth running (cooldown elapsed, file is non-trivial, not already in flight).
- Manual trigger: `interlinked mutate` standalone for ad-hoc full-diff runs.

### Files to add / change

| File | Status | Purpose |
|---|---|---|
| `src/commands/mutate.ts` | new | CLI command. Parses `--diff` / `--file` / `--report`. Dispatches to language-specific runners. ~250 LOC. |
| `src/lib/mutation-runners.ts` | new | Per-language runner adapters: `runStryker(opts)`, `runMutmut(opts)`, `runCargoMutants(opts)`. Each returns `MutationReport`. ~200 LOC. |
| `src/lib/mutation-report.ts` | new | Normalize per-tool output (Stryker JSON, mutmut text, cargo-mutants JSON) → unified `MutationFinding[]`. ~150 LOC. |
| `src/harness/mutation-trigger.ts` | new | PostToolUse hook helper: `maybeTriggerMutationRun(session, filePath)`. Decides whether to spawn, manages in-flight set, enforces cooldown. ~80 LOC. |
| `src/harness/recurrence.ts` | edit | Register `mutation_surviving` kind. Add `recordMutationSurviving(finding: MutationFinding)`. |
| `src/harness/server.ts` | edit | Three insertions: PostToolUse trigger after the existing per-file checks at `server.ts:1514`; PostToolUse warning emission alongside coverage_gap warnings; UserPromptSubmit `additionalContext` injection (new event handler). |
| `src/harness/types.ts` | edit | Extend `SessionTrajectory` with `mutation_runs_in_flight: Set<string>` and `mutation_last_run_at: Map<filePath, timestamp>`. |
| `src/index.ts` | edit | Register `mutate` command. |
| `src/commands/__tests__/mutate.test.ts` | new | Per-language adapter tests. Mock subprocess output, assert finding extraction. |
| `src/harness/__tests__/mutation-trigger.test.ts` | new | Cooldown tests, in-flight de-dup, security-domain prioritization. |
| `src/harness/__tests__/mutation-recurrence.test.ts` | new | End-to-end: spawn fake mutate output → recurrence row → PostToolUse warning. |
| `package.json` | edit | Add Stryker and `@stryker-mutator/vitest-runner` to `optionalDependencies`. They're heavyweight; don't make them required. |
| `docs/generated/quality-checks.md` | regen | After registration. |

### Module surface

```typescript
// src/lib/mutation-report.ts

export interface MutationFinding {
  file: string;            // absolute path
  line: number;
  column?: number;
  mutator: string;         // e.g., "ConditionalExpression", "ArithmeticOperator"
  original: string;        // the code as written
  mutated: string;         // the code with the mutation applied
  status: "Survived" | "Killed" | "Timeout" | "NoCoverage" | "RuntimeError" | "CompileError";
  /** The test files that ran this mutant. Used to decide which test
   *  needs strengthening. */
  killing_tests?: string[];
  /** Tests that *should* have caught it but didn't. Empty for non-Stryker
   *  runners that don't track per-mutant coverage. */
  covering_tests?: string[];
}

export interface MutationReport {
  run_id: string;
  started_at: string;       // ISO 8601
  finished_at: string;
  language: "ts" | "js" | "py" | "rs";
  scope: { kind: "diff"; base_ref: string } | { kind: "file"; path: string } | { kind: "full" };
  findings: MutationFinding[];
  /** Mutants that survived. The agent's worklist. */
  surviving_mutants(): MutationFinding[];
  /** Surface mutation score: kill_rate = killed / (killed + survived). */
  score(): { killed: number; survived: number; rate: number };
}
```

```typescript
// src/harness/mutation-trigger.ts

export interface MutationTriggerArgs {
  session: SessionTrajectory;
  filePath: string;
  cwd: string;
}

const COOLDOWN_MS = 5 * 60 * 1000;          // 5 min between same-file runs
const MIN_FILE_SIZE_BYTES = 200;            // skip stubs / type-only files
const MAX_CONCURRENT = 1;                   // serial by default; tune after dogfood

/**
 * Decides whether to spawn a mutation run for the just-edited file. Side
 * effects: spawns detached subprocess, updates session.mutation_*. Pure
 * fail-open: never throws, never blocks the hook.
 */
export function maybeTriggerMutationRun(args: MutationTriggerArgs): void {
  const { session, filePath, cwd } = args;

  if (session.mutation_runs_in_flight.size >= MAX_CONCURRENT) return;
  if (session.mutation_runs_in_flight.has(filePath)) return;

  const lastRun = session.mutation_last_run_at.get(filePath) || 0;
  if (Date.now() - lastRun < COOLDOWN_MS) return;

  if (!isWorthMutating(filePath, cwd)) return;

  session.mutation_runs_in_flight.add(filePath);
  session.mutation_last_run_at.set(filePath, Date.now());

  const child = spawn(
    "interlinked",
    ["mutate", "--diff", "--file", filePath, "--report", "recurrences"],
    { detached: true, stdio: "ignore", cwd },
  );
  child.unref();
  child.on("exit", () => session.mutation_runs_in_flight.delete(filePath));
}
```

### Tooling matrix

Per-language. Phase 1 ships TS/JS only; Python and Rust are documented as Phase 1.b extensions.

| Language | Tool | Diff mode | Report format | Notes |
|---|---|---|---|---|
| TS / JS | Stryker (`@stryker-mutator/core`) | `--since` (incremental) + `--mutate` glob | JSON (`reports/mutation/mutation.json`) | Vitest runner via `@stryker-mutator/vitest-runner`. Watch for the well-known incremental-mode flakiness; pin to a known-good Stryker version. |
| Python | `mutmut` | `--paths-to-mutate` + git diff scoping | text or `mutmut results --json` | Slower than Stryker; raise cooldown. |
| Rust | `cargo-mutants` | `--in-diff main` | JSON via `--list --json` then per-mutant runs | Cargo's incremental compile already amortizes the cost. |
| Go | (skip in Phase 1) | — | — | `gremlins` and `go-mutesting` exist but are immature. Defer. |

### Cost / cadence

| Operation | Cost |
|---|---|
| Stryker `--since` on a single-file diff (this CLI's size) | 30s–3min depending on test scope |
| Stryker full-suite | 30min–2h |
| Subprocess spawn from PostToolUse | <1ms in the hot path |
| Hook consumption of `recurrences.jsonl` (Phase 1 read) | <5ms |
| TDD commit gate `checkMutationGate` | <5ms |

The cooldown (5 min) is the tightest knob in the system — too short and the agent's machine is constantly running mutation tests; too long and mutants survive longer than they should. Start at 5 min, adjust after a week of dogfooding. Make it user-configurable via `structural_checks.mutation_cooldown_ms`.

### Failure modes

| Failure | Mitigation |
|---|---|
| Equivalent mutants (mutation is a semantic no-op, e.g. `++x; return x` vs `x++; return x`) reported as Survived but unfixable | Stryker's `excludedMutations` config + per-line `// stryker-disable next-line` annotations (or per-project equivalent). Surface a `dismissed_mutant` recurrence row that doesn't ratchet. |
| Slow tests amplify mutation cost catastrophically | Skip files whose test suite exceeds `mutation_max_test_seconds` (default 30s). Document in the failure warning so the agent knows why mutation didn't run. |
| Flaky tests poison results (mutant marked Survived because the test that should have killed it flaked) | Stryker's `--retryFailedTests` plus a flake-detection signal: if the same mutant flips Survived/Killed across runs, suppress the row. Out of scope for v1; document as known limitation. |
| Mutation runs corrupt the TDD cycle state (every mutant runs the test suite, harness sees N "test passed" events) | Pass `INTERLINKED_MUTATION_RUN=1` env var into the spawned mutator. Harness's `recordTestRunCycle` (`server-tdd-cycle.ts:126`) checks the env on its parent process tree and skips if set. Per the supermodel-thesis memory: detection precision matters; don't poison the trajectory. |
| Mutation tools have heavy node_modules footprints | `optionalDependencies` (per CLAUDE.md spirit: don't add backwards-compat hacks but also don't force a 200MB install on every CLI user). User opts in via `npm install @stryker-mutator/core @stryker-mutator/vitest-runner` once. `interlinked mutate` errors clearly if missing. |
| Subprocess spawn on every edit produces a thundering herd if cooldown is misconfigured | Hard concurrency cap (`MAX_CONCURRENT = 1`). If a run is in flight for any file, skip new triggers. Document the cap. |
| User runs `interlinked mutate` while the harness is also triggering it | Lockfile at `.interlinked/cov/mutation.lock`. Second invocation no-ops with a clean message. |

### Testing

Vitest, with subprocess mocking. Specific cases:

- Stryker JSON fixture (committed) → expected `MutationFinding[]`.
- mutmut text fixture → expected `MutationFinding[]`.
- cargo-mutants JSON fixture → expected `MutationFinding[]`.
- `maybeTriggerMutationRun` cooldown: two calls inside 5 min → second skipped.
- `maybeTriggerMutationRun` in-flight de-dup: two calls for same file before first exits → second skipped.
- `INTERLINKED_MUTATION_RUN=1` env → `recordTestRunCycle` skips trajectory updates.
- End-to-end: fake mutate-cli output → recurrence row → PostToolUse warning on subsequent edit of the same file → UserPromptSubmit injection on next turn.
- Property: same input report parses to identical findings across runs.

### Acceptance criteria (Phase 1)

| Criterion | Verification |
|---|---|
| `interlinked mutate --diff` runs Stryker on this CLI's own changed files and produces a valid `MutationReport` | `npm run mutate` (alias) on a feature branch with deliberately weak tests |
| `recurrences.jsonl` gets a `mutation_surviving` row for each Survived mutant | `interlinked recurrence list --kind mutation_surviving` shows rows |
| Editing a file with surviving mutants emits a PostToolUse `[heuristic] mutation_surviving` warning | Manual: edit a file with seeded surviving mutants, observe the warning |
| Cooldown prevents thundering-herd: 10 rapid edits to the same file produce ≤1 spawn | Counter test |
| Mutation runs don't pollute TDD cycle state | Assert `session.tdd_cycles` unchanged after a mutation run with the env var set |
| Per-edit hot-path latency unchanged from baseline | Bench |
| Trigger fail-open: mutate command missing → no harness error, no warning, just silence | Manual: rename the command, observe |

## Phase 2 — Cloud fan-out

### Scope

Same agent surface, same recurrence pipeline. Replace the local detached subprocess with an HTTP POST to the Interlinked MCP Server, which queues a fan-out job across N Workers/sandboxes. Results stream back through the existing activity stream and land in `recurrences.jsonl` with a slight delay (minutes) but no developer-machine cost.

### Why move to the cloud

- **Embarrassingly parallel.** Each mutant is an independent test-suite run. 1000 mutants × 30s suite = 8.3h sequential, ~5min on 100 Workers. The local single-machine path can't compete on full-suite runs.
- **Frees the developer's machine.** Mutation testing pins cores for tens of minutes — exactly the wrong shape for a tool the developer is also using to type.
- **Aligns with the cloud-cadence triggers.** PR-open and nightly runs are the natural fit; both want to be cloud-driven.
- **Per `feedback_safety_continuity.md`**: the local trigger continues to work as a fail-open path when the cloud is unavailable. No circuit breaker.

### Files to add / change

| File | Status | Purpose |
|---|---|---|
| `src/lib/api-client.ts` | edit | Add `postMutationJob(req: MutationJobRequest): Promise<{ job_id: string }>` and `pollMutationJob(jobId: string): Promise<MutationReport \| null>`. |
| `src/harness/mutation-trigger.ts` | edit | Branch on `rules.mutation?.runner === "cloud" \| "local" \| "auto"`. Default `auto`: cloud when authenticated and reachable, local fallback. |
| `src/harness/server-bridge.ts` | edit | Subscribe to mutation results in the existing activity stream consumer. Same shape as guard-event reporting. |
| `(server repo) /api/mutate/queue` | new | Server-side endpoint. Accepts `{ workspace_id, file, base_ref, language }`. Returns `{ job_id }`. Queues a fan-out. |
| `(server repo) /api/mutate/result` | new | Pushed via existing activity-stream subscription. CLI's server-bridge writes to `recurrences.jsonl`. |
| `(server repo) Workflows / fan-out runner` | new | Cloudflare Workflows or Durable Object worker pool. Each worker pulls a mutant batch, runs in a sandbox, posts result. Out of scope for this CLI plan; tracked in the server repo. |

### Server-side shape (informational; lives in the sibling repo)

Mentioned only because the CLI's behavior depends on the contract:

- **Queue endpoint** accepts a workspace-scoped mutation job. Server runs Stryker / mutmut / cargo-mutants inside Cloudflare Sandboxes (`cloudflare:sandbox-sdk`), one mutant batch per sandbox, fan-out factor configurable per workspace.
- **Result delivery** flows through the existing activity stream. CLI's `server-bridge.ts` already polls / subscribes — no new transport.
- **Auth / authorization** uses the existing CLI auth path (`src/lib/auth.ts`). Workspaces opt in to mutation testing in their server-side workspace settings.
- **Rate limiting / cost control** lives entirely server-side. The CLI just queues; the server decides how much to spend.

### Trigger logic (`runner: "auto"`)

```typescript
async function dispatchMutationRun(args: MutationTriggerArgs): Promise<void> {
  const { session, filePath, rules } = args;
  const runner = rules.mutation?.runner ?? "auto";

  if (runner === "cloud" || (runner === "auto" && await isCloudReachable())) {
    try {
      const { job_id } = await postMutationJob({
        file: filePath,
        base_ref: rules.mutation?.base_ref ?? "main",
        language: detectLanguage(filePath),
      });
      session.mutation_runs_in_flight.add(`cloud:${job_id}`);
      // Result lands via server-bridge → recurrences.jsonl, no further action.
      return;
    } catch (err) {
      log(`Cloud mutation queue failed (${err}); falling back to local`);
    }
  }

  spawnLocalMutationRun(args);
}
```

Cloud failures fall back to local. Local failures fail open. No circuit breaker (per `feedback_safety_continuity.md`).

### Cost / cadence

| Operation | Local cost | Cloud cost |
|---|---|---|
| Single-file diff mutation | 30s–3min on dev machine | ~30s wall on cloud (parallel), $minor compute |
| Full-suite mutation | 30min–2h on dev machine | ~5min wall on cloud (high parallel), $material compute |
| Cooldown semantics | 5min between same-file runs | Cloud rate limit per workspace (server-managed) |

### Failure modes (Phase 2 specific)

| Failure | Mitigation |
|---|---|
| Cloud queue is full / slow | Local fallback. Status surfaced via `interlinked status` (existing command). |
| Workspace not opted in | First trigger returns 403; CLI caches "cloud disabled for workspace" for the session and falls back to local. |
| Source upload risks (sensitive code) | Workspace-level opt-in includes data-residency settings. Source is never persisted server-side beyond the run; mutation reports retain only file paths and line numbers, not source content. |
| Result latency exceeds cooldown window | Cooldown applies per-file based on *job submission*, not result delivery. Avoids re-queueing a job whose result is still in flight. |
| Cloud-reported finding doesn't reproduce locally (different Node version, env, deps) | Recurrence row includes a `runner: "cloud"` discriminator. Local re-run command surfaced in the warning: `Reproduce locally: interlinked mutate --file foo.ts`. |

### Acceptance criteria (Phase 2)

| Criterion | Verification |
|---|---|
| `runner: "cloud"` queues a job and the result eventually lands in `recurrences.jsonl` | End-to-end test against staging server |
| `runner: "auto"` falls back to local when the server is unreachable | Test with cloud endpoint blackholed |
| Cloud-reported findings render identically to local-reported findings (same warning format) | Snapshot test against both shapes |
| `interlinked status` reports cloud-mutation-job count and cooldown for the active workspace | Manual |
| Cloud workspace settings can disable mutation entirely; CLI respects the setting on first trigger and caches the decision | Manual: toggle workspace setting, observe |

## Phase 3 — Cross-session aggregation (deferred)

### Scope

Server-side aggregation of mutation findings *across* sessions, agents, and time. Drives a higher-order signal the local recurrence log can't see: "this file has had surviving mutants every day for two weeks; the test architecture is structurally underspecified."

### Surface

- Server endpoint: `GET /api/mutate/trends?file=...&window=14d` returns per-file historical surviving-mutant counts.
- CLI command: `interlinked mutate trends [--file PATH]` queries the endpoint, prints a sparkline.
- Harness UserPromptSubmit injection (Phase 3 enhancement): files in the worst trend bucket get a stronger `additionalContext` line — "this file is in the worst-trend mutation bucket; consider a test-architecture rewrite, not just patch tests."

### Why deferred

Phase 3 is pure observability — it surfaces patterns the agent could in principle ignore safely. Phases 1 and 2 already drive *action* (kill these specific mutants). Build the action loop first, prove it works, then layer trend analysis on top.

### Trigger conditions for unlocking Phase 3

- Phase 1 has been dogfooded for ≥2 weeks with stable FP rate.
- Phase 2 is stable and at least one cloud-driven mutation run lands per workspace per day.
- A clear use case beyond "would be nice to see trends" — e.g., the user asks "which files keep regressing?" and we don't have an answer.

## Cross-cutting concerns

### Determinism boundaries

Per `feedback_harness_deterministic_only.md`: the harness pipeline must remain deterministic. Mutation testing itself is deterministic (same code + same tests + same mutator config = same surviving mutants). The *triggering* and *consumption* are deterministic. The *reporting* is deterministic. No LLM-as-judge anywhere in this plan.

The one heuristic edge: deciding whether a surviving mutant means "test this assertion better" or "the mutant is equivalent and unfixable." That decision today is user-driven via Stryker config / annotations. Phase 3 may add a server-side LLM classifier (`project_classifier_inference.md` / `project_llm_policy_enforcement.md` ties in here) but only as an *escalation layer*, never as a replacement for the deterministic surviving-mutant signal.

### Recurrence shape consistency

Phase 1 and Phase 2 must write *identical* recurrence rows. The only differing field is `runner: "local" | "cloud"`. Anything else (file, line, mutator, original, mutated, killing_tests) is canonical.

This is enforced by routing both paths through `recordMutationSurviving(finding: MutationFinding)` in `recurrence.ts` — neither phase writes to `recurrences.jsonl` directly.

### Restart + reinstall convention

After landing each phase, run `npm run build && reinstall && interlinked harness restart` per `feedback_live_demo_after_edit.md`. The hook script is self-contained, but the harness server needs the new dispatcher.

## Build order

1. **Wire the consumption surface against fixtures.** Hand-write `recurrences.jsonl` rows with `kind: "mutation_surviving"`, prove the PostToolUse warning and UserPromptSubmit injection both fire correctly. Validate the format with a real edit. *Do this before writing any runner code* — if the surface doesn't work, no amount of runner sophistication helps.
2. **Phase 1: Stryker adapter + local trigger.** TS/JS only. Default cooldown 5 min. Default scope: changed files since merge-base.
3. **Phase 1.b: mutmut + cargo-mutants adapters.** Behind language detection. Each ships independently.
4. **Phase 1 dogfooding.** Two weeks on this CLI itself. Tune cooldown, FP threshold, security-domain prioritization.
5. **Phase 2: cloud queue + result subscription.** Server work tracked in the sibling repo (`reference_sibling_server_repo.md`). CLI side is just `api-client.ts` additions and a runner branch.
6. **Phase 2 dogfooding.** Validate result identity (cloud row == local row for the same input). Validate fallback paths.
7. **Phase 3: trends.** Only if a clear demand surfaces during Phase 2 dogfooding.

## Out of scope

- Replacing coverage or assertion density with mutation testing. They're complementary; mutation is more expensive and runs less often.
- Per-mutant cost optimization (which mutators to skip on which lines). Stryker's defaults are fine for v1.
- Mutation testing for non-test code (e.g., mutating the test runner itself). Out of theory's bounds.
- A web UI for surviving-mutant browsing. The CLI / hook surface is the contract; UIs come from the server side, separate plan.
- Mutation-driven test generation (auto-write a test that kills a mutant). That's an LLM-driven loop and explicitly violates `feedback_harness_deterministic_only.md` for the harness pipeline. Could live as a separate `interlinked suggest-test` agent action, but is not part of mutation testing per se.

## Dependencies on other plans

- **Hard dep on `09-local-runtime-quality-hooks.md`** — the recurrence-driven warning surface and the PostToolUse fan-out integration model are established there. Don't ship this plan until 09 has dogfood validation.
- **Soft dep on `08-hook-server-protocol-mismatch.md`** — Phase 1's PostToolUse warnings ship fine without it (stderr path works), but the UserPromptSubmit `additionalContext` injection requires the framed-RPC path to actually deliver decisions to the agent. Without 08, the highest-leverage surface in this plan is silently broken.
- **Soft dep on `07-supermodel-graph-integration.md`** — orthogonal but worth crossing: when the supermodel graph reports HIGH blast-radius for a file *and* mutation testing reports surviving mutants, the combined signal is much stronger than either alone. Phase 3 trends could surface this conjunction.
