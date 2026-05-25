# Decision-Surface Metric

**Status:** Detector + map landed (`src/harness/quality-checks/decision-surface.ts`, `decision-surface-map.ts`, 47 unit tests). This doc covers the deferred questions about *how* the metric surfaces and *whether* it ratchets.

**Origin.** Hodnett, "The Opinionated Stack" (adaas.dev, 2026-05-10) argues that an autonomous-coding platform's effective intelligence is inversely proportional to its decision surface — the number of "library A vs library B" forks the agent has to navigate. The harness's job is to narrow the agent's decision surface. The first observable form of that is *counting* the surface a repo already exposes.

**Audience.** Engineers extending `src/harness/quality-checks/` and `src/commands/verify/`.

**Constraint.** Descriptive, not prescriptive. The metric reports what the repo chose; it does not declare any tool correct or any choice wrong. The harness has no authority to dictate a customer's stack — only to surface what's there, deterministically (per `feedback_harness_deterministic_only.md`).

**Related.** `runtime-pipeline-staging.md` — the decision-surface metric is one of the Stage 3 inline checks in the staged pipeline; its ratchet variant would feed into the per-edit confidence-delta accumulation.

---

## TL;DR

`detectDecisionSurface(projectRoot)` returns a per-category set of distinct canonical tool names (`vitest`, `biome`, `npm`, etc.) plus a `totalSurface` integer. Seven categories: `package_manager`, `test_framework`, `linter`, `formatter`, `bundler`, `http_client`, `date_lib`. Pure function over the project tree, no agent in the loop.

Three open questions:

1. **Ratchet semantics** — per-edit (matches existing `as any` style, noisy on a refactor that adds-then-removes) vs per-PR / per-baseline (cleaner, requires git context). Recommend: **per-baseline**, similar to the existing per-file ratchets but scoped to the repo, refreshed on `interlinked verify` against `git merge-base HEAD origin/main`.
2. **Lockfile multiplicity** — when a repo has both `package-lock.json` and `pnpm-lock.yaml`, the right output is not "decision surface = 2" but "this repo is in a broken state." Recommend: surface this as a **distinct hard signal** (warning, not metric), separate from the soft count.
3. **Import scanning** — `fetch` is native, so a repo with no declared http_client is *not* a repo with zero http clients. Should the detector scan import statements? Recommend: **no, not yet**. Imports are noisy (test files import `node-fetch` for mocking, etc.) and the deps-only signal is already actionable. Revisit if we see false-negatives in the wild.

Anti-goals (explicit):

- No "we picked X, you should pick Y" defaults. Map names are listed because they compete with each other, not because we prefer any of them.
- No template emission. `interlinked init --opinionated` was rejected upstream.
- No automatic enforcement / blocking. The metric reports; it does not block edits.
- No Deno-Svelte-CF or any other stack assumptions baked into the seed map. The seed covers npm-ecosystem alternatives uniformly.

---

## 1. What the detector measures today

Seven categories; see `decision-surface-map.ts` for the canonical list and `decision-surface.ts` for the detector. Sources scanned:

| Source | What it tells us |
|--------|------------------|
| `package.json` deps/devDeps/peerDeps/optionalDeps | Which declared packages occupy a category |
| Top-level lockfile presence | Which package manager(s) the repo uses |
| Top-level config files (`vitest.config.*`, `biome.json`, `eslint.config.*`, etc.) | Which tool a config file commits to |

Each signal contributes a canonical tool name (`@biomejs/biome` and `biome.json` both contribute `"biome"`). Per-category sets dedup naturally. Output arrays sorted for deterministic comparison.

**What is intentionally not scanned:**

- Import statements in source files. See §3.
- Subdirectory config files. A `vitest.config.ts` inside `packages/app/` doesn't change the project's surface — the workspace orchestrator pulls it in. The top-level config is the surface declaration.
- `packageManager` field in `package.json`. Lockfile presence is the authoritative signal; the field is a hint that's frequently stale.

---

## 2. Ratchet semantics

The existing ratchets (`as_any_ratchet`, `non_null_assertion_ratchet`, `suppression_ratchet`, etc.) are **per-file, per-edit**: each PostToolUse compares the post-edit count against a pre-edit baseline captured before the write. Adding `as any` and removing it in the next edit doesn't trip the ratchet because each turn re-baselines.

A decision-surface ratchet can't use that shape directly:

- The metric is project-scoped, not file-scoped. A `vitest`-to-`jest` migration touches many files; per-edit re-baselining would lose the "the repo introduced jest" signal.
- The natural unit of "a new tool was introduced" is a PR or a feature branch, not a single edit.

### 2.1 Recommended: baseline-against-merge-base

```
baseline_surface  = detectDecisionSurface(<file tree as of git merge-base HEAD origin/main>)
current_surface   = detectDecisionSurface(<working tree>)
delta             = current_surface − baseline_surface  // per category
```

Fire a warning when delta > 0 in any category. Message names which dimension grew:

> [heuristic] decision_surface_growth — test_framework expanded from {vitest} to {vitest, jest} on this branch. If this is intentional (migration), suppress with `// interlinked-disable decision_surface_growth:test_framework`. If not, the codebase now requires the agent to pick between two test runners on every test-related edit.

### 2.2 Where the baseline lives

Two options:

| Option | Pro | Con |
|--------|-----|-----|
| Compute on demand from git | No state file to keep in sync | Requires git, expensive on large trees |
| Cache in `.interlinked/decision-surface-baseline.json`, refreshed on `git fetch` / explicit `interlinked verify --refresh-baseline` | Fast | Drift if the cache is stale |

Recommend the compute-on-demand path, gated behind a worktree check. The detector is fast (<5ms on a typical repo); the cost is reading the merge-base tree, not the categorization. The existing `ratchet-metrics.ts` baseline already pays this cost per file via `git show`.

### 2.3 When the ratchet does NOT fire

Honest carve-outs are non-negotiable for adoption:

- **Migration markers.** A commit message or branch name containing `migrate:` / `migration/` / `MIGRATE-*` suppresses the ratchet for that branch. The migration is itself the reason the surface temporarily widens.
- **Inline suppression.** `// interlinked-disable decision_surface_growth` in any source file or a top-level `.interlinked/decision-surface.suppress` skips the warning for one verify run.
- **Stack-removal direction.** `delta < 0` is silent (good) and never reported as a positive event. Resist the urge to gamify reduction.

---

## 3. Imports as a signal — deferred

The user-facing motivation for a `http_client` category is that an agent might reach for `axios` in a codebase that already uses native `fetch`. The current detector misses this case: a repo with zero http clients in `package.json` could be 100% `fetch`-based or 100% no-network. The signal is incomplete.

Adding imports gets us:

- Detection of native `fetch` usage (as a distinct entry: `"fetch"` in `http_client` if any source file calls `globalThis.fetch` / `Request` / `Response`).
- Detection of `node:http` / `node:https` / `node:fs` flavors elsewhere.

But it also adds:

- **FP risk.** Test files import `node-fetch` to mock; build scripts import `axios` for one-off webhooks. Counting these inflates the surface without reflecting the agent-visible decision space.
- **Cost.** A project-wide import scan is much more expensive than reading `package.json`. The trigram index could accelerate it, but adds complexity for the first iteration of a metric we haven't validated yet.

**Recommendation: defer.** Ship deps-only. Watch real-world output for false-negatives (e.g., agents introducing `axios` in fetch-only codebases). If we see them, add an opt-in import scan in a second pass — likely as a separate `--scan-imports` flag on the detector so users can compare both signals.

If imports do get added, the categorization map already canonicalizes `node-fetch` → `node-fetch` and `fetch` (a hypothetical entry for the global) → `fetch`. So the data plane is forward-compatible.

---

## 4. Lockfile multiplicity — distinct from the metric

A repo with both `package-lock.json` and `pnpm-lock.yaml` is not "high decision surface." It is **broken**: one tool will install one set of resolved versions, the other will install a different set, and the resulting state depends on which tool the next contributor runs. This is a different bug class from "we use both jest and vitest."

Today the detector reports `package_manager: ["npm", "pnpm"]` and contributes 2 to `totalSurface`. That's correct as data — but it buries the urgency.

**Recommendation: emit a distinct warning** when more than one lockfile is present. Severity: warning (not error — there are legitimate transient states during a migration). Message:

> [proven] multiple_lockfiles — found package-lock.json AND pnpm-lock.yaml. Pick one and delete the others, or installs will resolve to different versions depending on which tool runs. (This is a configuration error, not a decision-surface signal.)

This check fires from the same detector pass (same fs traversal) but is reported separately in the verify output. The metric still counts both for `totalSurface` because the count is still descriptively correct.

Implementation note: `LOCKFILE_TO_PACKAGE_MANAGER` in the map already enumerates the candidate lockfiles. The multiplicity check is just `Object.values(byCategory.package_manager).length > 1` plus a single warning emission. Minimal new code.

---

## 5. Surfacing in verify

The existing verify pipeline has three output channels:

- **Streaming** (`src/commands/verify/streaming-output.ts`) — what the user sees in the terminal.
- **JSON** (`src/commands/verify/output-json.ts`) — what CI / scripts consume.
- **Section table** (`src/commands/verify/section-table.ts`) — structured summary.

Recommended placement:

- **JSON**: add a top-level `decision_surface` field with the full `DecisionSurfaceReport`. Always present, even when empty. Stable schema.
- **Streaming**: add an optional `Decision Surface` section, default off (unless `--decision-surface` flag or `--all-checks` is passed). When the ratchet fires, the relevant line surfaces in the existing warnings stream, not in this section.
- **Section table**: a one-row summary `decision_surface | total: 7 | + 0 from baseline`. Cheap, opt-in via `--all-checks`.

Rationale for opt-in in streaming output: the metric is descriptive. A repo with 12 surface entries isn't a bug — it might be a deliberately-wide repo. The user can ask to see it. The ratchet warning ("you grew the surface on this branch") is the actionable signal and fires unconditionally when triggered.

---

## 6. Sequence of follow-on work

In rough order of value-per-line-of-code:

1. **Lockfile multiplicity warning** — single new warning, hooks into the existing detector pass. Half-day. (§4)
2. **Verify JSON wire-up** — add `decision_surface` to the verify JSON output. Half-day. (§5)
3. **Baseline-against-merge-base ratchet** — git read + per-category diff + warning emission. One day, including the carve-outs in §2.3.
4. **Streaming-output section** — opt-in summary block. Quarter-day.
5. **Import-scan opt-in** — only if we see FP-low signal from real repos that the deps-only metric misses. (§3)

Each step is independently shippable. Step 1 is the only one that produces *new* alerting; steps 2–4 surface what the detector already computes. Step 5 is conditional on field signal we don't yet have.

---

## 7. What this metric is NOT

Listed explicitly because the temptation to slide here will be strong:

- **Not a "convention sentinel."** The convention-sentinel idea (block edits that introduce competing tools) requires the harness to take a position on which tool is canonical. The metric does not. If/when a convention sentinel ships, it will be a separate check, opt-in per-repo, with the equivalence map authored by the repo owner — not by us.
- **Not a quality grade.** A repo with `totalSurface: 4` is not "better" than a repo with `totalSurface: 12`. Some domains genuinely need multiple bundlers (a library that ships ESM + CJS + UMD) or multiple http clients (a tool that talks to many incompatible servers). The metric reports; the user judges.
- **Not enforced.** No blocking. No mandatory baseline. The ratchet is a warning that can be silently ignored. The user opts in to caring.

The blog argues for narrowing the customer's decision surface. The harness narrows the *agent's* decision surface — but only as much as the repo owner has narrowed their own first. The metric makes the existing surface visible. That's the whole job.
