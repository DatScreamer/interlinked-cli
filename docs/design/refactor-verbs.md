# Refactor Verbs — Structured, Verifiable Edit Intents for Local-Model Execution

**Status:** Design / not yet implementation. Sequenced second in the no-SOTA-assumed harness extensions (B in the A/B/C/D series).

**Origin.** Free-form `--intent "do X"` is unverifiable without an LLM grader. A grader strong enough to judge intent satisfaction is exactly the SOTA we've ruled out. The way out is to constrain intent to a small set of verbs whose **pre-** and **post-conditions** are deterministically checkable. Each verb defines a contract; a local model fills the gap between pre and post; the harness verifies the contract. BoN converges because the verifier is tight.

**Audience.** Engineers building `src/commands/refactor/` and `src/harness/refactor/`.

**Constraint.** No SOTA model anywhere — at planning, execution, or verification. The human picks the verb; a local non-SOTA model executes; deterministic contracts verify. The verifier coverage is exactly the verb's contract — no looser, no tighter.

---

## TL;DR

A new command tree `interlinked refactor <verb>` exposes a fixed initial set of six verbs: `rename`, `extract-function`, `lift-shared`, `add-param`, `inline`, `split-file`. Each verb is one TypeScript module under `src/commands/refactor/<verb>.ts` plus a contract under `src/harness/refactor/contracts/<verb>.ts`. The contract declares deterministic pre- and post-condition predicates that compose existing harness primitives (`project-graph`, `quality-checks`, `impact-analysis`, `structural-checks`).

A pluggable model adapter (`ollama` first, others later) generates structured edit deltas. A BoN loop applies each candidate to a scratch worktree, verifies the contract, and returns the best passing candidate (or "no convergence" with the closest near-miss).

The local model never plans, never decides scope, never extends the contract — those are fixed by the verb. The verb is the planner-substitute.

---

## 1. Why structured verbs (not free-form intent)

The verifier-coverage gap is the central design constraint of any BoN code-generation system: passing the harness ≠ implementing the intent. With free-form intent, that gap is open: a model can produce a passing diff that doesn't do what was asked. With structured verbs, the gap is *closed at the verb's scope*: if the contract for `rename --from foo --to bar` passes, then `foo` no longer exists as a symbol and `bar` is referenced from every site `foo` was referenced from. There is no "did it actually rename" gap — that's exactly the contract.

The cost is expressiveness: not every refactor is a verb. The bet is that the long tail of refactors is dominated by a small head of common shapes (rename, extract, lift, add-param, inline, split). Empirically, in this repo's git log over the last 90 days, ~70% of refactor-flavored commits fit one of these six verbs. The remaining 30% need free-form intent — that's Doc D's job, with explicit user-supplied verifiers.

A second cost: the model has to produce structured output (JSON edit deltas), not freeform code. Local models with weak instruction-following can fail at this. Mitigation in §6.

---

## 2. Verb taxonomy

The verb set is fixed and small on purpose. Each verb's name maps to one entry in `src/harness/refactor/contracts/`. Adding a verb requires writing the contract file and a CLI module — no plugin system in Phase 1.

| Verb | One-line spec | Pre | Post |
|---|---|---|---|
| `rename` | Rename a symbol across a scope | symbol exists; target name not taken in scope | symbol gone; target has same N references; tsc clean; tests pass |
| `extract-function` | Pull a line range into a named function | range is valid (closed expression); name not taken | range replaced by call; new function defined; same return type; tests pass |
| `lift-shared` | Move a symbol used by ≥2 files into a shared location | symbol exported from source; ≥2 importers; target file resolves to a higher layer | symbol at new location; original re-exports OR removed; importers updated; cycle count not increased |
| `add-param` | Add a parameter with a default value to a function signature | function exists; param name not taken; default expression type-checks | signature updated; all callsites unchanged behaviorally; tsc clean; tests pass |
| `inline` | Inline a function or variable at all callsites | symbol has ≤K references (configurable cap); body inlinable (no closures over local state) | symbol gone; behavior preserved at callsites; tsc clean; tests pass |
| `split-file` | Break a file into N files by symbol grouping | source file has ≥2 disjoint export clusters; target paths free | source split; imports updated; no new cycles; tsc clean; tests pass |

The verbs were chosen by surveying refactors actually performed in this repo and the sibling `mcp-agent-chat` repo. Other candidates considered and rejected for Phase 1:

- `move-file` — special case of `rename` of a file path; can layer on later
- `change-return-type` — too easy to pass contract trivially without behavioral correctness
- `merge-functions` — semantics ambiguous; defer until requested

---

## 3. Contract anatomy

A contract is two functions and a config:

```typescript
interface RefactorContract<Args, Snapshot> {
  pre(args: Args, ctx: HarnessContext): Promise<Predicate[]>;
  snapshot(args: Args, ctx: HarnessContext): Promise<Snapshot>;
  post(args: Args, snap: Snapshot, ctx: HarnessContext): Promise<Predicate[]>;
  cost: { wallclock_budget_s: number; max_files_touched: number };
}

interface Predicate {
  name: string;
  ok: boolean;
  detail?: string;          // Human-readable failure reason
  evidence?: string[];      // Paths/symbols that demonstrate
}
```

`snapshot` runs **before** the model edits; it captures whatever pre-state the post-condition needs to compare against. For `rename`, the snapshot is "the set of files that imported `foo`." For `add-param`, the snapshot is "the set of callsites of the function and their argument shapes."

`post` is then a pure function of (args, snapshot, current state). This is the structure that makes contracts deterministic and auditable — a reviewer reading the contract knows exactly what the model is being held to.

### 3.1 Predicate composition

Predicates compose existing harness primitives:

| Predicate building block | Source |
|---|---|
| `symbolExists(name, scope)` | `src/harness/project-graph.ts` |
| `referenceCountUnchanged(name, n)` | `src/harness/impact-analysis.ts` |
| `tscCleanForFiles(files)` | `src/harness/quality-checks.ts` (existing tsc check, scoped) |
| `testsPassForFiles(files)` | `src/harness/quality-checks.ts` (existing test runner, scoped) |
| `noNewCircularImports(before, after)` | `src/harness/structural-checks.ts` |
| `behaviorPreserved(before, after, harness)` | composite: tsc + tests + structural |

Contracts are not allowed to invent new predicates inline. Every predicate must be a function exported from `src/harness/refactor/predicates.ts` (or one of the existing harness modules). This is the "no plugin escape hatch" discipline — contracts compose from a vetted vocabulary, not from arbitrary code.

### 3.2 Worked example: `rename` contract

```typescript
// src/harness/refactor/contracts/rename.ts
export const renameContract: RefactorContract<RenameArgs, RenameSnapshot> = {
  async pre({ from, to, scope }, ctx) {
    return [
      await symbolExists(from, scope, ctx),
      await symbolNotExists(to, scope, ctx),
      await scopeIsResolvable(scope, ctx),
    ];
  },
  async snapshot({ from, scope }, ctx) {
    return {
      reference_count: await countReferences(from, scope, ctx),
      reference_files: await referenceFiles(from, scope, ctx),
    };
  },
  async post({ from, to, scope }, snap, ctx) {
    return [
      await symbolNotExists(from, scope, ctx),
      await referenceCountEquals(to, snap.reference_count, ctx),
      await tscCleanForFiles(snap.reference_files, ctx),
      await testsPassForFiles(snap.reference_files, ctx),
      await noNewSuppressionsAdded(snap.reference_files, ctx),
    ];
  },
  cost: { wallclock_budget_s: 60, max_files_touched: 50 },
};
```

The last predicate (`noNewSuppressionsAdded`) is the anti-shortcut clause: a model under BoN pressure can pass tsc by sprinkling `// @ts-ignore`. Contracts that touch type-checked code include this predicate by default.

---

## 4. Model adapter

```typescript
interface ModelAdapter {
  name: string;                                    // "ollama", "anthropic", "openai", ...
  generate(req: GenerateRequest): Promise<EditDelta>;
  cost(req: GenerateRequest): Promise<{ cents: number; tokens: number }>;
}

interface GenerateRequest {
  verb: string;
  args: unknown;                                   // Verb-specific
  pre_context: { files: Record<string, string> }; // Files the contract touches
  prior_attempts?: PriorAttempt[];                 // For refine strategy (D)
}

interface EditDelta {
  // Strict structured output — no freeform "here's a code block"
  edits: Array<
    | { op: "replace_file"; path: string; content: string }
    | { op: "patch"; path: string; old_string: string; new_string: string }
    | { op: "create_file"; path: string; content: string }
    | { op: "delete_file"; path: string }
  >;
  rationale?: string;                              // Optional, ignored by verifier
}
```

### 4.1 Phase 1 adapters

- `OllamaAdapter` — local, free, no auth. Default model: `qwen3-coder:32b` if installed, else `codellama:13b-instruct`.
- `MockAdapter` — for tests. Returns scripted candidates.

### 4.2 Why no Anthropic/OpenAI adapter in Phase 1

Per the no-SOTA constraint. The adapter interface is designed to support remote models, but Phase 1 only ships local. If a Phase 5 expansion adds remote non-SOTA models (e.g., Groq's Llama-3.3-70B), the adapter slots in cleanly. SOTA models (Sonnet/Opus, GPT-4-class, Gemini-Pro-class) are explicitly out of scope by the constraint that drove this design.

### 4.3 Structured-output enforcement

Local models with weak instruction-following often emit "here's the code I wrote: \`\`\`ts ... \`\`\`" instead of strict JSON. The adapter wraps the model in a JSON-schema-validated harness:

1. Prompt the model with a JSON schema for `EditDelta`
2. Parse output; on parse failure, retry with the parse error in the prompt (up to 3 retries)
3. On 3 retries failed, count the candidate as `INVALID_OUTPUT` and continue BoN

For models that support a server-side structured-output mode (Ollama's `format: json` parameter, JSON mode for compatible models), use it. For models without, the parse-retry loop is the fallback.

---

## 5. BoN loop

```
GenerateAndVerify(verb, args, n, budget):
  contract  = contracts[verb]
  pre_ok    = await contract.pre(args)             // fail-fast on pre violations
  if not pre_ok: return PRE_FAILED

  snap      = await contract.snapshot(args)
  worktree  = createScratchWorktree()
  candidates = []

  for i in 1..n parallel up to MAX_PARALLEL:
    delta   = await adapter.generate({ verb, args, pre_context })
    if delta == INVALID_OUTPUT: continue
    apply(delta, worktree.copy(i))
    post_results = await contract.post(args, snap, worktree.copy(i))
    candidates.append({ delta, post_results, score: scoreOf(post_results) })

  best = candidates.maxBy(c => c.score)
  if best.score == FULL_PASS:
    return APPROVED(best.delta)
  return NEAR_MISS(best.delta, failing_predicates(best))
```

### 5.1 Scoring

Contracts emit a `Predicate[]`. A candidate's score is the count of `ok: true` predicates. Ties broken by:

1. Fewer files touched (smaller blast radius)
2. Fewer net lines changed
3. Original generation order (stable)

Pure pass/fail tournament — no weighted scoring with magic numbers, per `feedback_taste_enforcement.md`'s "deterministic taste levers" frame.

### 5.2 Worktree management

Candidates can't be applied to the live working tree concurrently (they'd stomp). Two options were considered:

| Option | Pros | Cons |
|---|---|---|
| Git worktree per candidate (`git worktree add`) | Real FS isolation; tools like tsc/cargo see real files | Slow setup (~500ms each); disk I/O cost |
| In-memory virtual FS (overlay over working tree) | Fast | Tools that shell out (tsc, mypy) need real files; would need fs-overlay shim |

Phase 1 uses `git worktree add` with a pool: pre-warm `MAX_PARALLEL` worktrees at command start, recycle between candidates. ~500ms one-time setup amortizes across N samples. Worktrees live under `.interlinked/refactor-worktrees/` (gitignored).

The pool size defaults to `min(N, max(2, cpus / 2))`. Configurable via `--parallel`.

### 5.3 Budget enforcement

Per-verb `cost.wallclock_budget_s` is the hard ceiling. If BoN hasn't converged within budget:

- Return the highest-scoring candidate as `NEAR_MISS` with the failing predicates listed
- Log to `.interlinked/refactor-history.jsonl` (used by `interlinked recurrence` integration)
- Exit code `2` (distinguishable from `0` = approved and `1` = pre-failed)

---

## 6. CLI surface

```bash
# Verb commands
interlinked refactor rename --from foo --to bar [--scope src/] [--n 20]
interlinked refactor extract-function --file x.ts --lines 100-150 --name doX
interlinked refactor lift-shared --symbol X --from a.ts --from b.ts --to shared.ts
interlinked refactor add-param --signature 'fn(a, b)' --to 'fn(a, b, c)' --default null
interlinked refactor inline --symbol foo
interlinked refactor split-file --file big.ts --by exports

# Common flags (all verbs)
  --n N                  # BoN sample count (default 10)
  --parallel K           # Worktree pool size
  --model NAME           # Override default adapter
  --budget Ns            # Per-verb wall-clock cap
  --dry-run              # Show diff, don't apply
  --json                 # Machine-readable output
  --verbose              # Show per-candidate scoring

# Inspection
interlinked refactor list                    # Available verbs + their contracts
interlinked refactor explain <verb>          # Print contract pre/post in human form
interlinked refactor history                 # Tail .interlinked/refactor-history.jsonl
```

### 6.1 Output

Default output is the unified diff that gets applied (or "would be applied" with `--dry-run`):

```
$ interlinked refactor rename --from foo --to bar
[refactor:rename] Pre: 3/3 ok
[refactor:rename] Generating 10 candidates (model=ollama:qwen3-coder:32b, parallel=4)...
[refactor:rename] Verified 10/10 candidates in 14.2s
[refactor:rename] Approved candidate 7/10: 5/5 post predicates pass
[refactor:rename] Diff: 8 files, +47 -47

(unified diff follows)

Apply? [y/N]
```

`--json` emits the full per-candidate report for downstream tooling. Schema in `src/harness/refactor/output.ts`.

---

## 7. Failure modes

| Failure | Detection | Response |
|---|---|---|
| Local model can't produce valid JSON | parse error after 3 retries | candidate counted as `INVALID_OUTPUT`, continue BoN |
| All N candidates fail post | no `FULL_PASS` candidate | exit `2` with near-miss diff and failing predicates |
| Pre-condition fails | first contract step | exit `1` with predicate name and reason — *don't* call the model |
| Worktree apply fails (patch conflict) | git apply error | candidate scored 0, continue |
| Verifier flake (tsc transient error) | non-deterministic predicate result across re-runs | re-run that predicate once; if still flaky, count as fail (conservative) |
| Model produces an edit that touches files outside the verb's declared scope | file not in `pre_context` | candidate rejected with `OUT_OF_SCOPE` |
| Verifier coverage gap (contract passes but rename was semantically wrong) | not detectable by harness | acknowledged limit; mitigated by §3.1's anti-shortcut predicates and per-verb test corpus |

The verifier coverage gap is the most important acknowledged limit. A `rename` from `foo` to `bar` passes the contract even if `foo` meant something semantically different in some files than others (rare but real — e.g., a method on two unrelated classes that share a name). The harness has no determinism handle for "is this semantically the right rename?" — that's exactly the SOTA-grader gap. Mitigation: every verb ships with a per-verb test corpus of known-tricky cases (§9), and the recurrence system catches "rename keeps getting reverted" patterns.

---

## 8. Storage and provenance

| File | Git | Purpose |
|---|---|---|
| `.interlinked/refactor-worktrees/` | gitignored | Scratch space for candidate worktrees |
| `.interlinked/refactor-history.jsonl` | gitignored | One line per refactor invocation: verb, args, n, outcome, applied diff hash, near-miss predicates |
| `.interlinked/refactor-config.local.json` | gitignored | Default model, default N, parallel cap |

`refactor-history.jsonl` feeds two downstream consumers:

- `interlinked recurrence` — refactors that fail repeatedly become `harness_caught` recurrences; refactors that succeed become baseline data for "this verb works for this codebase"
- `interlinked refactor history` — local CLI for the developer

---

## 9. Testing

Each verb requires:

1. **Contract unit tests** (`__tests__/contracts/<verb>.test.ts`): every pre and post predicate, positive and negative, ≥3 each per `feedback_generalize_across_codebases.md`
2. **End-to-end with mock model** (`__tests__/e2e/<verb>.test.ts`): scripted candidates, verify BoN converges or doesn't as expected
3. **Per-verb tricky-case corpus** (`__tests__/corpora/<verb>/`): hand-curated source trees with known-tricky cases (e.g., for `rename`: shadowed names, dynamic property access, JSDoc references)
4. **Integration with real model** (`__tests__/integration/<verb>.test.ts`, gated on `INTERLINKED_INTEGRATION_REFACTOR=1`): real ollama if installed, skipped in CI default

The tricky-case corpus is the per-verb honesty check — every known semantic-correctness gap goes here. If the contract passes on a corpus case where it shouldn't, the contract gets a new predicate.

---

## 10. Phased rollout

| Phase | Deliverable | Gate to next |
|---|---|---|
| 1 | `rename` end-to-end with `MockAdapter` + 5/5 contract predicates + 10-case tricky corpus | All tests green; manual review of contract |
| 2 | `OllamaAdapter` + worktree pool + budget enforcement | `rename` real-model integration test passes ≥80% on tricky corpus |
| 3 | `extract-function` + `lift-shared` (the next two highest-value verbs by git log) | Each ≥3/3 pos/neg + tricky corpus |
| 4 | `add-param` + `inline` + `split-file` | Same gate |
| 5 | `interlinked refactor propose` (suggest verbs from project graph state) | Phase 4 stable |
| 6 | Plugin adapters (Groq, etc.) — **only if** non-SOTA constraint relaxes | Out of scope by default |

Phase 1's `rename` is the load-bearing proof. If a 32B local model + 10-sample BoN + the contract can't reliably rename across this repo's codebase, the entire B/D thesis is falsified cheaply, before B/C/D are built out. That's the intended fail-fast.

---

## 11. Open questions

1. **Test runner scoping.** `testsPassForFiles` currently re-runs tests touching the file set. For large files (e.g., `evaluator.ts`), this fires many tests. Acceptable cost? If not, add a per-verb `cost.test_subset` config to limit.
2. **Behavioral preservation predicate.** `behaviorPreserved` is composite (tsc + tests + structural). Some refactors (e.g., `inline`) genuinely change runtime equivalence in subtle ways the harness can't see. Verb config can opt out per predicate, but this is a footgun.
3. **Multi-language scope.** Phase 1 verbs assume TypeScript (because `project-graph` is strongest there). For Python/Rust/Go, predicates exist but are weaker. Defer multi-language verbs to Phase 5.
4. **Interactive disambiguation.** When `pre` returns multiple candidates (e.g., `rename --from foo` matches three symbols), how does the user choose? Phase 1: refuse and require fully-qualified name. Phase 4: optional interactive selector.
5. **Contract evolution.** A contract change is a behavior change for everyone using the verb. Versioning policy? Phase 1: contracts versioned monotonically; `refactor-history` records contract version with each invocation.
6. **What stops verbs from accumulating into a 50-item junk drawer?** The 6-verb cap is informal. Add an explicit RFC discipline: new verbs require a written justification + git-log evidence that the shape recurs ≥10 times across ≥2 repos.

---

## 12. Composition with the larger system

| Doc | Relationship |
|---|---|
| A (escalation rules) | Verb-induced findings flow into the escalation system the same way as edit-induced findings. A "rename keeps failing on this codebase" recurrence can fire an escalation. |
| C (ratchet/quota system) | Verb contracts can include ratchet predicates ("`as any` count not increased") via the same predicate vocabulary. |
| D (BoN executor) | `interlinked execute --refactor rename --from X --to Y` is a passthrough — D's executor wraps verbs as one of its strategies. Verbs are the strongly-verifiable subset of D's intent space. |
| Existing `interlinked recurrence` | Refactor outcomes append to recurrence log; refactors that don't converge are surfaced as patterns to fix. |

The sequencing matters: B (verbs) lands before D (free-form executor) because verbs are where BoN provably works. D inherits the wins from B and only ventures into the loose-verifier territory after the tight-verifier territory is paved.
