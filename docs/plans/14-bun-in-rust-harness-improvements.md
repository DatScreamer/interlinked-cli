# Bun-in-Rust Harness Improvements - Implementation Plan

**Status:** Living implementation plan, created 2026-07-09.

**Source:** `docs/external-pulse/bun-in-rust.md`, from Jarred Sumner's 2026-07-08
"Rewriting Bun in Rust" post.

**Thesis:** Bun's rewrite worked because deterministic oracles, not exhortation,
held agent-written code to a standard: compiler errors, unchanged tests,
sanitizers, fuzzers, split-context review, and strict coordination rules. For
Interlinked CLI, the equivalent move is to shift these oracles as early as the
hook contract allows: first to PreToolUse static checks, then to proposed-edit
overlays, then to cloud Sandbox jobs when local execution does not fit.

This document is the build plan. The external-pulse note explains why the post
matters; this file names the PRs, module touch points, test requirements, rollout
order, and explicit non-goals.

---

## 0. Current State Snapshot

Code that already exists and should be reused:

| Capability | Current module | What it gives us | Gap this plan closes |
|---|---|---|---|
| PreToolUse deterministic rule engine | `src/harness/rules/*`, `src/harness/evaluator/pre-tool-rules.ts` | shell/git/tool blocks and warnings | cohort-aware "dangerous under parallel agents" rules |
| Generic check registry | `src/harness/check-registry/*`, `src/harness/check-metadata/*`, `src/commands/verify/*` | repeatable static check wiring | Bun-derived detector pack |
| Rust debug assert side-effect detector | `checkRustDebugAssertSideEffects` in `src/harness/checks/ubs-language-specific/rust-go-checks.ts` | catches one Bun regression class as advisory | generalize to other assert-erasure mechanisms |
| Test hygiene checks | `src/harness/checks/js-ts-general.ts`, `src/harness/checks/test-hygiene*`, `src/harness/verification-stop-checks.ts` | JS/TS skip/focus/assertion detection | ratcheted cross-language skip/delete baseline |
| Proposed-edit overlay | `src/harness/coverage-overlay.ts` | full shadow tree with proposed content applied before disk write | generic command runner over the overlay, not only coverage |
| Coverage execution gate | `src/harness/evaluator/coverage-write-guard.ts`, `src/harness/coverage-runner.ts` | bounded test/coverage execution against overlay | sanitizer/leak/fuzz smoke job contract |
| Mutation cloud client | `src/harness/mutation/cloud-runner.ts` | daemon-side HTTP client for mutation reports | generic `SandboxJobRunner` interface and server contract |
| Cohort + reservations | `src/harness/cohort.ts`, `src/harness/reservations.ts` | active-agent tracking and file reservation conflicts | escalate local conflicts and git commands under multi-agent load |
| Tier 3 design | `docs/design/tier-3-async-deep-review.md` | pre-push/on-demand LLM review shape | remove implementer trajectory from reviewer context |

Important repo contract:

- `pre_block` checks must stay deterministic. Heuristic checks stay warnings,
  advisory, or `verify --all-checks`.
- New check metadata usually touches registry entries, metadata, verify result
  plumbing, advisory skips, parity tests, and generated docs.
- Rule metadata changes require `npm run docs`. For check metadata changes,
  follow the touched registry/docs-freshness contract: run `npm run docs` when
  generated docs carry the changed count or command surface, and always run
  `npm run docs:check` before landing.
- Cloud/Sandbox execution must be an optional offload path, not a required local
  dependency for default free-CLI behavior.

---

## 1. Delivery Order

Ship in this order. Each phase is independently useful and does not require the
later phases.

| Phase | PR group | Default behavior | Why first |
|---|---|---|---|
| B0 | Land the Rust `debug_assert*` side-effect detector already in this working tree | advisory/default-skipped | proves the Bun-regression-to-detector path |
| B1 | Static detector pack | warning/advisory, no blocks at first | cheap, deterministic, no infra risk |
| B2 | Test-oracle integrity ratchet | warnings, then commit-time block for drift | protects the suite from agent erosion |
| B3 | Cohort git discipline | active only when >1 active local agent | prevents the exact multi-agent stomping failure Bun hit |
| B4 | Generic overlay command runner spike | opt-in `verify --dynamic` or config-gated hook | measures whether shift-left execution fits 25s |
| B5 | Runtime oracle jobs | opt-in local, cloud-ready contract | runs real checks: leak probe, sanitizer smoke, fuzz smoke |
| B6 | SandboxJobRunner RFC + client interface | no default cloud execution | generalizes mutation cloud client without committing to server work here |
| B7 | Tier 3 split-context adversarial review amendment | design-only, then implementation | prevents reviewer prompt contamination before buildout |
| B8 | Observability + promotion loop | telemetry/local JSONL, no blocking telemetry | lets us promote only low-FP checks |

---

## 2. Phase B0 - Land Rust `debug_assert*` Side-Effect Detector

### Goal

Catch Bun's release-only regression class where code moved a side effect inside
`debug_assert!`, causing release builds to erase the side effect.

### Status

Implemented in the current working tree as `ubs_rust_debug_assert_side_effect`.
It is intentionally advisory/default-skipped because v1 is heuristic: it looks
for `?`, assignments, and mutating-looking calls inside `debug_assert!`,
`debug_assert_eq!`, and `debug_assert_ne!`.

### Files

Already touched in the current implementation:

- `src/harness/checks/ubs-language-specific/rust-go-checks.ts`
- `src/harness/checks/ubs-language-specific.ts`
- `src/harness/generic-checks.ts`
- `src/harness/check-registry/entries-warnings/ubs-checks.ts`
- `src/harness/check-metadata/generic-ubs.ts`
- `src/commands/verify/file-checks-ubs.ts`
- `src/commands/verify/tool-results-types.ts`
- `src/commands/verify/output-json.ts`
- `src/commands/verify/section-table-ubs.ts`
- advisory/parity/count tests

### Acceptance

- Positive: `debug_assert!(dev.client_graph.insert_stale(...)?)` is reported.
- Positive: `debug_assert_eq!(queue.pop(), Some(1))` is reported.
- Negative: `debug_assert!(items.is_empty())` is not reported.
- Negative: comments and string literals are not reported.
- `npm run typecheck`, focused Vitest tests, `npm run docs`, and `npm run docs:check` pass.

### Follow-up Hardening

- Add a tiny fixture corpus named after real Bun regressions under an existing
  fixture test location. This keeps the four Bun porting mistakes as permanent
  false-negative calibration data.
- Do not promote out of `DEFAULT_ADVISORY_SKIPS` until we have a real-repo FP
  audit, because mutating-looking names are only a proxy for semantic effects.

---

## 3. Phase B1 - Static Detector Pack

### Goal

Turn the real Bun porting regressions into language-aware static detectors. These
checks are cheap and can run on proposed content before it touches disk.

### Detector D1 - Assertion Side Effects Across Languages

#### Problem

Several languages erase or conditionally skip assertion evaluation:

- Rust `debug_assert*` is removed in release.
- C/C++ `assert(expr)` is removed under `NDEBUG`.
- Python `assert expr` is removed under `python -O`.
- JS `console.assert(expr)` is not normally erased by JavaScript itself, but
  many bundlers strip `console.*`; treat it as project-config-dependent advisory.

#### Implementation

Add a shared assertion-side-effect helper rather than copy-pasting heuristics:

- New helper: `src/harness/checks/assert-side-effects.ts`
- Rust caller: keep the existing exported Rust function but delegate to the helper where useful.
- C/C++ caller: `src/harness/checks/c-cpp.ts` or `src/harness/checks/ubs-language-specific/java-c-checks.ts`
- Python caller: `src/harness/checks/ubs-language-specific/python-checks.ts`
- JS caller, if built: `src/harness/checks/js-ts-general.ts` or `ubs-language-specific/js-security-checks.ts`

Suggested IDs:

- `ubs_c_assert_side_effect`
- `ubs_python_assert_side_effect`
- `js_console_assert_side_effect` (advisory only, skip unless repo config declares console stripping)

#### Detection Rules

For assert arguments, flag only if the expression contains at least one of:

- Assignment or compound assignment outside comparison: `=`, `+=`, `-=`, `*=`,
  `/=`, `%=`; avoid `==`, `>=`, `<=`, `!=`.
- Increment/decrement: `++`, `--`.
- Fallible/propagating expression in Rust: `?`.
- Known mutating method names matched as whole names, with only snake_case
  continuations allowed: `insert`, `push`, `push_str`, `pop`, `remove`,
  `remove_entry`, `delete`, `set`, `set_len`, `clear`, `append`, `extend`,
  `write`, `send`, `close`, `reset`, `detach`, `resize`, `free`, `alloc`,
  `open`, `create`, `spawn`. Do not prefix-match ordinary predicates such as
  `starts_with`, `settings`, `opened`, `created_at`, or `popped`.
- Calls on known IO/global objects: `fs.*`, `process.*`, `os.*`, `env.*`,
  `socket.*`, `db.*`, `client.*`, `cache.*`.

Avoid reporting when:

- the file is a test file;
- the match is in a comment/string;
- C/C++ code uses a project-local always-on assertion macro that is not `assert`;
- Python assert compares pure identifiers/literals/calls with safe predicate names
  like `is_*`, `has_*`, `len`, `sizeof`, `matches`.

#### Registry/Verify Work

For each new check:

- Add the check function export through `generic-checks.ts` if it belongs to generic verify.
- Add a registry entry in `src/harness/check-registry/entries-warnings/ubs-checks.ts`
  or `entries-c-cpp.ts` depending on current pattern.
- Add metadata in `src/harness/check-metadata/generic-ubs.ts` or language-specific metadata.
- Add result arrays in `src/commands/verify/tool-results-types.ts`.
- Add aggregation in `src/commands/verify/output-json.ts`.
- Add section rows in the appropriate `section-table-*` module.
- Add `DEFAULT_ADVISORY_SKIPS` entry first.
- Update parity/count tests and run `npm run docs`.

#### Tests

Minimum per language:

- 3 true positives.
- 5 false-positive guards, including comments, strings, pure predicates, tests,
  and language-specific safe forms.
- One fixture where the side-effect spans multiple lines.

#### Acceptance

- The Rust detector remains green.
- C and Python detectors catch erased side effects without firing on ordinary invariant assertions.
- JS detector does not ship enabled by default unless config can prove console stripping.

### Detector D2 - Reinterpret/Cast Alignment and Odd-Length Slices

#### Problem

Bun's Zig helper ignored a trailing odd byte when reinterpreting bytes as `u16`;
Rust `bytemuck::cast_slice` panicked instead. This is a class of "reinterpret
bytes as wider type without checking length/alignment" bugs.

#### Implementation

Primary Rust check:

- File: `src/harness/checks/ubs-language-specific/rust-go-checks.ts`
- ID: `ubs_rust_unchecked_cast_slice`
- Registry: `entries-warnings/ubs-checks.ts`

Flag shapes:

- `bytemuck::cast_slice::<_, u16>(&buf)` or `cast_slice::<u8, u16>(...)`
- `slice::align_to::<T>()` where the result prefix/suffix are ignored
- `std::slice::from_raw_parts(ptr as *const T, bytes.len())` where `T` is wider than byte and no divisor appears nearby
- `transmute::<&[u8], &[T]>` or `transmute` on slices

Require a missing nearby guard. Do not flag when a 5-line window includes:

- `len() % size_of::<T>() == 0`
- `len() & !1`, `len() & !(N - 1)`, or equivalent truncation
- `chunks_exact`, `array_chunks`, `try_from`, `read_u16`, `from_le_bytes`
- explicit handling of prefix/suffix from `align_to`

Secondary C/C++ check is advisory-only:

- `reinterpret_cast<const T*>(bytes.data())`
- cast from `uint8_t*`, `char*`, `void*` to a wider pointer
- no nearby `sizeof(T)` divisor/modulo/alignment guard

#### Tests

- Rust positive: `bytemuck::cast_slice::<_, u16>(&buf)` with no guard.
- Rust negative: `bytemuck::cast_slice::<_, u16>(&buf[..buf.len() & !1])`.
- Rust negative: `buf.chunks_exact(2).map(...)`.
- C++ positive/negative only if we can keep FPs low enough; otherwise document as future.

#### Acceptance

- Ships warning/advisory, default-skipped until a corpus audit.
- Does not fire on safe byte parsing APIs.

### Detector D3 - Placeholder Constants in Runtime Logic

#### Problem

Bun shipped a placeholder `BSS_OVERFLOW_BLOCK_SIZE: usize = 64` with a comment
stating it was a nonzero stand-in. The bug was not "magic number"; it was "small
placeholder constant in runtime logic that changed a limit."

#### Implementation

Add a detector:

- File: `src/harness/checks/policy-constant-drift.ts` or new
  `src/harness/checks/placeholder-constants.ts`
- ID: `placeholder_runtime_constant`
- Registry: likely `entries-warnings/code-quality.ts` or `entries-warnings/agent-laziness.ts`
- Metadata: `generic-agent-laziness.ts` or new fragment if needed

Flag a constant declaration when all are true:

- It declares a numeric literal. Do not include short string literals in v1;
  UI placeholder copy and sentinel strings are too easy to misclassify.
- It is exported/public/config-visible or named in all caps.
- A nearby comment or identifier contains:
  `stand-in`, `temporary`, `until phase`, `phase b`, `stub value`,
  `not final`, `nonzero`, `for now`. Exclude bare `todo` and `fixme`: those
  often describe documentation or follow-up work near a valid constant, not the
  constant's runtime semantics.
- The file is source/runtime code, not test/fixture/docs.

Examples:

```rust
/// use a nonzero stand-in until Phase B threads the value through.
pub const BSS_OVERFLOW_BLOCK_SIZE: usize = 64;
```

```typescript
// temporary cap until quota service lands
export const MAX_ITEMS = 64;
```

Do not flag:

- test fixture constants;
- UI placeholder text attributes;
- migration placeholders in docs;
- intentionally named sentinel values with clear semantics (`UNKNOWN = -1`,
  `DEFAULT_PORT = 3000`) and no temporary comment.

#### Acceptance

- Advisory/default-skipped.
- Message explains the fix: replace the placeholder with the real source of
  truth, make the limit configurable, or move it under test-only code.

### Detector D4 - Interpolated String Then Parsed

#### Problem

Bun's Zig format string was compile-time; the Rust port built a runtime formatted
string and then parsed marker syntax over the finished result, accidentally
rewriting marker-like bytes inside substituted values. This generalizes to
"compose a string with interpolation, then feed it to a parser/mini-language."

#### Implementation

Add a cross-language detector:

- File: `src/harness/checks/ubs-language-specific/cross-language-checks.ts`
- ID: `interpolated_string_parsed`

Flag template/interpolated strings passed directly or via one local variable to:

- `new RegExp(...)`, `RegExp(...)`
- `JSON.parse(...)` only when the string itself is interpolation-built
- YAML/TOML/INI/Markdown parsers when the argument is interpolation-built
- custom marker parsers named like `pretty`, `parseMarkers`, `rewriteMarkers`,
  `formatWithMarkers`, `renderAnsi`, if configured or locally imported
- shell/SQL/eval sinks only if existing specialized detectors do not already
  own the finding

Examples:

```typescript
const payload = `<r>${hyperlink}<r>`;
Output.pretty(payload);
```

```typescript
new RegExp(`${prefix}${userInput}`);
```

Do not flag:

- parameterized SQL APIs already covered elsewhere;
- literal-only templates;
- templates where every substitution is explicitly escaped by a known function
  (`escapeRegExp`, `JSON.stringify`, `encodeURIComponent`, `escapeAnsiMarkers`);
- React JSX/text rendering that is not parsed as a mini-language.

#### Acceptance

- Starts as advisory/default-skipped.
- Must include a suppression/allowlist mechanism for project-specific safe marker parsers.
- Tests prove it does not duplicate existing SQL/shell/eval detector outputs.

### Detector D5 - Escape-Hatch Span and Justification

#### Problem

Bun ended with about 4 percent of Rust code in `unsafe`, and most unsafe blocks
were single-line C boundary calls. The harness currently has `rust_unsafe_blocks`
as an existence-style warning; it does not measure span, density, or whether the
unsafe scope is unnecessarily broad.

#### Implementation

Add a span-aware detector:

- File: `src/harness/checks/ubs-language-specific/rust-go-checks.ts`
- ID: `rust_unsafe_span`

Report:

- multi-line `unsafe { ... }` blocks without a nearby `// SAFETY:` comment;
- unsafe blocks longer than 5 nonblank code lines;
- unsafe blocks containing more than one distinct operation where they could be
  narrowed;
- module-level `unsafe` density above a configurable threshold.

Do not report:

- one-line FFI calls with adjacent `SAFETY:` explanation;
- generated bindings or `bindgen` output;
- tests/fixtures.

Extend later to other language escape hatches:

- TS: unjustified `@ts-ignore`, `@ts-expect-error`, `as unknown as`.
- SQL: nonliteral `sql.unsafe` already exists as `sql_escape_hatch_non_literal`.
- Python: `# type: ignore` with no code.

#### Acceptance

- Advisory/default-skipped.
- No paragraph-comment smell check in Rust. Long `SAFETY:` comments are often
  required, not suspicious.

---

## 4. Phase B2 - Test-Oracle Integrity Ratchet

### Goal

Make Bun's "0 tests skipped or deleted" invariant mechanical for agent work. The
harness should treat test disappearance as oracle erosion, not as ordinary code
churn.

### Scope

This phase protects:

- total test block count;
- skipped/ignored test count;
- focused test count;
- assertion-free or tautological tests;
- newly introduced stubs in production code.

### Implementation Plan

#### B2.1 Baseline Format

Add a project-local baseline:

```json
{
    "schema_version": 1,
    "updated_at": "2026-07-09T00:00:00.000Z",
    "files": {
        "src/foo.test.ts": {
            "test_blocks": 12,
            "skipped_tests": 0,
            "focused_tests": 0,
            "assertions": 30
        }
    },
    "totals": {
        "test_blocks": 1200,
        "skipped_tests": 0,
        "focused_tests": 0,
        "assertions": 3200
    }
}
```

Suggested path: `.interlinked/test-oracle-baseline.json`.

Add this path to the existing baseline integrity patterns so edits to it are
reviewed/gated:

- Search current baseline regex/constants first (`BASELINE_RE` appears in the intake).
- Include `.interlinked/skipped-tests-baseline.json` only if we choose the narrower
  skipped-only baseline; prefer the broader `test-oracle-baseline.json`.

#### B2.2 Cross-Language Skip Detection

Extend disabled-test detection beyond JS/TS:

| Language | Skip/focus forms |
|---|---|
| JS/TS | existing `.skip`, `xit`, `xdescribe`, `.only`, `.todo` |
| Python pytest | `@pytest.mark.skip`, `@pytest.mark.skipif`, `pytest.skip(...)`, `unittest.skip*` |
| Rust | `#[ignore]`, `#[cfg_attr(..., ignore)]` |
| Go | `t.Skip(...)`, `t.Skipf(...)`, `t.SkipNow()`, build tags that exclude tests |
| Swift | existing Swift test integrity scan if present |

Do not treat conditional skips as automatically bad. The ratchet should flag
new unconditional skips and net increases. Conditional platform/dependency skips
should be visible in the baseline but not necessarily blocked.

Likely files:

- `src/harness/checks/js-ts-general.ts`
- `src/harness/checks/test-hygiene.ts`
- `src/harness/checks/swift-test-integrity.ts`
- new `src/harness/checks/test-oracle-baseline.ts`
- `src/commands/verify/file-checks-react-test.ts`
- `src/commands/verify/file-checks-shared.ts`
- `src/harness/verification-stop-checks.ts`

#### B2.3 Stub Expansion

Extend stubs beyond current JS/TS forms:

| Language | Stub forms |
|---|---|
| Rust | `todo!()`, `unimplemented!()`, `panic!("TODO")`, `panic!("not implemented")` |
| Python | `raise NotImplementedError`, bare `pass` in nontrivial function, `TODO` return sentinel |
| Go | `panic("TODO")`, `panic("not implemented")` |
| JS/TS | existing `throw new Error("not implemented")`, TODO stubs |

Keep as warnings/advisory unless the code path is production and newly introduced
in a commit/push bundle.

#### B2.4 Promotion Path

1. Add baseline read/write command or subcommand:
   `interlinked verify --update-test-oracle-baseline` or fold into `interlinked verify --update-baseline`.
2. Add verify output sections:
   - `test_block_count_regression`
   - `skipped_test_count_regression`
   - `focused_test_count_regression`
   - `assertion_count_regression`
3. Start as advisory.
4. Promote `focused_test_count_regression` and new unconditional skips to default warnings.
5. Promote test block deletion to commit-time block once dogfood passes.

### Acceptance

- A PR that changes `it("x")` to `it.skip("x")` reports a baseline regression.
- A PR that deletes a test file reports net test block count loss only when the
  companion SUT still exists and the loss is not explained by a move or test
  table consolidation.
- A legitimate platform `skipIf` remains visible but does not block by default.
- Rust `#[ignore]` and Python `@pytest.mark.skip` are counted.
- Updating the baseline itself is treated like a sensitive quality policy edit.

### Verification

- Unit tests for each language scanner.
- Verify command tests for JSON and table output.
- Baseline tampering tests.
- `npm run typecheck`
- `npm run test -- src/harness/checks/... src/commands/verify/...`
- `npm run docs`

---

## 5. Phase B3 - Cohort Git Discipline

### Goal

Prevent local co-agents from stomping on each other when more than one agent is
active in the same workspace. Bun's false start was not "git is dangerous"; it
was "git commands that are fine for one human become unsafe under 64 agents."

### Current Gaps

Current code has:

- `CohortManager.getActiveAgents()` in `src/harness/cohort.ts`.
- `ReservationManager.checkAndReserve(...)` in `src/harness/reservations.ts`.
- guard-rule scoping primitives: `GuardRule.applies_to_roles` and `active_when`.
- existing hard blocks for `git reset --hard`, `git stash drop|clear`, restore/checkout destructive forms.
- git scope tests around `git add -A` and `git commit -a`.

Known gaps:

- plain `git stash`, `git stash pop`, and `git stash apply` are not blocked by default;
- non-interactive `git rebase main` is allowed;
- `git add -A` and `git commit -a` are scoped but not cohort-aware;
- local reservation conflict currently warns/allows in some paths where a multi-agent cohort should block.

### Implementation

#### B3.1 Add Cohort Predicate

Extend `active_when.predicate` support with:

```json
{
    "name": "active_agent_count_at_least",
    "args": { "count": 2 }
}
```

Implementation location:

- `src/harness/evaluator/rule-matching.ts`
- tests in `src/harness/evaluator/__tests__/rule-matching.test.ts`
- type already exists: `SessionPredicateSpec` in `src/harness/types/rules.ts`

The predicate should count local active agents, not remote reservations. If the
cohort state is unavailable, fail closed for block rules only if the command is
already destructive; otherwise fail open with no finding.

#### B3.2 Add Multi-Agent Git Rules

Add a small rule pack, likely in `src/harness/rules/builtin-rules-extras.ts` or
a new `builtin-rules-cohort.ts`, active only under the predicate above.

Rules:

| Command | Action under >1 active agent | Reason |
|---|---|---|
| `git stash` with no subcommand, `git stash push`, `git stash save` | block | hides dirty work from other agents and changes the shared base |
| `git stash pop`, `git stash apply` | block | reintroduces unknown changes and can overwrite another agent's work |
| `git rebase ...` | ask or block; block if dirty tree or multi-agent | rewrites shared local branch base |
| `git add -A`, `git add --all`, `git add .` | block unless all dirty files are session-owned | stages another agent's work |
| `git commit -a`, `git commit -am` | block unless all modified files are session-owned | commits another agent's work |
| `cargo check` / slow commands | do not block globally; route to resource governor later | Bun blocked cargo because it saturated the rewrite fleet, but default CLI should not ban it |

Use `executed_only` so quoted strings and comments do not fire.

#### B3.3 Reservation Conflict Escalation

Change reservation decision behavior:

- Single active local agent: keep current warning/allow behavior for local conflicts if that is today's contract.
- More than one active local agent and holder is local but not same owner: block.
- Remote conflict: keep current block.
- Expired reservations: prune and allow.

Likely touch points:

- `src/harness/reservations.ts`
- pre-tool decision code that consumes `ReservationConflict`
- `src/harness/__tests__/reservations.test.ts`
- `src/harness/reservations.coverage.test.ts`
- `src/harness/cohort.test.ts`

### Acceptance

- With one active agent, `git stash list` and harmless git commands remain allowed.
- With two active agents, `git stash`, `git stash pop`, `git add -A`, and `git commit -am "x"` are denied unless a scoped ownership exception proves safety.
- A local reservation conflict between two active agents blocks.
- Quoted/documentation mentions do not fire.
- Generated guard docs include the new rules after `npm run docs`.

### Non-Goals

- Do not locally schedule 64 agents. Product segmentation remains: multi-agent fleet workloads offload to cloud.
- Do not ban `cargo` or `npm test` globally. Use the execution-lane resource governor for slow commands.

---

## 6. Phase B4 - Generic Overlay Command Runner Spike

### Goal

Prove the core shift-left claim: not only static checks, but runtime checks can
run against proposed content before disk write by using the existing overlay.

### Why This Is the Risky Spike

Regex detectors are straightforward. The uncertain part is whether a real command
over the shadow tree fits the hook budget, especially on large repos. We need a
generic runner that can execute bounded commands and report results without
pretending every result is coverage-shaped.

### Interface

Add a runner beside `CoverageRunner`:

```typescript
export interface OverlayCommandRunOpts {
    projectRoot: string;
    argv: string[];
    timeoutMs: number;
    env?: Record<string, string>;
    selectedTests?: string[];
    stdin?: string;
}

export interface OverlayCommandRunResult {
    ok: boolean;
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    error?: string;
}

export interface OverlayCommandRunner {
    run(opts: OverlayCommandRunOpts): Promise<OverlayCommandRunResult>;
}
```

Suggested file:

- `src/harness/overlay-command-runner.ts`

Use `spawn`, not shell strings, for argv execution. Add a shell-mode escape hatch
only when the repo command inherently requires shell features, and mark it in the
result.

### Reuse

- `createCoverageOverlay(...)` from `src/harness/coverage-overlay.ts`
- `selectAffectedTests(...)` from `src/harness/coverage-test-selector.ts`
- budget/degrade logic from `src/harness/evaluator/coverage-write-guard-degrade.ts`
- JSONL line reading style from the orchestration skill when output is structured

### Spike Job: Node Leak Probe

Run affected tests under:

```bash
node --expose-gc ./node_modules/vitest/vitest.mjs run <selected tests>
```

Then add a tiny harness wrapper that:

1. calls `global.gc()` before and after;
2. records heap delta;
3. fails only if the delta exceeds a conservative threshold across repeated
   iterations;
4. never blocks by default in this spike.

This is the JS analog of Bun's `Bun.build()` memory leak table.

### Measurement

Run against approximately 20 real edits in this repo:

- simple source edit with 1-3 affected tests;
- source edit with wide fan-in;
- test-only edit;
- docs-only edit;
- generated-file edit.

Record:

- p50, p90, p99 duration;
- timeout rate;
- overlay creation time vs command time;
- selected test count;
- CPU load/cohort count at run time;
- whether result would have changed a gate decision.

Suggested output file:

- `.interlinked/overlay-command-runs.jsonl`

Do not block on telemetry writes.

### Acceptance

- Runner unit tests cover success, nonzero exit, timeout, ENOENT, stdout/stderr truncation.
- Overlay integration test proves proposed content, not disk content, is what the command sees.
- Measurement doc or appendix records whether the 25s budget is realistic.
- No default hook starts running arbitrary commands until the spike has numbers.

---

## 7. Phase B5 - Runtime Oracle Jobs

### Goal

Add deterministic runtime checks that can run locally when cheap and in the cloud
when not: sanitizers, leak checks, Miri, and bounded fuzz smoke. This is Bun's
"ASAN/LSan/Miri/fuzzing" moved left.

### Job Types

| Job kind | Local command examples | Default phase | Blocking rule |
|---|---|---|---|
| `test` | affected tests via repo runner | existing/future PreToolUse overlay | can block only on definitive red run when opted in |
| `leak_smoke` | `node --expose-gc`, language-specific heap probes | verify/dynamic first | warn until dogfooded |
| `asan_smoke` | `cargo test` with sanitizer env, C/C++ sanitizer build command | cloud or manual local | warning unless configured |
| `miri_smoke` | `cargo miri test <selected>` | cloud/manual; local if installed | warning; fail-open if missing tool |
| `fuzz_smoke` | `cargo fuzz run target -- -runs=N`, parser corpus replay | cloud/manual | warning; never synthesized tests on hot path |
| `mutation` | existing mutation gate/runner | async/post/commit | separate plan owns promotion |

### Detection Before Execution

Add tool discovery helpers:

- Rust: detect `Cargo.toml`, `cargo miri`, `cargo fuzz`, `cargo llvm-cov`.
- C/C++: detect CMake/Meson/Make sanitizer targets, `compile_commands.json`.
- JS/TS: detect `vitest`, `jest`, `node --expose-gc` availability.
- Python: detect `pytest`, `pytest-leaks` only if present.

Do not install dependencies from the hook path.

### Runner Routing

Use a cost router:

1. Static cheap checks always run.
2. Local overlay job runs if:
   - active local agent count is below threshold;
   - recent runtime estimate is below budget;
   - command exists;
   - file/risk profile warrants it.
3. Otherwise record a deferred obligation for Stop/commit/cloud.

Risk escalation examples:

- parser/decoder/serializer changes -> fuzz smoke;
- unsafe/FFI/memory code -> sanitizer/Miri;
- auth/crypto/security paths -> cloud security execution allowed earlier;
- broad public API changes -> full affected-test route.

### Acceptance

- Jobs are evidence-tagged: `measured`, `timed_out`, `tool_missing`,
  `budget_deferred`, `cloud_deferred`.
- Missing tools fail open with clear warning, never fake a pass.
- A timed-out scoped test creates a commit-time obligation rather than silently allowing.
- The same job payload can be sent to the future `SandboxJobRunner`.

---

## 8. Phase B6 - `SandboxJobRunner` RFC and Client Contract

### Goal

Generalize the mutation cloud runner into a job runner that can execute several
deterministic oracle types in an isolated environment. The Interlinked CLI should
define the contract now; the remote Worker/Sandbox implementation can live in the
server-side workstream.

### Current Reality

`src/harness/mutation/cloud-runner.ts` is a daemon-side HTTP client specific to
mutation reports. A checked-in `cloud/mutation-worker/` implementation is not
present in this package. Treat cloud execution as a protocol/client seam in
Interlinked CLI, not as already-shipped server code.

### Proposed Types

New module:

- `src/harness/sandbox-jobs/types.ts`

```typescript
export type SandboxJobKind =
    | "test"
    | "coverage"
    | "mutation"
    | "leak_smoke"
    | "asan_smoke"
    | "miri_smoke"
    | "fuzz_smoke"
    | "adversarial_review";

export interface SandboxJob {
    schemaVersion: 1;
    kind: SandboxJobKind;
    workspaceId?: string;
    sessionId: string;
    cwd: string;
    changeset: ChangeSetPayload;
    timeoutMs: number;
    envPolicy: "minimal" | "test" | "sanitizer";
    selectedTests?: string[];
    riskTier: "trivial" | "lite" | "full";
}

export interface SandboxJobEvent {
    type: "queued" | "started" | "stdout" | "stderr" | "heartbeat" | "result" | "error";
    jobId: string;
    ts: string;
    data?: unknown;
}

export interface SandboxJobResult {
    jobId: string;
    kind: SandboxJobKind;
    ok: boolean;
    verdict: "pass" | "fail" | "inconclusive" | "timed_out";
    durationMs: number;
    findings: unknown[];
    stdoutTail?: string;
    stderrTail?: string;
}
```

Use JSONL streaming for job events. One event per line means partial output is
debuggable even if a Sandbox crashes.

### Client

Add:

- `src/harness/sandbox-jobs/cloud-runner.ts`
- `src/harness/sandbox-jobs/local-runner.ts` only if useful for parity tests

`CloudSandboxJobRunner` responsibilities:

- POST job payload to configured endpoint.
- Include bearer token if configured.
- Stream JSONL if endpoint supports it; otherwise accept final JSON response.
- Enforce timeout with `AbortController`.
- Classify retryable vs nonretryable errors.
- Return `inconclusive`, not pass, on malformed responses.

### Server-Side RFC Requirements

Document for the remote Worker/Sandbox workstream:

- one stable `sandboxId` per `(user, repo)` or per session depending on tier;
- apply `ChangeSetPayload` atomically;
- pin toolchain to repo lockfiles;
- stream JSONL events;
- emit heartbeat every 30s;
- sanitize environment and secrets;
- use egress policy for dependency download and provider access;
- expose cost/duration metadata;
- support idempotency key so retries do not duplicate expensive jobs;
- fail open to the CLI when the cloud is unavailable unless policy says security
  cloud checks are mandatory.

### Acceptance

- Existing mutation cloud runner can be adapted or wrapped without breaking tests.
- Client unit tests cover HTTP 200, HTTP 500, timeout, malformed JSON, malformed JSONL,
  partial stream, and auth header omission.
- No default CLI command depends on a cloud endpoint.

---

## 9. Phase B7 - Tier 3 Split-Context Adversarial Review

### Goal

Fix Tier 3 design before implementation. Bun's review contract is specific:
implementer writes, reviewers see only the diff and assume it is wrong, fixer
applies feedback. The current Tier 3 design feeds the reviewer session trajectory
and asks whether the implementer followed methodology, which contaminates the
review.

### Design Amendment

Update `docs/design/tier-3-async-deep-review.md`:

- Remove session trajectory summary from the default reviewer prompt.
- Keep active prose policies and diff.
- Let reviewers read repo files only when needed to validate a finding.
- Do not include implementer reasoning, plan, or self-assessment.
- Split roles:
  - coordinator;
  - code quality specialist;
  - security specialist;
  - performance/runtime specialist;
  - test/oracle specialist;
  - docs/release specialist if risk tier warrants it.
- Specialist output must be structured XML or JSON findings, not prose.
- Coordinator deduplicates, severity-normalizes, and drops speculative findings.
- Re-runs include prior finding state so resolved findings do not churn.

### Risk Tiers

Adopt a small tier classifier:

| Tier | Trigger | Review shape |
|---|---|---|
| trivial | docs-only or <=10 LOC non-sensitive | 1 generalist, cheap model |
| lite | <=100 LOC, <=20 files, no sensitive paths | 3 specialists |
| full | sensitive path, >100 LOC, >20 files, API/security/runtime changes | coordinator + full specialist set |

Sensitive paths include auth, crypto, tokens, network, parser, serialization,
database migrations, deployment, and harness policy files.

### Prompt Injection Controls

Strip known boundary tags from user-controlled fields before prompt assembly:

- PR descriptions;
- commit messages;
- comments;
- diff text inserted into XML wrappers;
- policy text from workspace files if not trusted.

Keep prompts in files where large, not argv. Stream child-agent JSONL output.

### Acceptance

- Tier 3 design no longer says reviewers receive the implementer's session trajectory by default.
- Warn-only push contract remains unless user explicitly opts into critical blocks.
- The design includes circuit breakers/failback and cost observability.
- The design says "reviewers do not implement; implementers do not review."

---

## 10. Phase B8 - Observability, Promotion, and False-Positive Control

### Goal

Promote checks based on data, not taste. Bun fixed its workflow when agents found
bad loopholes; Interlinked CLI should record check outcomes and promotion evidence.

### Local Metrics

Append local JSONL records under `.interlinked/quality-events.jsonl` or existing
event sinks:

```json
{
    "ts": "2026-07-09T00:00:00.000Z",
    "check_id": "ubs_rust_debug_assert_side_effect",
    "phase": "PostToolUse",
    "severity": "warning",
    "decision": "warn",
    "file_ext": ".rs",
    "duration_ms": 2,
    "suppressed": false,
    "source": "static"
}
```

Do not log file contents. Do not block on telemetry writes.

### Promotion Criteria

Before moving any new heuristic check out of advisory/default-skipped:

- run against this repo with `verify --all-checks`;
- run against at least 10 external repos or a curated fixture corpus if available;
- document false positives and suppression shape;
- add regression tests for every FP fixed;
- update `DEFAULT_ADVISORY_SKIPS` and its tests in the same PR.

Before promoting a warning to block:

- it must be deterministic, not semantic taste;
- it must have a suppression/escape hatch if legitimate code exists;
- it must have at least one post-merge/CI receipt proving it would have caught a real bug or failed test;
- it must not depend on unavailable tools.

### Acceptance

- Each new check has a clear promotion state: advisory, warning, commit-block, or pre-block.
- Default blocking behavior remains zero-FP oriented.
- Metrics are best-effort and local by default.

---

## 11. Detailed PR Breakdown

### PR 1 - Land B0 + Bun Fixture Corpus

Files:

- existing B0 files listed in section 2
- fixture tests under existing `src/harness/checks/ubs-language-specific*.test.ts`
- `docs/external-pulse/bun-in-rust.md`
- this plan

Verification:

- `npx vitest run src/harness/checks/ubs-language-specific.test.ts src/commands/verify/file-checks-ubs.test.ts`
- `npm run typecheck`
- `npm run docs`
- `npm run docs:check`

Acceptance:

- Rust debug assert side-effect class appears in verify output and JSON.
- It is default-skipped/advisory.

### PR 2 - D1 Assertion Side Effects

Files:

- `src/harness/checks/assert-side-effects.ts`
- `src/harness/checks/ubs-language-specific/python-checks.ts`
- `src/harness/checks/ubs-language-specific/java-c-checks.ts`
- registry/metadata/verify/advisory tests

Verification:

- focused tests for new detectors
- `npm run typecheck`
- `npm run docs`

Acceptance:

- C/Python erased assertions are detected.
- Test/source comments and pure assertions do not fire.

### PR 3 - D2/D3 Reinterpret + Placeholder Constants

Files:

- `src/harness/checks/ubs-language-specific/rust-go-checks.ts`
- possible `src/harness/checks/placeholder-constants.ts`
- registry/metadata/verify/advisory tests

Acceptance:

- catches the odd-length `bytemuck::cast_slice` class;
- catches placeholder runtime constants with temporary comments;
- both remain advisory/default-skipped pending audit.

### PR 4 - D4/D5 Parser Boundary + Escape-Hatch Span

Files:

- `src/harness/checks/ubs-language-specific/cross-language-checks.ts`
- `src/harness/checks/ubs-language-specific/rust-go-checks.ts`
- registry/metadata/verify/advisory tests

Acceptance:

- detects direct template-to-parser shapes;
- does not duplicate SQL/shell/eval detectors;
- reports broad Rust unsafe spans separately from mere unsafe existence.

### PR 5 - Test Oracle Baseline

Files:

- new `src/harness/checks/test-oracle-baseline.ts`
- language scanners/tests
- verify output wiring
- baseline integrity constants/tests
- docs/generated after `npm run docs`

Acceptance:

- net deleted/skipped/focused tests are reported across JS/Python/Rust/Go.
- baseline updates are visible and protected.
- no default hard block until dogfood.

### PR 6 - Cohort Git Discipline

Files:

- `src/harness/types/rules.ts` if predicate typing needs refinement
- `src/harness/evaluator/rule-matching.ts`
- `src/harness/rules/builtin-rules-*.ts`
- `src/harness/reservations.ts` and evaluator consumer
- guard/rule/reservation tests
- docs/generated guard rules

Acceptance:

- multi-agent-only git rules fire.
- local reservation conflicts block under multi-agent conditions.
- single-agent workflow remains mostly unchanged.

### PR 7 - Overlay Command Runner Spike

Files:

- `src/harness/overlay-command-runner.ts`
- tests
- optional CLI/debug entry under `src/commands/verify-changeset.ts` or a new hidden command
- measurement note under `docs/design/` or append to this plan

Acceptance:

- generic runner works over proposed-edit overlay.
- p50/p99 numbers are recorded.
- no default arbitrary command execution.

### PR 8 - Runtime Oracle Job Router

Files:

- `src/harness/runtime-oracle-jobs.ts`
- `src/harness/runtime-oracle-discovery.ts`
- config defaults
- verify/dynamic surface
- tests

Acceptance:

- leak/sanitizer/fuzz smoke jobs can be planned and either run locally or record a deferred obligation.
- missing tools never fake success.

### PR 9 - SandboxJobRunner Client RFC

Files:

- `src/harness/sandbox-jobs/types.ts`
- `src/harness/sandbox-jobs/cloud-runner.ts`
- tests
- docs/design RFC

Acceptance:

- mutation runner can migrate toward the generic job contract.
- remote server workstream receives a stable payload/result spec.

### PR 10 - Tier 3 Design Amendment

Files:

- `docs/design/tier-3-async-deep-review.md`
- optionally `docs/design/multi-agent-pre-push-review.md` if terminology must align

Acceptance:

- reviewers get diff + policy, not implementer trajectory.
- coordinator/specialist/risk-tier/circuit-breaker/JSONL streaming design is explicit.

---

## 12. Rejected or Deferred Ideas

Reject for now:

- **Default-blocking pre-push AI review.** The current Tier 3 stance remains
  warn-only by default. Blocking push creates the wrong pressure and has an
  obvious `--no-verify` bypass.
- **Executing synthesized property tests on the edit path.** Run the repo's real
  tests under instrumentation instead. Generated property tests can be suggestions
  or scheduled cloud work, not synchronous hot-path execution.
- **Paragraph-length comment smell as a generic check.** Rust `SAFETY:` comments
  are a required good practice. If this becomes a check, make it non-Rust,
  advisory, and keyed on workaround language rather than length.
- **Global ban on slow commands.** Bun's rewrite fleet needed "no cargo" because
  64 agents saturated disk/CPU. Interlinked CLI should use resource-aware routing,
  not a universal ban.

Deferred:

- Cloud Sandbox server implementation in this package. Interlinked CLI should
  define client contracts; Worker/Sandbox implementation belongs in the remote
  server workstream unless the repo structure changes.
- Full fuzz campaign automation. Start with bounded smoke and fixture replay.
- Automatic fix PRs for fuzz findings. Humans should review generated fixes.

---

## 13. Definition of Done for the Whole Program

The Bun-inspired program is successful when:

1. The four named Bun porting regressions are represented by permanent fixtures.
2. At least three new detector classes ship with metadata, verify output, docs,
   and advisory tests.
3. Test deletion/skip/focus drift is ratcheted against a baseline and visible in
   `interlinked verify`.
4. Multi-agent local sessions block unsafe git/stash/stage/commit operations that
   single-agent sessions can still perform safely.
5. A generic overlay command runner has measured p50/p99 cost on this repo.
6. At least one runtime oracle job can run against proposed content without
   writing it to disk.
7. `SandboxJobRunner` has a stable typed contract and JSONL event stream.
8. Tier 3 design uses split-context adversarial review.
9. No new default pre-block violates the zero-FP contract.

---

## 14. Command Checklist by PR Type

Static detector PRs:

```bash
npm run typecheck
npx vitest run src/harness/checks/ubs-language-specific.test.ts src/commands/verify/file-checks-ubs.test.ts
npm run docs
npm run docs:check
```

Rule PRs:

```bash
npm run typecheck
npx vitest run src/harness/rules src/harness/__tests__/guard-corpus.test.ts src/harness/__tests__/command-guard-parity.test.ts
npm run docs
npm run docs:check
```

Test-oracle PRs:

```bash
npm run typecheck
npx vitest run src/harness/checks src/commands/verify src/harness/verification-stop-checks.test.ts
npm run docs
npm run docs:check
```

Runner/cloud-contract PRs:

```bash
npm run typecheck
npx vitest run src/harness/coverage-overlay.test.ts src/harness/coverage-overlay.integration.test.ts src/harness/mutation
npm run test
```

Full release candidate:

```bash
npm run typecheck
npm run test
npm run docs
npm run docs:check
```
