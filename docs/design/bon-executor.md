# `interlinked execute` — BoN Executor for Local-Model Edits Beyond Refactor Verbs

**Status:** Design / not yet implementation. Sequenced last in the no-SOTA-assumed harness extensions (D in the A/B/C/D series). Builds on B (refactor verbs) and C (ratchet/quota system).

**Origin.** Refactor verbs (Doc B) handle bounded, contractually-checkable edits. Many real edits don't fit a verb shape: "add JSON validation at the boundary in `src/api/handlers.ts`," "wire the new `MEMORY` binding through the request handler," "convert this synchronous helper to async with proper backpressure." For these, the executor accepts a free-form intent paired with **user-supplied verifiers** — the verifiers are the load-bearing element, not the intent text. Without the verifier discipline, the executor degenerates into a free-form codegen tool with no quality floor; with the verifiers, it's BoN with a tight oracle that the user constructed.

**Audience.** Engineers building `src/commands/execute.ts`. Assumes B (refactor verbs) is in place — D reuses B's model adapter, worktree pool, and BoN loop machinery.

**Constraint.** No SOTA model anywhere. Local non-SOTA model in the loop; human supplies the verifiers; harness checks compose with user verifiers as the verifier set. The executor refuses to run without verifiers (with an explicit `--no-verifiers` opt-out that marks output as unverified).

---

## TL;DR

A new command `interlinked execute` wraps a free-form intent in a BoN loop with an explicit, multi-source verifier set. Verifier sources:

- `--verify "harness:all"` — all harness checks pass (no new warnings)
- `--verify "test:<path>"` — the test file at this path passes
- `--verify "structural:<predicate>"` — `exports-unchanged`, `no-cycles`, etc.
- `--verify "diff:<predicate>"` — `touched-files-only:<glob>`, `max-files:N`, `no-deletions`
- `--verify "ratchet:all"` — no ratchet violations introduced (Doc C)
- `--verify "custom:<script>"` — user script returns exit 0

A candidate is approved iff *every* verifier passes. Strategies: `bon` (parallel sample), `refine` (sequential, feed errors back), `tournament` (pairwise selection). The executor reuses Doc B's model adapter, worktree pool, and contract evaluator.

The verifier-coverage gap (passing verifiers ≠ implementing intent) is acknowledged and *managed* by requiring user-supplied verifiers — the user, not the harness, owns the gap.

---

## 1. Why this command exists

Refactor verbs (Doc B) are the strongly-verifiable subset of edits. They cover ~70% of refactor-flavored work but a much smaller fraction of "implement this small feature" work. Yet small-feature work is exactly where local non-SOTA models could plausibly contribute, *if* the verifier story can be made tight.

The verifier story is the entire bet. Without verifiers, free-form codegen with a non-SOTA model is unreliable in ways the harness can't detect (the harness catches *bug classes*; it doesn't catch *failure to implement the requested feature*). With user-supplied verifiers — most powerfully, a test the user writes first — the local model has a bounded target.

The shape that works:

```
1. Human writes a failing test that captures the intent
2. interlinked execute --intent "..." --verify "test:<path>"
3. Local model BoN until the test passes AND no harness regressions
4. Human reviews the diff
```

This is test-driven development with the test-author-and-reviewer being human and the implementor being a local model. The model produces; the test verifies; the human keeps the keys.

For users unwilling or unable to write tests, the executor can run with weaker verifiers (harness:all, structural:exports-unchanged, diff:touched-files-only). These give a quality floor but not an intent-correctness oracle. The output is marked unverified; the user reviews more carefully.

---

## 2. Architecture

### 2.1 New files

| File | Purpose |
|---|---|
| `src/commands/execute.ts` | CLI entry point |
| `src/harness/executor/loop.ts` | BoN/refine/tournament strategies |
| `src/harness/executor/verifiers/registry.ts` | Verifier vocabulary + parser for `--verify` strings |
| `src/harness/executor/verifiers/{harness,test,structural,diff,ratchet,custom}.ts` | One file per verifier kind |
| `src/harness/executor/intent.ts` | Intent parsing + sanity validation (no shell metachars, length cap) |
| `src/harness/executor/output.ts` | Per-candidate report shapes |
| `src/harness/executor/__tests__/` | Tests |

### 2.2 Reuses

- `src/harness/refactor/model-adapter.ts` (Doc B §4) — same pluggable model adapter
- `src/harness/refactor/loop.ts` worktree pool (Doc B §5.2) — pre-warmed git worktrees
- `src/harness/quality-checks.ts` — for `harness:all` verifier
- `src/harness/structural-checks.ts` — for `structural:*` verifiers
- `src/harness/ratchets/engine.ts` (Doc C §6) — for `ratchet:all` verifier
- `src/harness/recurrence.ts` — failed convergence patterns recorded as `harness_caught` recurrences

### 2.3 Where it sits relative to Docs A/B/C

```
                                +--------------------+
   intent +    +-----------+    | scratch worktree   |
   verifiers ->| executor  |--->| - apply candidate  |---+
   (this doc)  | BoN loop  |    | - run verifiers    |   |
               +-----------+    +--------------------+   |
                    |                                    |
                    | reuses                             |
                    v                                    |
          +-------------------+                          |
          | model adapter (B) |                          |
          | worktree pool (B) |  <----- candidate diffs -+
          | contract eval (B) |
          | ratchet eng. (C)  |
          | escalation (A)    |  <----- post-edit findings
          +-------------------+
```

Verifiers compose primitives the other docs already define. The executor is glue.

---

## 3. Verifier system

### 3.1 Verifier vocabulary

Verifiers are parsed from `--verify "kind:argument"` strings. Six kinds in Phase 1:

| Kind | Argument | Predicate |
|---|---|---|
| `harness:all` | none | All harness checks pass; no new warnings introduced (diff-aware) |
| `harness:strict` | none | `harness:all` plus zero warnings of any severity (including pre-existing) |
| `test:<path>` | test file or directory | `npm test <path>` (or detected per-language equivalent) returns 0 |
| `structural:<predicate>` | `exports-unchanged`, `no-new-cycles`, `no-public-api-removal` | Composes existing structural checks |
| `diff:<predicate>` | `touched-files-only:<glob>`, `max-files:N`, `no-deletions`, `max-lines:N` | Pure diff inspection |
| `ratchet:all` | none | No ratchet violation introduced (delegates to Doc C engine) |
| `ratchet:<id>` | ratchet id | Specific ratchet doesn't regress |
| `custom:<script>` | path to executable | Script run in worktree; exit 0 = pass |

### 3.2 Composition

Multiple `--verify` flags AND together. A candidate must pass *all* verifiers to be approved.

```bash
interlinked execute \
  --intent "Add JSON validation at the boundary in src/api/handlers.ts" \
  --verify "test:src/api/__tests__/handlers.test.ts" \
  --verify "structural:exports-unchanged" \
  --verify "diff:touched-files-only:src/api/**" \
  --verify "diff:max-files:3" \
  --verify "harness:all" \
  --verify "ratchet:all"
```

OR composition is intentionally absent — verifiers are conjunctive only. If you want "pass test A or test B," write a custom script. (Avoiding combinator complexity in the surface.)

### 3.3 The `custom` verifier

The escape hatch for verifiers the vocabulary doesn't cover. Constraints:

- Script path must be inside the repo (no `/usr/local/bin/...`)
- Script runs in the candidate worktree as cwd
- Script gets two env vars: `INTERLINKED_DIFF` (path to unified diff) and `INTERLINKED_INTENT` (the intent string)
- 30-second wall-clock cap; cap exceeded = fail
- stdout captured for the report; stderr captured for failure detail

The `custom` verifier is the principled extension point — if a class of verifier is needed often enough, it gets promoted into the vocabulary in a future phase.

### 3.4 Why no LLM verifier

Tempting to add `--verify "llm:does-this-implement-the-intent"`. Explicitly out of scope by the no-SOTA constraint. The whole point of D is to make BoN work *without* an LLM grader. An LLM verifier would close the verifier coverage gap (§6) but defeat the design's reason to exist.

If a future phase relaxes the constraint, the LLM verifier is a clean extension — same composition shape, just another `kind`.

### 3.5 Refusal without verifiers

By default, `interlinked execute` with zero `--verify` flags refuses to run:

```
$ interlinked execute --intent "make it faster"
Error: no verifiers specified.
       Pass --verify "harness:all" at minimum, or --no-verifiers to opt out
       (output will be marked UNVERIFIED).
```

`--no-verifiers` flips the output's `verified: false` flag and prints a banner. The recurrence log records `verified: false` invocations separately so unverified usage is auditable.

---

## 4. Strategies

### 4.1 `bon` (default)

Generate N candidates in parallel, verify each, return highest-scoring. Reuses Doc B's loop and worktree pool. Score is count of passing verifiers (ties broken by smaller diff, then earlier candidate index).

```
GenerateAndVerify(intent, verifiers, n):
  candidates = parallel-generate(n)
  for c in candidates:
    apply(c, worktree)
    c.results = run all verifiers
    c.score = count(c.results.passing)
  return candidates.maxBy(score)
```

Default `n` is 10. Capped at 50 (can be overridden with `--n` up to a hard ceiling of 200 to prevent runaway cost on paid model adapters — though Phase 1 only ships local).

### 4.2 `refine`

Sequential: generate, verify, on failure feed the failing verifier output back to the model, regenerate. Retry up to N attempts.

```
Refine(intent, verifiers, n):
  prior = []
  for i in 1..n:
    c = adapter.generate({ intent, prior_attempts: prior })
    apply(c, worktree)
    results = run all verifiers
    if all passing: return c
    prior.append({ candidate: c, failures: results.failing })
  return best-of-prior
```

Refine is more sample-efficient when the model can act on feedback (later samples should be better than earlier ones). Less effective for weak models that can't learn from per-attempt feedback within a single session — for those, `bon` parallel sampling dominates.

The model gets the failing verifier names and any failure detail (e.g., "test X failed with: expected 200, got 500"). It does *not* get the verifier source code or the harness internals — that's enough leakage for the model to game the verifier rather than fix the code.

### 4.3 `tournament`

Pairwise: generate N, run `min(N, K)` rounds where each round eliminates the lower-scoring half. Useful when verifiers are expensive (e.g., `test:` runs slow) and you want to avoid running all N candidates through all verifiers.

Order verifiers by cost (cheap first); eliminate candidates as they fail. The cheapest verifier (usually `diff:*`) runs on all N; only survivors run the next; the most expensive (usually `test:*`) runs on a small final set.

Default off. Opt-in via `--strategy tournament` when verifier latency is the bottleneck.

---

## 5. Cost and budget controls

| Flag | Default | Meaning |
|---|---|---|
| `--n N` | 10 | BoN sample count (or refine attempts, or tournament starting pool) |
| `--parallel K` | min(N, max(2, cpus/2)) | Worktree pool size |
| `--budget Ns` | 300s | Total wall-clock for the command |
| `--max-cost CENTS` | 0 (no paid models in Phase 1) | Cap on model adapter cost; aborts if exceeded |
| `--strategy {bon,refine,tournament}` | bon | Loop strategy |

Budget is hard. On expiry: return current best candidate as `BUDGET_EXCEEDED` with passing/failing verifier list. Exit code `3` (distinct from `0` approved, `1` no candidates passed, `2` model failure).

---

## 6. The verifier coverage gap

The central honest limit: a candidate that passes all verifiers might still not implement the intent.

Examples:
- Intent: "add JSON validation at the boundary." Verifier: `test:handlers.test.ts`. Candidate adds `if (typeof body !== 'object') throw new Error()` — passes the test if the test only checks rejection of non-objects. Doesn't validate schema. Verifier doesn't catch.
- Intent: "wire the new MEMORY binding through the request handler." Verifier: `harness:all`. Candidate adds the binding declaration but never calls it. Harness doesn't know what "wire through" means.

This is the exact gap an LLM grader would close, and the exact gap the no-SOTA constraint forbids closing automatically.

The system handles the gap by **owning it explicitly**:

1. The verified output is marked with the verifier list. The user sees what was checked and what wasn't.
2. The default verifier set requires `test:` for "implement" intents (enforced via intent classification — see §7).
3. Unverified runs (`--no-verifiers`) are loud and audited.
4. Verifier mis-specification recurs as a pattern in the recurrence log; users see "the test you wrote let bad implementations through 5 times this week" via `interlinked recurrence`.

The user is the verifier-author, and the user is the failure-coverage owner. The executor's job is to make that ownership legible, not to close it autonomously.

---

## 7. Intent classification (lightweight)

Intents are categorized into a few shapes by simple keyword detection in `src/harness/executor/intent.ts`:

| Shape | Trigger words | Default required verifiers |
|---|---|---|
| `implement` | "implement", "add", "create", "build" | At least one `test:*` verifier |
| `wire` | "wire", "connect", "integrate", "thread" | At least one `test:*` AND `structural:*` |
| `fix` | "fix", "resolve", "repair" | At least one `test:*` (the test demonstrating the bug) |
| `tweak` | "rename" (consider verb), "tweak", "adjust", "tighten" | `harness:all` minimum |
| `refactor` | "refactor", "extract", "lift", "rename" | Suggest using a verb (Doc B) instead — refuse with hint |
| (default) | anything else | `harness:all` |

If the user passes an `implement` intent without a `test:` verifier, the executor refuses with a hint:

```
$ interlinked execute --intent "implement JSON validation at the boundary"
Error: implement-shaped intents require at least one --verify "test:<path>".
       Without a test, the verifier set can't tell whether the implementation matches the intent.
       Override with --i-know-what-im-doing if intentional.
```

This is the *most opinionated* part of the design. It's also the part most likely to get pushback. The escape hatch (`--i-know-what-im-doing`) exists; the friction is intentional. Rationale: the no-SOTA-grader thesis only holds with disciplined verifiers; soft enforcement of "use a real test for an implement intent" is the discipline.

---

## 8. CLI surface

```bash
interlinked execute \
  --intent "..." \
  [--verify "kind:arg" ...] \
  [--strategy {bon,refine,tournament}] \
  [--n N] \
  [--parallel K] \
  [--budget Ns] \
  [--model NAME] \
  [--dry-run] \
  [--apply] \
  [--json] \
  [--output FILE]

# Subcommands
interlinked execute history          # Tail .interlinked/execute-history.jsonl
interlinked execute show <id>        # Full report for a past invocation
interlinked execute verifiers list   # All verifier kinds + their predicates
interlinked execute verifiers test --verify "kind:arg" --against HEAD~1
                                     # Test a verifier expression against a known diff
```

`--dry-run` is the default; `--apply` actually writes to the working tree. Forces the user to inspect the diff before applying. (Counter to most CLI conventions where the default is to do the thing — chosen because the consequences of a wrong edit are higher than the friction of two commands.)

`verifiers test` lets the user verify their verifier expression is correctly framed before running the executor. The verifier-authoring discipline this design depends on needs tooling support; this is the minimum.

---

## 9. Output and reporting

Default output:

```
$ interlinked execute --intent "..." --verify "test:..." --verify "harness:all" --apply
[execute] Intent: "..."
[execute] Strategy: bon (n=10, parallel=4)
[execute] Verifiers: test:src/api/__tests__/handlers.test.ts, harness:all
[execute] Generated 10 candidates in 23.4s

  Cand  Verifiers Passed   Lines Δ  Files Δ   Notes
  -----  ----------------  --------  --------  --------------------
  1     1/2  (test fail)        +47       2     test: expected ..., got ...
  2     2/2                     +52       2     ✓ approved
  3     0/2                      +0       0     candidate empty (model timeout)
  ...   ...                     ...     ...
  
[execute] Approved: candidate 2 (2/2 verifiers, 52 lines, 2 files)
[execute] Diff:

(unified diff follows)

Applied to working tree.
History: .interlinked/execute-history.jsonl#abc123
```

`--json` emits the full per-candidate report:

```json
{
  "id": "abc123",
  "timestamp": "2026-05-10T12:00:00Z",
  "intent": "...",
  "verifiers": [...],
  "strategy": "bon",
  "n": 10,
  "candidates": [
    { "index": 1, "passing": ["harness:all"], "failing": ["test:..."], "diff_stats": {...}, "rationale": "..." },
    ...
  ],
  "approved": 2,
  "applied": true,
  "model": "ollama:qwen3-coder:32b"
}
```

Used by downstream tooling (CI integration, recurrence aggregation, `interlinked execute history`).

---

## 10. Storage and provenance

| File | Git | Purpose |
|---|---|---|
| `.interlinked/execute-history.jsonl` | gitignored | One line per invocation: id, intent, verifiers, outcome, applied diff hash |
| `.interlinked/execute-config.local.json` | gitignored | Default model, default strategy, default n |
| `.interlinked/refactor-worktrees/` (shared with Doc B) | gitignored | Scratch worktree pool |

`execute-history.jsonl` flows into `interlinked recurrence` as `harness_caught` records when invocations fail to converge. Patterns ("intents containing 'wire X through Y' fail to converge 4/5 times") become recurrence entries the maintainer can act on (e.g., write a verb for the recurring shape).

---

## 11. Failure modes

| Failure | Detection | Response |
|---|---|---|
| All N candidates fail at least one verifier | BoN loop end | exit 1, return best candidate with failing verifier list |
| Local model produces no valid output for any candidate | adapter parse failures × N | exit 2, log "model adapter failure" |
| Budget exceeded | wall-clock | exit 3, return current best |
| User's `custom:` script is buggy (always exits 1) | repeated unexplained failures | recurrence log surfaces; user inspects |
| User's `test:` is over-permissive | verifier passes, user notices wrong implementation post-apply | unrecoverable by harness; recurrence log surfaces "test:X passed wrong implementations" pattern over time |
| Model gaming the verifier (e.g., adds a file-wide TS-suppression directive to pass tsc) | composite verifier (`harness:all` includes anti-shortcut checks) catches it | candidate rejected |
| Parallel candidates touching same files conflict | per-worktree isolation | no conflict possible by design |
| Worktree pool exhausted | startup | wait + retry with reduced parallel count |

The "user's test is over-permissive" failure is the central non-mitigable failure mode. By design, the test is the user's spec; the executor trusts it. Mitigation is observational (recurrence log), not preventative.

---

## 12. Testing

- `__tests__/intent.test.ts` — intent classification, refusal logic for `implement` without test
- `__tests__/verifiers/<kind>.test.ts` — one per verifier kind, ≥3 pos/neg
- `__tests__/strategies/bon.test.ts` — convergence with mock model
- `__tests__/strategies/refine.test.ts` — improvement across attempts with mock model
- `__tests__/strategies/tournament.test.ts` — elimination ordering with cost-tagged verifiers
- `__tests__/budget.test.ts` — hard budget enforcement, partial-result return
- `__tests__/refusal.test.ts` — `--no-verifiers` requires explicit flag, `implement` requires test
- `__tests__/integration.test.ts` (gated on `INTERLINKED_INTEGRATION_EXECUTE=1`) — real ollama, real test execution

Mock model is parameterized to return controlled candidate sequences (e.g., "first 5 candidates fail tsc, candidate 6 passes everything"), so loop semantics are deterministically testable.

---

## 13. Phased rollout

| Phase | Deliverable | Gate to next |
|---|---|---|
| 1 | Command skeleton + `harness:all` + `diff:*` verifiers + `bon` strategy + `MockAdapter` | All unit tests pass |
| 2 | `OllamaAdapter` (reused from Doc B) + `test:*` verifier + intent classification refusal | Real-model integration test passes on a 5-case test corpus |
| 3 | `structural:*` verifier + `ratchet:*` verifier + `custom:*` verifier | Pos/neg tests + manual verification |
| 4 | `refine` and `tournament` strategies | Sample-efficiency comparison against `bon` on the test corpus |
| 5 | `verifiers test` subcommand + `execute history` + `execute show` | Used in 5+ real sessions |
| 6 | Refactor verb passthrough (`--refactor rename --from X --to Y`) | Doc B Phase 5 stable |
| 7 | (Optional, gated on constraint relaxation) Remote non-SOTA model adapters | Out of scope by default |

Phase 1's `bon + harness:all + diff:*` is the minimum useful executor — no test verifier yet, but verified-against-harness is already a quality floor above raw codegen. Phase 2's `test:*` verifier is when the design's full thesis ("user-written test as oracle") becomes available. If the executor isn't actually used between Phase 1 and Phase 2 because verifying-only-against-harness is too weak to be useful, the thesis is partially falsified — that's an interesting fail-fast signal.

---

## 14. Open questions

1. **Intent length cap.** Today no cap. Should there be one? Long intents are usually a sign the work should be decomposed. Provisional answer: warn at >500 chars, refuse at >2000.
2. **Multi-file intents.** The executor supports them but BoN coverage degrades fast as the candidate space grows. At some scope (e.g., >5 files), `refine` strategy probably dominates. Make it the default for multi-file?
3. **Verifier output truncation.** A failing test with a 5MB log shouldn't be fed back to the model wholesale. Truncation policy: first 2KB + last 1KB by default; `--verifier-feedback-bytes N` to override.
4. **Cross-invocation caching.** If the same intent is run twice with the same verifiers and the same model, should the second invocation read the first's candidates? Tempting but most intents are run because the first failed; cache hit rate would be low. Defer.
5. **CI integration.** `interlinked execute --intent "..."` in a GitHub Actions step opening a PR? Mechanically possible, sociologically aggressive. Not in Phase 1 — let the human do the apply.
6. **Verifier specifications as files.** Long `--verify` lists are awkward on the command line. Option to pass `--verifiers verify-spec.yaml` to load a list. Phase 5 if the surface is used enough.
7. **What if the user's environment has no local model?** Refuse cleanly with installation instructions; do not silently fall back to a paid remote model. The no-SOTA constraint is the design's spine — runtime fallback would violate it implicitly.

---

## 15. Composition with the larger system

| Doc | Relationship |
|---|---|
| A (escalation rules) | Failed-execute patterns can fire escalations ("you've tried `--intent 'wire X through Y'` 4 times this session — consider whether the verifier set is the limit") |
| B (refactor verbs) | D reuses B's model adapter and worktree pool; D's `--refactor <verb>` flag is a passthrough to B; B is the strongly-verifiable subset of D's intent space |
| C (ratchet/quota system) | C's engine is a verifier kind in D (`ratchet:all`, `ratchet:<id>`) |
| Existing `interlinked recurrence` | Failed convergences become `harness_caught` records; over time, recurrence aggregation surfaces "this intent shape doesn't converge — write a verb" |

The build order (A → B → C → D) is intentional: each doc's machinery becomes a primitive in the next.

- A gives us the synthesis layer (plan-shaped feedback, `[plan]` tag)
- B gives us the BoN-loop machinery and proves that local-model + tight-verifier converges
- C gives us a ratchet vocabulary that becomes a verifier kind in D
- D is the open-ended capstone, leveraging A/B/C as primitives

The system-level effect: a non-SOTA local model becomes useful for bounded engineering work (verbs in B, free-form-with-verifiers in D), with a deterministic feedback cadence (warn in base checks → synthesize in A → enforce in C → audit failed convergences via recurrence). At no point does the system require a SOTA model to plan, execute, verify, or judge.
