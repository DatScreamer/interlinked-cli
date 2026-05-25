# Incremental Synchronous PostToolUse — Content-Hash Caching, Scope-Limited Tool Wrappers, and Edit-Burst Dedup

**Status:** Design / not yet implementation. Sixth in the harness extensions series (A escalation rules, B refactor verbs, C ratchet/quota, D BoN executor, E test-file-only checks, **F this doc**). G (per-commit async impl-aware review for techniques that fundamentally need runtime) deferred to a separate document.

**Origin.** Observed wall-clock for PostToolUse on this codebase, session of 2026-05-11, is **14–45s per Edit** (data from the live session, with the harness reporting via the hook context channel — e.g. `✓ 106 guard rules, software-version-regression, freshness-sensitive-reference — all clean (19846ms)` … `(43787ms)` … `(44989ms)`). Across a session of dozens of Edits this is the dominant per-action cost. The user has explicitly ruled out moving these warnings to an async/next-turn channel — they're load-bearing per-turn feedback for the agent. The remaining lever is **incrementality**: make the synchronous sweep cheaper by reusing prior work.

**Audience.** Engineers working in `src/harness/quality-checks.ts`, `src/harness/quality-checks/`, `src/harness/check-engine/`, and `src/harness/server.ts` PostToolUse dispatch (around line 1569+).

**Constraint.** PostToolUse stays synchronous. Warnings still reach the agent on the same hook response that issued the edit. No latency hides behind delayed delivery; speedups come from doing less work, not from rescheduling it.

**Related.** `runtime-pipeline-staging.md` — the staged pipeline's Stage 3 (local expensive deterministic, 1–15s) is what this doc optimizes; the incremental approach is the latency lever within Stage 3.

---

## TL;DR

Three additions, ordered by leverage:

1. **Content-hash result cache.** Cache key = `(check_id, file_content_sha256[, options_hash])` → `Finding[] | "clean"`. Lookups are µs; hits replace whole check invocations. For multi-edit sessions where most files are touched once and then untouched again, hit rate is high.
2. **Scope-limited tool wrappers.** `gitleaks`, `secrets_in_source`, `software-version-regression`, and `freshness-sensitive-reference` currently scan beyond the diff in ways that don't pay for themselves on per-edit synchronous calls. Scope each to the smallest correct slice (current file content, or diff hunk) and run the broader scan on a different cadence (push gate, `interlinked verify`, or nightly).
3. **Edit-burst dedup.** When the agent fires N edits within a short window (commonly observed: 5–15 edits in <2s for a multi-file write), the daemon today runs the same project-wide and dirty-set sweeps N times. Coalesce by short-circuiting: if check X just ran with this exact (file, content_hash) result, return cached.

Combined, the expected per-Edit wall-clock drops from 14–45s to a tight tail near the inline-check floor (~1–3s for a typical edit), with cold-start edits unchanged.

The three additions compose; each makes the next cheaper. None require changing the agent-visible contract — warnings still arrive on the same hook response, in the same format, with the same determinism tags.

---

## 1. What's already in place

This proposal builds on substantial perf infrastructure that already shipped. The doc would be wrong to ignore it.

| Module | What it does | What it doesn't do |
|---|---|---|
| `quality-checks/project-wide.ts::ProjectWideSweepState` | Debounces project-wide tsc/biome sweeps to fire every N edits (`edit_interval`). Tracks `checkedFiles` and `reportedFindings` to dedup per-file vs. project-wide. | Doesn't cache per-file check results across edits — same file edited twice re-runs all per-file checks. |
| `quality-checks.runProjectWideChecksAsync` (commit `cccdf85`) | Async variant of the project-wide sweep so the 30s tsc run yields the event loop between phases, letting concurrent PostToolUse connections be serviced. | Doesn't reduce the work itself; reduces blocking only. |
| `check-engine/pool.ts::createLimiter` | Bounded concurrency for tool subprocesses, avoids oversubscribing CPUs. | Independent perf lever; doesn't cache results. |
| `file-priority.ts` (commit `6534ae3`) | Tiers files hot/warm/cold by git age; advisory checks only run on hot+warm. | Operates on *file selection*, not per-check caching. Cold files skip advisory; hot/warm still run everything. |
| `check-pipeline/verify-pass.ts` (commit `12ff2c7`) | Two-pass re-verification — candidate findings flow through registered FP filters. | Reduces noise, not work — the candidate detection still ran. |
| `quality-checks.ts::getAfterRefs` memoization (commit `097e278`) | Per-edit memoization of software-version regex sweep; second check on same edit reuses first check's output. | Per-edit only; second edit re-sweeps. |
| `project-typecheck-gate.ts` | Whole-project tsc on `git commit` / `git push` only, not per edit. | This is the right shape — project-wide checks should run at commit boundaries, not per edit. |

The architecture already separates per-edit (cheap-by-design) from project-wide (debounced or gate-only). The remaining per-edit cost is **dense inline checks + per-edit-fired tool wrappers + occasional project-wide sweep when the interval lands**.

---

## 2. The remaining cost shape

Based on the user's session timings and the call paths in `evaluator/post-tool.ts` and `quality-checks.ts`:

| Component | Per-edit cost (estimated) | Variability source |
|---|---|---|
| 100+ inline checks via `check-registry` family files | 1–4s aggregate | File size; regex backtracking on adversarial input |
| Per-file tool wrappers (lockfile, package-json, version-regression, freshness, structural quick-checks) | 2–8s aggregate | Which checks the file activates by language + content shape |
| `gitleaks` / `secrets_in_source` when fired | 3–10s when running | History size when in history-scan mode; diff size when in diff-scan mode |
| Project-wide sweep (tsc/biome) when `edit_interval` is reached | 10–30s when fired | Project size + warm tsc cache |
| Structural checks (project graph queries) | 0.5–2s | Graph size + cache state |
| Inline language checks (per-language adapters) | 0.5–2s | Language pipeline cold-start |

The **variability** (14s → 45s for "the same shape of edit") is most likely the project-wide sweep landing on every Nth edit. The **baseline** (~14s when no sweep) is the dense per-file work.

That tells us where the leverage is:
- **Content-hash cache** attacks the dense per-file work (#1). On the second edit of the same file, results that depend only on content are reusable.
- **Scope-limited tool wrappers** attack the tool-wrapper costs (#2, #3). gitleaks scanning git history is unbounded; gitleaks scanning the current file content is bounded.
- **Edit-burst dedup** attacks the repeated structural-check and project-graph costs (#5, #6) when edits arrive in quick succession.

---

## 3. Addition #1: Content-hash result cache

### 3.1 What it caches

Every check whose output is **a pure function of its inputs** is cacheable. Inputs are typically:
- `file_content` (the post-edit content the check sees)
- `file_path` (path-based exemptions / language detection)
- `check_options` (config knobs: severity, threshold, etc.)

For checks that *also* depend on project state (cycles, dead exports, project-graph queries), the cache key extends to include a project-graph version stamp — invalidated on any edit that mutates the graph.

```typescript
interface CheckResultCacheKey {
  check_id: string;
  file_content_hash: string;   // SHA-256 of post-edit content
  file_path: string;            // For path-based exemption awareness
  options_hash: string;         // SHA-256 of normalized options JSON
  graph_version?: number;       // Only set for graph-dependent checks
}

interface CheckResultCacheEntry {
  result: QualityCheckResult[] | "clean";
  computed_at_ms: number;
  cost_ms: number;              // For profiling and TTL decisions
}
```

### 3.2 Storage

In-memory, in the daemon. Daemon is already long-lived (the harness server stays up across sessions per `harness start`). LRU eviction at a configurable size (default 10,000 entries = ~50MB at typical entry sizes).

No disk spill in Phase 1 — keep it simple. If miss rate is dominated by daemon restarts, Phase 2 adds disk spill to `.interlinked/check-cache/`.

### 3.3 Cache invalidation

For content-only-dependent checks: no invalidation needed. The content hash *is* the validity proof.

For graph-dependent checks: bump `graph_version` whenever an edit changes the project graph (new export, removed import, etc.). The `project-graph.ts` module already maintains the graph; expose a monotonic version counter from it.

For "config changed" cases: rebuild keys at daemon-startup time from the loaded config. Config changes between sessions effectively flush the cache.

### 3.4 Which checks opt in

Not every check is cacheable. The registry needs an explicit declaration:

```typescript
interface CheckRegistration {
  // ... existing fields ...
  cacheable: 
    | "content_only"    // Pure function of (content, path, options)
    | "graph_aware"     // Above + project-graph version
    | "never";          // Stateful or time-dependent (e.g., a check that uses `Date.now()`)
}
```

Almost all inline checks are `content_only`. Structural checks are `graph_aware`. Tool wrappers that scan history (gitleaks) are `never` and need Addition #2 instead.

### 3.5 Files

| File | Purpose |
|---|---|
| `src/harness/check-cache/types.ts` | Cache key, entry, statistics types |
| `src/harness/check-cache/store.ts` | LRU store implementation |
| `src/harness/check-cache/integration.ts` | Wrapper for the check dispatcher in `quality-checks.ts` |
| `src/harness/check-cache/__tests__/` | Hit/miss/invalidation semantics |

The check dispatcher in `quality-checks.ts` (around lines 400–500 in the per-check `name === "X"` branches) calls into the cache before invoking each check; on hit, returns the cached findings; on miss, runs the check and stores.

### 3.6 Expected hit rate

Two regimes:
- **Inner loop on a hot file:** the agent edits `foo.ts`, gets warnings, edits again. Same file, different content → every cacheable check is a miss for the new content, but still a miss only once per content state.
- **Multi-file edit:** the agent touches `foo.ts`, then `bar.ts`. Checks on `foo.ts` and `bar.ts` are independent — but if the next edit is back to `foo.ts` with content the cache has seen, full hit on `foo.ts` checks.

Estimated hit rate for a typical 30-edit session on this repo: 35–55% (cold cache → warm → revisits → multi-edit-same-file patterns). Not 90%+ because the harness check work is inherently per-edit-content. But 40% off 14s = 5.6s saved per edit on average, compounding across the session.

### 3.7 Failure modes

- **Cache poisoning:** a check that reads global state (e.g., a file outside the input set) is incorrectly marked `content_only`. Defense: any check that reads files via the harness's standard helpers should be wrapped to assert it doesn't escape the declared input set in tests.
- **Hash collisions:** SHA-256 makes this irrelevant in practice.
- **Stale graph_version:** the bump is missed when the project graph changes. Defense: project-graph mutations go through one chokepoint that bumps the counter; assertion test ensures all graph-mutating paths reach it.
- **Memory growth:** unbounded if LRU is misconfigured. Defense: hard cap with monotone-decrease guarantee in the LRU implementation.

---

## 4. Addition #2: Scope-limited tool wrappers

### 4.1 The four offenders

These tool wrappers currently do work beyond what's needed for per-edit feedback:

| Wrapper | Today | Scope-limited target | Where the broader scan moves |
|---|---|---|---|
| `gitleaks` | Scans git history on each invocation | Scan staged diff + working-tree changes only via `gitleaks protect` or `gitleaks detect --no-git --source <edited-file>` | Push gate runs `gitleaks detect` on the new commits' diff; nightly job (optional) runs full history. |
| `secrets_in_source` (inline) | Scans the full file content | Scan only the post-edit diff hunk (already known from the Edit's `old_string`/`new_string`) | Periodic full-file re-scan on `interlinked verify` |
| `software-version-regression` | Scans full file pre and post via regex (already memoized within one edit per commit `097e278`) | Scans diff hunk only; falls back to full-file scan only when prior state isn't cached | Full-file scan continues on `interlinked verify` |
| `freshness-sensitive-reference` | Full-file regex sweep | Same — diff hunk only on edit | Same |

### 4.2 Correctness considerations

The reason these run broader scans today is correctness: a regression check needs to compare *before* state to *after* state. If `old_string` isn't available (e.g., new file Write), there's no before state and the diff hunk doesn't exist; full-file scan is the fallback.

The reframe: **prefer diff-hunk scope when both ends of the diff are knowable; full-file scope when not**. The Edit tool provides `old_string` + `new_string` directly; the daemon already captures these per `evaluator/post-tool.ts` and the `PreEditBaseline` type. Wire these into the scope decision.

For Write (new file) and MultiEdit (multiple hunks) cases: full-file scope on a new file is bounded by the file size; on a new file with no prior version, no regression check needed anyway (it's all "new" — gate via the secrets/version check on the new content alone).

### 4.3 What stays on the broader cadence

Some scans genuinely need the broader scope and shouldn't be scope-limited away — they should move to a cadence that pays for itself:

- **`gitleaks` full history.** Catches secrets that were committed before this session started. The right cadence: `interlinked verify` (developer-invoked) and the push gate. Not per-edit.
- **`software-version-regression` across the whole project.** Catches drift between files (e.g., a version pinned in two configs that fell out of sync). Right cadence: `interlinked verify` and the periodic project-wide sweep that already runs every `edit_interval` edits.
- **Cross-file `freshness-sensitive-reference`.** Same — project-wide sweep, not per edit.

Per-edit cost shifts to: "did *this edit* introduce a secret / version regression / freshness issue?" That's a bounded question.

### 4.4 Files

| File | Purpose |
|---|---|
| `src/harness/quality-checks/secret-detection.ts` (existing) | Add `containsSecretsInDiff(oldString, newString, filePath)` alongside existing `containsSecrets(content, filePath)` |
| `src/harness/quality-checks/software-version-regression.ts` (existing) | Add diff-hunk-only variants of `detectSoftwareVersionRegressions` and `freshness-sensitive-reference` |
| `src/harness/quality-checks/gitleaks-scope.ts` (new) | Scope decision + invocation; per-edit calls use `--no-git --source <file>` mode |
| Migration in `quality-checks.ts` dispatcher | Each `name === "X"` branch picks the diff-hunk variant when `event.tool_input.old_string` is present |

### 4.5 Failure modes

- **Diff hunk doesn't capture the regression:** an edit changes one part of a file that has implications for an unedited part. Defense: the project-wide sweep still catches these on its cadence; per-edit is just for "did this edit add a new instance."
- **`MultiEdit` hunks interact:** multiple hunks in one Edit could combine in ways diff-hunk-only checks miss. Defense: aggregate the union of new content from all hunks for the per-edit scope; project-wide catches the rest.
- **Write creates a new file with pre-existing secrets in its body:** scope-limited check still catches this (whole new file is "new content").

---

## 5. Addition #3: Edit-burst dedup

### 5.1 The pattern

In sessions, edits commonly arrive in bursts — the agent issues 5–15 tool calls back-to-back, each a Write/Edit/MultiEdit. Today every burst-member fires the full per-edit pipeline. If they all land within ~2s, much of the work duplicates: structural checks query the same graph state, project-graph cache misses get repaired once per edit instead of once per burst, file-priority lookups repeat.

### 5.2 The mechanism

The harness daemon already has session-scoped state (`session-state.ts`). Add a per-session burst window:

```typescript
interface EditBurstState {
  burst_started_at_ms: number;
  edits_in_burst: number;
  file_results_this_burst: Map<string, BurstFileResult>;   // file → cached check results
  graph_version_at_burst_start: number;
}
```

A burst is "edits within W ms (default 2000) of the most recent edit." Within a burst:
- File-level check results are cached *for the burst* in `file_results_this_burst`.
- Project-graph queries reuse the `graph_version_at_burst_start` snapshot unless an edit explicitly mutates the graph (in which case the burst ends and a new one begins).
- The project-wide sweep counter increments but doesn't fire mid-burst — fires once at burst end if `edit_interval` was crossed.

### 5.3 Correctness

The user sees the same warnings whether burst dedup is on or off — every edit gets its own response, every response contains the right warnings for *that edit's content*. Dedup only avoids re-running checks that would produce the same result.

The case that *needs* care: edit 1 introduces a finding, edit 2 in the same burst removes it. With naive dedup, edit 2's response could contain the stale finding from edit 1. Defense: dedup is keyed on content hash *after* the edit, not before. Edit 2's content hash is different from edit 1's, so the cache check looks up the new key and (re-)runs the check.

In other words, burst dedup is mostly a special-case of the content-hash cache (#1) that takes effect inside a single session — its independent contribution is fast lookups for the project-graph and the file-priority map.

### 5.4 Files

| File | Purpose |
|---|---|
| `src/harness/session-state.ts` (existing, extend) | Add `EditBurstState` to per-session state |
| `src/harness/check-cache/burst.ts` (new) | Burst lifecycle, graph-version pinning |
| `src/harness/server.ts` PostToolUse dispatch (around line 2155) | Wire burst state into the dispatcher |

### 5.5 Failure modes

- **Burst window too long, agent waits on stale data:** the agent always gets fresh data because per-edit responses are still synchronous. Burst dedup speeds up checks; it doesn't delay responses.
- **Burst lifecycle leaks state across sessions:** session-state is per-session-id; new session = new state.
- **Long pauses inside a "burst":** if W is too short, dedup doesn't fire; if W is too long, finer-grained changes (like another agent edit between two same-session edits) might be missed. Defense: W is bounded (2s default); any edit ends the burst-window timer; consecutive edits restart it.

---

## 6. Profiling and visibility

Bundle with the three additions a **per-check timing log**. Right now the user has to *infer* what's slow from check names in the harness's success line. Better: the daemon logs per-check `cost_ms` to `.interlinked/check-profile.jsonl` (gitignored), and `interlinked harness profile` summarizes:

```
$ interlinked harness profile --last-session
Total PostToolUse events: 38
Mean per-event cost: 11.4s (down from 22.8s baseline)
Cache hit rate: 47% (content cache), 12% (burst dedup)

Top contributors (mean ms per event):
  software_version_regression  4123ms  (cacheable: content_only, hit rate 18%)
  gitleaks                     2455ms  (scope: diff-only, fallback to history off)
  structural.layer_violation    1203ms  (cacheable: graph_aware, hit rate 71%)
  ...
```

This makes future perf work measurement-driven instead of inference-driven. Cheap to add; lights up the impact of the three additions.

---

## 7. Phased rollout

| Phase | Deliverable | Gate to next |
|---|---|---|
| 1 | Per-check timing log + `interlinked harness profile` | Used for ≥1 week to baseline current cost per check |
| 2 | Content-hash cache infrastructure (#1) + opt-in for ~20 cheapest inline checks | Hit rate ≥30% on profile data, no correctness regressions in test suite |
| 3 | Cache opt-in for the rest of `content_only` inline checks + `graph_aware` structural checks | Hit rate ≥40% aggregate |
| 4 | Scope-limited tool wrappers (#2): secret-detection diff-only, then version/freshness, then gitleaks | Each tool wrapper's per-edit cost drops ≥50%; whole-project scan moves to verify+push correctly |
| 5 | Edit-burst dedup (#3) | Cache hit rate within a burst ≥80% on structural checks |
| 6 | Disk spill for the cache (optional, if cold-start cost is meaningful) | Cold session's first few edits show measured warm-up time benefit |

Phase 1 is non-negotiable first — without timing data, every subsequent phase is guessing. The phase ordering reflects expected value-per-effort: cache infrastructure pays off broadly across many checks; tool-wrapper scope changes pay off concentrated on a few expensive checks; burst dedup is the smallest marginal addition.

---

## 8. Open questions

1. **Cache key for checks that read multiple files.** Some structural checks read N files transitively. Cache key needs all their content hashes — manageable but a per-check decision. Phase 2 will surface which checks fit which shape.
2. **Project-graph version bump granularity.** Coarse-grain (any graph change bumps) is correct but invalidates more than needed. Fine-grain (bump per affected subgraph) is more efficient but more complex. Start coarse; refine if profile data shows graph_aware cache hit rate is low.
3. **Cache size auto-tune.** 10,000 entries is a guess. Should the cache size scale with project size? Phase 1's profile data will inform this.
4. **What about Read tool PostToolUse?** Read events also fire PostToolUse handlers (file reminders, etc.). Most are cheap; verify nothing heavy hides there. If there is, same caching pattern applies — but lower priority.
5. **Disk spill correctness across daemon restarts.** A daemon restart between two same-content edits should re-hit the cache from disk. Means cache entries need to survive process death. Phase 6 only.
6. **Interaction with the existing `editsSinceLastSweep` counter.** Burst dedup must not skip the increment — otherwise the project-wide sweep never fires. The counter increments per-edit regardless of burst membership; only the sweep firing is deferred to burst-end.
7. **MultiEdit semantics for diff-hunk scope.** MultiEdit is N hunks; each hunk has its own `old_string`/`new_string`. Scope decision: union of all `new_string`s, or per-hunk? Per-hunk is correct but means N invocations; union is one invocation with potentially less precise reporting. Default to union; let scoped-check authors override.

---

## 9. Failure modes (system-level)

- **A buggy `cacheable` declaration produces wrong findings.** Defense: cache-correctness tests for every check that opts in — same content + path + options → same findings, always, including across separate daemon runs.
- **The cache hits a content hash for a different check than intended.** Defense: hash includes check_id explicitly.
- **Profile log grows unbounded.** Defense: rotation at 10MB; `.interlinked/check-profile.jsonl` is gitignored.
- **A user thinks they're getting fast warnings but the cache is masking a real change.** Mitigation: `interlinked harness profile --raw` shows uncached cost when needed; cache entries carry `computed_at_ms` so users can see freshness.

---

## 10. Composition with the larger system

| Doc | Relationship |
|---|---|
| A (escalation rules) | Escalation eval runs on the *result set* — the cache makes the result set cheaper to produce, no semantic change. |
| C (ratchet/quota) | Ratchet evaluation reads check counts; cached check results feed identical counts. |
| E (test-file-only checks) | Most test-file-only checks are `content_only` and cache cleanly. Big win for tests that run alongside impl edits in a burst. |
| Two-pass verify (`check-pipeline/verify-pass.ts`) | Verify passes run on candidate findings; results before-vs-after verify are both cacheable independently. |
| File-priority tiering (`file-priority.ts`) | Cold files still skip advisory checks at the selection layer; this doc's cache covers what *did* run after selection. Independent levers, additive. |
| `project-typecheck-gate.ts` | The push gate is already off the per-edit hot path; this doc doesn't touch it. |
| G (per-commit async impl-aware review, deferred) | G handles techniques that can't fit a sync budget at all (mutation testing of impl, behavioral coverage). This doc handles the sync budget itself; G handles what falls outside it. |

The system-level effect: today's 14–45s per-edit drops to a measured-and-tuned profile where each component has a known cost and an explicit cache strategy. The user sees the same warnings, on the same hook response, in the same format — just sooner.
