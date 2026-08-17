# Equivalent-mutant handling — and how to do it locally

Status: design exploration, 2026-08-11. Companion to
`per-edit-cloud-mutation-testing.md` (the per-edit gate), `local-gate-catalog.md`
(entry 15, sampled local mutation), and `agent-terraforming-checks.md` (the
metric-as-source-pressure pattern). Motivated by the 2026-08-11 survivor-kill
campaign: waves 1–4 produced **4,529 claimed kills + 489 proven-equivalents
across 32 files** — the equivalents were ~10% of the touched mutant mass, and
every wave spent real agent tokens *proving* them by fuzzing.

## The reframe: equivalents are mostly dead defensive code

Look at *what* the 489 equivalents were, not just how many. Across the wave
reports the classes repeat, and they are almost all **one thing** — code that
executes but whose specific form has no observable consequence, because
something upstream or downstream already guarantees the condition:

| Class | Real example (from the campaign) | Why equivalent |
|---|---|---|
| Redundant idempotent call | `x.trim().trim()` (caller and callee both trim) | `X.trim().trim() === X.trim()` |
| Dead guard implied downstream | `!cmd` / `!filePath` / `!plan` guards | the empty value "never reaches the verb/URL/sensitivity regex anyway" |
| Optional chain on type-forced value | `?.file`, `plan?.steps` | array non-empty by a preceding length guard; `plan` always defined at its one call site |
| Loop-invariant boundary | `i+1 < length` under the loop's own `i < length` | tautologically true (the inverted `>=` variant WAS killed — distinct subclass) |
| Out-of-bounds guard matching nothing | `content[length]` (always `undefined`), `i <= length` | `undefined` matches no comparison branch |
| Trailing guard after exhaustive partition | `oracleSet.length > 0` after four early-return branches | the branches partition every empty/nonempty permutation; the operand's truth is already forced |
| Unreached sentinel fallback | `""` → `"Stryker was here!"` | never reaches a verb/URL regex |
| Boolean-invariant arithmetic | `+` used only inside `.test()` | the numeric change can't affect a boolean result |
| Downstream-nulling atoms | 30 bracket-depth atoms in `gitignored-write` | `resolvePathArg` nulls the whole call the instant any segment isn't a clean literal, so *where* mistracked depth splits is irrelevant |

**This reframes the entire question.** A true equivalent is *unkillable by
definition* — no test can distinguish two programs with identical observable
behavior — so **"write better tests" is the weakest lever.** You reduce
equivalents by:
1. **Not generating them** (strip the dead defense, or exclude legitimate
   defense from mutation), and
2. **Classifying them correctly** — *prove* equivalence deterministically
   instead of fuzz-*guessing* it, because **a mislabeled equivalent is a real
   test gap wearing a disguise** (the `gitignored-write` 48/116 rate is the
   yellow flag).

And a high equivalent-rate on a function is a **signal**, not just noise: it
means the source carries redundant defensive cruft — the same accretion the
complexity and cognitive caps already push against.

## The four levers (general form)

### Lever 1 — Engine: compiler-equivalence pre-filter (Trivial Compiler Equivalence)
Before running a single test on a mutant, compile the original and the mutant
and compare the optimized output. If identical, the mutant is **provably**
equivalent — filter it, never run it, never count it as a survivor. This is the
single highest-leverage move: deterministic, ground-truth, and it **replaces
fuzz-guessing with proof**, closing the mislabel risk. It would have
auto-classified a large fraction of the 489 (double-trim, boolean-invariant `+`,
every dead guard DCE strips identically).

### Lever 2 — Source/architecture: flag dead defensive code, validate once
The dominant class is redundant guards, and most are *statically detectable* —
a condition always-true or always-null given the types (the
`no-unnecessary-condition` class). Adopt it as a check and you attack the
equivalents **at the source**: strip the guard, and there is nothing to mutate.
It is the same discipline `unvalidated_json_boundary` already pushes —
validate *once* at the boundary, then trust the type; the redundant `!cmd` /
`?.file` guards exist because the code re-validates what its types already
guarantee. Exhaustive discriminated unions (with a `never` check) turn the
"trailing guard after exhaustive partition" class into flagged dead branches.
Bonus: every dead guard removed is also a cyclomatic/cognitive win.

### Lever 3 — Testing/adjudication: raise the equivalence-*proof* bar
Tests cannot kill a true equivalent, so this lever is about **catching
mislabels**, not lowering the count. Use Lever 1 as ground truth where it
applies; route high-equivalent-rate files through the reviewed `interlinked
mutation accept` path (the repo already refuses argument-only equivalence per
`feedback_prove_equivalence_empirically`); and have a property test try once
more — some "equivalents" are stubborn-but-killable (the agents already showed
boundary mutants unreachable via `.fn()` die to direct property assertions, and
`fast-check` kills a class example tests miss — see the `property_test_candidate`
check).

### Lever 4 — Ratchet: equivalent-density as a terraforming metric
Track **equivalents-per-function**, shrink-only under `baseline_integrity_gate`.
A rising density means accreting dead defense; ratcheting it down pressures the
architecture toward validate-once / total-functions — the same flywheel as the
line and complexity caps. This is the "architecture the harness enforces"
answer: it converts today's noise into a legible source-quality signal.

## Doing it locally

The cloud runner is not required for most of this. The compiler-equivalence idea
maps directly onto the TS toolchain interlinked **already loads** (the
`typescript` optionalDependency the AST-accurate complexity gate parses with),
so a large fraction of equivalents can be classified locally, deterministically,
in milliseconds — no runner round-trip.

### Local TCE, tier 1 — esbuild/terser byte-compare (the free subset)
Transform the original and the mutant with an aggressive local minifier
(`esbuild --minify` or `terser` with DCE + constant folding) and compare the
emitted bytes. Identical output ⇒ provably equivalent. Cost ≈ 1–5 ms/mutant
(esbuild is native-fast), fully local, deterministic. **Catches:** dead branches
under constant conditions, unreachable code, constant-folded arithmetic (the
boolean-invariant `+` after folding), some sentinel-fallback cases. **Misses:**
anything needing semantic reasoning about a runtime call — a JS optimizer won't
prove `trim().trim() === trim()` because it can't assume `trim` is
side-effect-free. So tier 1 is a *free partial* — it clears the syntactic subset
for zero marginal infra.

### Local TCE, tier 2 — type-informed AST normalization (the interlinked-native power move)
Parse original and mutant with the TS compiler API (already resident) and, using
`ts.TypeChecker`, normalize before comparing:
- **Constant-fold** conditions whose static type is a literal / always-truthy /
  always-nullish, and **delete provably-dead branches** (condition type `false`
  / `never`).
- **Strip optional chaining** where the receiver type excludes `null | undefined`
  — this kills the `?.file` / `plan?.steps` class that tier 1 can't see, because
  the equivalence lives in the *types*, not the emitted JS.
- **Collapse known-idempotent chains** (`trim().trim()`, `toLowerCase()` twice)
  via a small allow-list of idempotent string ops.

Then compare the normalized ASTs structurally. This catches the **type-forced**
classes esbuild can't. It needs the type checker, so it runs at PostToolUse /
verify cadence, not the hot-path regex budget — but it can **piggyback on the
parse the complexity gate already pays for** (the `complexity-pulse` "reuse the
already-paid parse" pattern), so the marginal cost is the normalization pass, not
a second full parse.

### Local prevention — the redundant-guard check (stop the equivalent being born)
The same `ts.TypeChecker` machinery, pointed at the *source* instead of a mutant,
is a `no-unnecessary-condition`-class check: flag a guard whose condition is
always-true / always-null. Fixing the finding removes the guard, so the
equivalent is **never generated** — the cheapest possible reduction, and it lands
as an ordinary local check (verify cadence; PostToolUse for the incremental
subset). Implementation choice: use the TS compiler API directly (interlinked
already depends on it — no new dep) rather than importing `typescript-eslint`
(which the intake dependency filter would penalize). Biome/oxlint are adding
type-aware equivalents; shelling to one is the invoke-as-subprocess fallback.

### Reuse the existing `astΔ` primitive
interlinked already computes `astΔ` — the AST semantic-delta on each edit ("a
rename is astΔ 0; a rewritten conditional is not"). Equivalent-mutant detection
is *the same primitive pointed at a mutant*: a mutant whose normalized
`astΔ(original, mutant) == 0` is structurally equivalent. The per-edit pulse
already emits `astΔ`, so the foundation is shipped — tier-2 TCE is astΔ plus the
type-normalization passes above.

### Local mutation-exclude markers (honest about defense-in-depth)
For guards you deliberately **keep** — security-critical taint checks, boundary
defense-in-depth whose "unreachability" rests on assumptions a future edit could
break — honor a `// Stryker disable`-class / `// interlinked-mutation-exclude`
marker in the mutant generator so they produce no survivor you will never kill.
Purely local (it is a filter in generation), and honest about what is
untestable-by-design rather than hand-killing or deleting real insurance.

### Local equivalent-density ratchet
Once classification is local (tiers 1–2), the per-function equivalent-density
metric is computable locally and ratchets through the same committed-baseline
mechanism as coverage/complexity — no cloud, same `baseline_integrity_gate`
protection.

### Local sampled mutation gets cleaner for free
`local-gate-catalog.md` entry 15 (sampled local mutation: ~20 random mutants,
Wilson interval) gains a **free equivalence pre-filter** from tier-1 TCE: filter
the provable equivalents before running tests, and the degraded-mode local
kill-rate excludes them — a more accurate confidence interval at zero extra cost.

### What stays non-local (the honest tail)
Some equivalents need **whole-program** reasoning: the 30 bracket-depth atoms are
equivalent only because `resolvePathArg`'s behavior three calls away nulls the
result. Local static normalization (single-function AST) can't prove that; it
stays in the fuzz + `mutation accept` review path. So local TCE is a
**high-value partial** — it deterministically classifies the syntactic and
type-forced majority for free, and leaves the whole-program-semantic tail to the
existing (now smaller, better-flagged) manual path.

## The essential nuance — strip vs exclude vs keep

Do **not** strip every guard. A `!cmd` guard on a security-critical taint path is
cheap defense-in-depth even when "provably" unreachable, because the proof rests
on assumptions a future edit can break. Split the response by **location**:
- **Pure computation** (parsers, scorers, formatters): strip the redundant guard
  — Lever 2 flags it, removing it is a complexity win, and the equivalent
  vanishes.
- **Trust boundary / security path**: keep the guard, but **mutation-exclude** it
  (don't try to kill, don't count) — the local marker above.
- **Never** let the goal of "fewer equivalents" delete real insurance, and
  **never** accept a fuzz-proven equivalent on a security path without the
  reviewed accept path — a mislabel there is a silenced test gap on exactly the
  code that most needs one.

## Build order

1. **Tier-1 local TCE (esbuild byte-compare)** — smallest, deterministic, free
   subset; wire it as a pre-filter in the mutant pipeline (local + cloud runner
   both). Turns a chunk of fuzz-guesses into proofs immediately.
2. **Redundant-guard check (Lever 2, prevention)** — via `ts.TypeChecker`, verify
   cadence; the source-side attack, reuses the resident compiler.
3. **Tier-2 type-AST TCE** — normalization passes over the complexity gate's
   existing parse; catches the type-forced classes; folds into the `astΔ`
   primitive.
4. **Mutation-exclude markers** + **equivalent-density ratchet** — once
   classification is trustworthy, make the density a shrink-only metric.
5. **Adjudication hardening** — high-density files auto-route to `mutation
   accept` / a property-test second attempt.

## Cross-references
- `per-edit-cloud-mutation-testing.md` — the gate this feeds; the pre-filter runs
  before the runner round-trip.
- `local-gate-catalog.md` #15 (sampled local mutation), #14 (empirical complexity
  fitting — same "run it locally, don't guess" spirit).
- `agent-terraforming-checks.md` — equivalent-density is a terraforming metric;
  redundant-guard removal raises regenerability.
- `feedback_prove_equivalence_empirically` (memory) — the existing doctrine; TCE
  is the deterministic upgrade of "patch the mutant, run the suite."
- `unvalidated_json_boundary` check — the validate-once discipline whose dual
  (don't re-validate downstream) removes the guards that become equivalents.
