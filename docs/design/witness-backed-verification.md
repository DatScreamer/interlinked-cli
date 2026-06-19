# Witness-backed verification — porting ArbiterSec's analysis tactics to the harness

- **Date:** 2026-06-12. **Status:** design exploration (nothing built).
- **Sources:** `docs/external-pulse/arbitersec.md` (closed flagship pair, 2026-05-21),
  `docs/external-pulse/narsil-mcp.md` (open substrate quarry, 2026-05-15; both
  re-checked 2026-06-12 — no upstream changes), narsil-mcp v1.7.0 source read,
  Claude Code hooks reference (`code.claude.com/docs/en/hooks`).
- **Question answered:** can Aletheia's "lower → analyze → executable witness"
  pipeline detect (and correct) incorrectly-written agent code at PreToolUse /
  PostToolUse / trajectory / Stop — using eval, WASM, or dynamic worker loaders —
  blocking as early as possible?

## 1. Corrected premise

Aletheia does not convert source code to C. It **decompiles compiled binaries**
(PE/ELF/Mach-O → disassembly → 43-opcode SSA IR → typed-C emission), then runs
taint/CWE scanners over that IR and ships a concrete witness (Z3 concolic input,
"here are the bytes, run them yourself") with every finding. All of that is
vendor-claimed — the product is closed-source. The transferable part is not the
decompiler; for source-language agent code we already *have* typed front-ends
(`typescript` is our SSA-equivalent substrate for TS; mypy for Python). The
transferable parts are:

1. **The witness discipline** — a finding's severity is earned by a replayable
   proof, not asserted by the check's confidence.
2. **Per-function CFG/DFG bug hunting** — narsil's open implementation
   (`dfg.rs:1003,1021,1039`: `find_dead_stores`, `find_uninitialized_vars`,
   `find_use_after_move`; `cfg.rs:287`: `find_unreachable_blocks`) is the
   source-code analog of Aletheia's binary memory-safety hunting.
3. **The `ControlFlow` declarative rule kind** — "operation A must precede
   sink B" (`security_rules.rs:475`), a check *kind* we don't have.

The delta vs. our `[proven]`/`[heuristic]` tags: **we tag the provenance of the
CHECK** ("a compiler ran"); **Aletheia proves the FINDING** ("this input
triggers this bug"). A witness is a *promotion mechanism* from heuristic to
proven — which is exactly the lever our advisory tier lacks (advisory checks
are advisory *because* we can't separate TP from FP statically; executing a
candidate witness separates them dynamically and deterministically).

## 2. Mechanism inventory, routed to the earliest blocking surface

"Block earliest possible" routing. The hard ceiling is the client hook timeout
(60s default on Claude Code); the real constraints are our own budgets — INTAKE
per-edit classes (300ms read / 800ms modify / 2s side-effect), the in-band
cloud window (~25s, `feedback_pretooluse_cloud_synchronous_block`), and
PostToolUse-stays-sync (`feedback_posttooluse_stays_sync`).

| # | Mechanism | Earliest surface | Marginal cost | Tier |
|---|---|---|---|---|
| W1 | Overlay-run runtime observers | PreToolUse (rides the existing coverage gate; budget router → commit gate) | ~0 (parse output we already generate) | warn → promotable |
| W2 | Per-function dataflow trio on the paid parse | PreToolUse pre_warn | ~ms (one extra visitor) | advisory |
| W3 | `required_before` → `sink` rule kind | PreToolUse pre_warn | ~ms (regex) | advisory |
| W4 | Witness-escalation executor | commit gate / `verify` now; per-edit later for sub-300ms cases | 100–300ms per candidate | promotes advisory → [proven] |
| W5 | Cloud witness fan-out (worker loaders / sandboxes / symbolic) | PreToolUse in-band (≤25s, P2–3) and Tier-3 deep review (P4–5) | cloud | blocking (security class) |
| W6 | Deterministic correction | PreToolUse (`updatedInput` on Claude Code; block-and-answer everywhere) | reuses W1–W3 findings | fix |

### W1 — instrument the dynamic-execution lane we already have

The per-edit coverage gate (`evaluator/coverage-write-guard.ts`) already
executes the agent's proposed code **before it lands on disk**: apply-before-
disk overlay + the project's full suite via an async-spawned `CoverageRunner`
(`coverage-runner.ts`), consuming today only the coverage report + `suiteMs` +
exit-code `testsPassed`. That run is a free sanitizer harness we're not
reading:

- **Unhandled errors** — vitest prints an "Unhandled Errors" section and fails
  the run; pytest surfaces `PytestUnraisableExceptionWarning`. Parse, attribute
  to the edited file via the overlay diff.
- **Leaked handles** — vitest `--reporter=hanging-process`, jest
  `--detectOpenHandles`: the JS-world analog of "memory leak" findings.
- **Heap growth** — vitest `--logHeapUsage` per-test deltas; flag monotonic
  growth in tests covering the edited file.

The **witness** is the failing/observing test itself: every finding carries a
replayable command (`npx vitest run <file> -t '<name>'`). Flake guard: report
only on 2× reproduction (same lesson as `feedback_ci_macos_slow_test_timeout`).
Big-suite repos get this at the commit gate via the existing obligation router
— same policy, relocated enforcement.

### W2 — dataflow trio riding the cyclomatic gate's paid parse

`complexity-write-guard.ts` already parses before- and after-content of every
gated Write/Edit with the real `typescript` AST (the pulse observer in
`evaluator/complexity-pulse.ts` proves the stash-and-reuse pattern). Add one
visitor to that same walk, scoped to **changed functions only** (diff-aware by
construction):

- **Dead stores** — assignment overwritten before any read. tsc's
  `noUnusedLocals` only catches never-read *declarations*; the store-level
  version is narsil's `find_dead_stores`. High-signal for agent code: a dead
  store is usually a half-applied edit (the agent assigned the old way AND the
  new way).
- **Unreachable-after-terminator** — statements after `return`/`throw`/a
  `never`-returning call, beyond what `allowUnreachableCode` flags.
- `find_use_after_move` has no JS analog (Rust move semantics); the loose
  equivalent — use-after-close/dispose — stays in the existing lifecycle
  family.

TS-only first, zero new deps. tsc/mypy already own use-before-assign — don't
rebuild type inference (narsil intake §9 verdict stands). For polyglot breadth
(bash/go/ruby…), the road is either narsil-as-subprocess (Tier 3, RFC #2 in the
narsil intake) or a `web-tree-sitter` optionalDependency (RFC-level — same
precedent as `typescript`, but it's a dep decision, not a default).

### W3 — `required_before`/`sink` declarative rule kind

Narsil's evaluator (`security_rules.rs:1027`) is ~40 lines: regex sink match on
line N, require any `required_before` pattern on a line < N, else finding
(Confidence::Medium). Port it **function-scoped** (we have the AST; narsil is
file-scoped — ours would FP less than the original), into the declarative
content-check format already RFC'd in the narsil intake. Catches the
"incorrectly written agent code" ordering class: validate-before-use,
permission-check-before-write, lock-before-mutate. Heuristic by nature —
pre_warn/advisory, never pre_block (Medium confidence ≠ zero-FP, per the phase
contract in `check-registry/types.ts`).

### W4 — witness-escalation executor (the genuinely new capability)

For advisory findings with known FP pain (`ubs_division_by_variable` is the
canonical case — flags every guarded `x / y`), attempt to **construct and
execute a concrete witness**:

1. Candidate population: changed functions that are export-reachable and
   pure-ish (no fs/net/process identifiers in body — we already classify
   sinks).
2. Input generation, fully deterministic: boundary set (`0, -1, NaN, "",
   null, undefined, [], {}`) ∪ literals harvested from the function's own
   guards. No LLM, no randomness (`feedback_harness_deterministic_only`).
3. Execution: spawn-isolated `node` subprocess **importing from the existing
   overlay** (so imports resolve against proposed content), hard timeout. Trust
   argument: this code was about to be executed by the test suite anyway —
   same trust class, same isolation mechanism (subprocess), no new boundary
   claim (`feedback_local_checks_not_a_trust_boundary` still holds; local
   execution is verification, not security).
4. Verdict: witness triggers the predicted failure → finding **promotes to
   `[proven]` + blocking**, message carries the input vector (replayable). No
   witness → stays advisory, never silently dropped (taste levers stay loud).

Hard constraint discovered by dogfooding: **no in-daemon eval.** Our own
registry pre_block-errors `eval()`/`new Function`
(`check-registry/entries-errors.ts:85`) and treats `vm.run*` as a privileged
sink (`checks/tainted-sink.ts`). The executor must be subprocess-spawn (the
pattern `coverage-runner.ts` already establishes) — anything else fails our own
gate the moment we write it. Placement: commit gate / `verify --all-checks`
first; per-edit only for candidates measured < 300ms.

### W5 — where eval / WASM / worker loaders actually land

- **In-daemon JS eval:** rejected (see W4). Not a real boundary, and our own
  pre_block forbids it.
- **WASM, two distinct roles.** (a) *Analyzer substrate*: narsil's `wasm.rs`
  ships parsing/symbols/search compiled to WASM — proof the approach works,
  but its CFG/DFG/security layers are **not** in that build, so "use narsil's
  WASM" buys less than it sounds; a `web-tree-sitter` optionalDependency is
  the honest version of this idea (RFC). (b) *Execution sandbox*:
  `quickjs-emscripten` gives hard-isolated, memory-capped, interruptible JS —
  right for pure-function witnesses, wrong for anything importing node
  builtins. Both are optionalDependency-class decisions (the `typescript`
  precedent), not defaults.
- **Dynamic worker loaders (Cloudflare):** the strong home for the full
  Aletheia shape. Per edit, load the changed module into ephemeral isolates
  and run the witness battery + heavier analyses **concurrently** — wall-clock
  ≈ one run, inside the ~25s in-band window (the
  `project_maximal_local_enforcement` fan-out model). Z3/concolic and any
  LLM-guided input search are cloud-only fodder (lane 5) — never local.
  Sandboxes (VM-grade) cover node-fidelity suite runs (P4–5).

### W6 — the "correct" half

Verified against current Claude Code hooks docs: PreToolUse supports
`updatedInput` (with `permissionDecision: "allow"`) — the tool executes with
rewritten args; PostToolUse supports `updatedToolOutput`. Two correction modes,
in preference order:

1. **Block-and-answer** (default; the `grep-accelerator.ts` precedent): deny +
   reason carries the corrected snippet/diff; the agent re-issues. The agent
   *sees* the correction — consistent with the reflection-not-pushing stance,
   and it works on every client.
2. **Silent rewrite via `updatedInput`** (narrow): ONLY formatter-grade,
   provably semantics-preserving transforms (the class a formatter would apply
   anyway), ALWAYS paired with `additionalContext` disclosing the rewrite —
   an undisclosed rewrite desyncs the agent's model of file content and its
   next `Edit.old_string` fails. Claude-Code-only today (gate via the client
   capability registry, `project_copilot_cursor_status`); docs warn multiple
   input-modifying hooks race last-wins — keep exactly one.

Semantic fixes (adding `await`, reordering, guard insertion) are never silent:
they go through mode 1 so the agent owns the change.

## 3. Explicitly not ported

- The SSA decompiler / typed-C emission — wrong substrate; tsc/mypy *are* the
  typed front-ends for source languages. Lowering JS to C would discard the
  type information we already get for free.
- Local Z3 / symbolic execution — permanent dep weight, cloud-shaped work.
- LLM-guided fuzzing ("Polychrome", hybrid-fuzz search) — determinism rule;
  cloud-advisory at most.
- Narsil's 90-tool MCP surface, presets, SPARQL/RDF, neural embeddings —
  re-affirmed from the intake's lane-6 list.
- File-scoped `ControlFlow` as a blocking check — Medium confidence routes to
  advisory; pre_block stays zero-FP-only.

## 4. Spike order (each ≤1 day)

1. **W1-a:** parse vitest "Unhandled Errors" + red-bar attribution from the
   overlay run we already execute; warning carries the replay command. (~½ day)
2. **W3:** function-scoped `required_before`/`sink` rule kind (fold into the
   declarative content-check RFC; seed rules from narsil's `rules/*.yaml`
   ControlFlow entries). (~½ day)
3. **W2:** dead-store + unreachable-after-terminator visitor on the
   complexity gate's walk, changed-functions-only, advisory, ≥3 pos/≥3 neg
   fixtures. (~1 day)
4. **W1-b:** `--logHeapUsage` / hanging-process observers behind a config
   flag. (~½ day)
5. **W6:** block-and-answer corrected-content for formatter-grade findings.
   (~1 day)
6. **W4:** witness-escalation executor at the commit gate — RFC first, then
   build. **W5:** fold into the Tier-2/Tier-3 design docs as the witness
   fan-out section.

## Notes

- Third convergence sighting: Aletheia's "differential validation against a
  Unicorn oracle — every lifted instruction validated against ground truth" is
  the same predict-vs-oracle shape as our shipped predict/reveal/reconcile
  protocol (after ECHO and Devin). The pattern keeps being independently
  derived; it's the right abstraction.
- The arbitersec intake's lane-4(a) call ("witness discipline is already
  ours") was half-right and is amended in that file: provenance tagging ≠
  finding-level witnesses. This doc is the gap-closing design.
- Dogfood warning for implementers: W4's executor and W6's rewriter are
  exactly the shapes our own guards exist to catch (dynamic execution,
  tool-input mutation). Write them spawn-based and disclosure-first, or the
  harness will — correctly — flag its own code.
