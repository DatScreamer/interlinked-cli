# Survivor Elimination Campaign — whole-codebase mutation hardening

**Status: BACKGROUND / LOW PRIORITY — do not run this campaign unless explicitly
asked.** (Set 2026-08-07 by the user: *"it's really a background project, not
something I want to spend a ton of tokens fixing yet, and not a super urgent
priority."*) Specifically: **do not spawn parallel agent fleets for this.** The
mechanics below are sound and stay documented for whenever the work resumes; it
is the *cadence and cost* that changed, not the method.

Two things a cold agent should know before touching this:

1. **The per-edit gate supersedes the campaign as the priority.** Keeping NEW
   edits clean is what the harness is for (see CLAUDE.md, "What this is for");
   retroactively cleaning this tree is housekeeping on an already-atypical
   codebase. As of 2026-08-07 the gate scopes source edits to the diff and
   judges test edits by the survivor delta they produce.
2. **"Unjustified survivors to zero" is currently unreachable by construction.**
   `mutation accept` refuses every equivalence claim lacking a verifier-issued
   certificate and nothing in the CLI can mint one, so a survivor's only
   recordable end-states are *killed* or *unjustified* — the unjustified count
   can never fall below the survivor count. `src/commands/mutation-disposition.ts`
   exists to expose `recordDisposition` (`dead_code` / `unresolved`, neither of
   which needs a certificate) but is **not yet wired into the registrar**. Wire
   that before promising anyone a zero.

Originally: the plan for using the shipped per-edit gate to eliminate surviving
mutants across the entire codebase, one file at a time.

Companion documents: `docs/plans/10-mutation-testing.md` (why mutation testing,
phased rollout), `docs/design/per-edit-cloud-mutation-testing.md` (the gate's
architecture), `docs/design/per-edit-mutation-identity-and-manifest.md` (stable
mutant identity + manifest model). Read this one to *do the work*; read those to
understand the machinery.

**Umbrella roadmap: `docs/plans/16-monotonic-quality-enforcement.md`.** This
campaign is the tactical layer under it. Plan 16 covers the surrounding program —
the three-tier verification budget, typed survivor dispositions (which supersede
the free-text `accepted_reason` used in §5 here), property/fuzz/negative-boundary
verifiers, authority separation for accepts, anti-gaming trajectory rules, and
the conformance-suite endgame that makes mutation score double as a portability
metric. Every gap listed in §9 below is tracked there with a build order. Read
plan 16 first if you are deciding *what to build*; read this one if you are
*killing mutants today*.

## TL;DR for an agent picking this up cold

1. Pick one unmeasured/worst file from the work list (§6). Claim it (§7).
2. Read its survivors out of the manifest (§3). Understand what each proves.
3. Write tests that kill them — in the file's companion test file. The per-edit
   gate measures automatically when you edit; it blocks on NEW survivors.
4. Re-read survivors. Repeat until the remaining ones are genuinely unkillable.
5. Annotate only those as equivalent, one at a time, with a real reason (§5).
6. Run the file's tests bare, record the result, report the before/after count.

**Sequencing warning — read before a large push.** Every per-file count in §6 is
a **floor**, not a total: the manifest silently omits mutants that do not anchor
to a function symbol (§9, and the design note in plan 16's build-order section).
Landing that identity fix changes the denominator for many files. For a handful
of units the drift is harmless — measure live (§4a) and proceed. Before
committing a fleet of agents to the work list, land the identity fix and
re-sweep first, or you will harden files against undercounted baselines and
re-derive every number afterward anyway.

**The prime directive:** a surviving mutant means *a behavior no test checks*.
The fix is almost always a better test — not a weaker gate, not an annotation,
not deleting the code. You may never lower a water-line to make a gate pass
(`.interlinked/*baseline*.json`, `metric-caps.json`); the baseline-integrity
gate blocks it and doing it is the canonical gate-gaming move.

## 1. Why this campaign exists

Coverage says a line *ran*. Mutation says a line was *checked*. This repo sits at
**~71% mutation score with ~25k surviving mutants across ~735 measured files** —
and the worst offenders are the harness's own guard rules, security classifiers,
and check detectors. That is the inversion this campaign fixes: the code that
enforces quality everywhere else is the least verified code in the tree.

The flywheel: every killed mutant is a test that will catch a real regression;
every test added raises the file's floor, and the gate then enforces that floor
against all future edits, including by other agents. The work compounds.

## 2. Preconditions (verify before starting)

```bash
interlinked harness status          # daemon must be running
interlinked caps                    # effective caps + provenance
npx vitest run <one test file>      # the runner works
```

The per-edit mutation gate must be enabled with at least one reachable runner
endpoint. Configuration lives in `.interlinked/guard-rules.local.json`
(gitignored — machine-local runner endpoints and credentials never belong in
committed policy):

```json
{
  "per_edit_mutation": {
    "enabled": true,
    "mode": "block",
    "unavailable_behavior": "allow_unmeasured",
    "budget_ms": 30000,
    "harvest_budget_ms": 25000,
    "runner_url": "http://127.0.0.1:8790/"
  }
}
```

`runner_urls: []` may list additional endpoints; several runners shard the
measured file into line ranges to cut wall-clock. Endpoint count is a local
performance detail and has no effect on the survivor invariant.

**If the gate reports `[mutation:not-measured]`, that is NOT a pass.** Check
runner reachability and test selection before proceeding; a file you cannot
measure is a file you cannot harden.

## 3. Reading the survivors for a file

> **The manifest is a SNAPSHOT, not a live view.** It changes only when a
> measured pass persists it. Reading it tells you where a file stood at its last
> measurement — it will NOT reflect tests you just wrote. To get a fresh count
> you must re-measure (§4a). Reporting manifest numbers as an "after" count is a
> false claim.

The live gate's state is `.interlinked/mutation-manifest.json` (machine-local,
gitignored, regenerable). To list a file's survivors:

```bash
node -e "
const {readFileSync}=require('fs');
const f=process.argv[1];
const m=JSON.parse(readFileSync('.interlinked/mutation-manifest.json','utf8'));
const syms=m.files[f]||{};
let n=0;
for(const s of Object.values(syms))
  for(const [id,mu] of Object.entries(s.mutants))
    if(mu.status==='survived'){n++;console.log(id, s.qualifiedName, mu.mutator, JSON.stringify(mu.originalLexeme),'->',JSON.stringify(mu.replacement));}
console.log('survivors:', n);
" src/path/to/file.ts
```

Each row is a claim: *"this token could be changed to that, and your whole test
suite would still pass."* Read it as a bug report about the tests.

## 4. The per-file unit — protocol and definition of done

One file per unit. Small, self-contained, independently verifiable; the tree
stays committable after each.

1. **Measure/read** the file's survivors (§3). Record the starting count.
2. **Classify** each survivor:
   - *killable* → a test asserting the behavior the mutant changes. The default.
   - *dead code* → the mutant survives because nothing needs the code. Delete
     the code (with justification), don't test it.
   - *genuinely equivalent* → no observable behavior differs. Rare (§5).
3. **Write the tests** in the companion test file (`<name>.test.ts`). Label them
   in the repo's MUST-FIRE / MUST-NOT-FIRE convention where the file is a
   detector — the same cases also satisfy the Check Evidence Contract, so a
   single effort advances the mutation score and the evidence contract together.
4. **Know what the gate does and does not cover.** The per-edit mutation gate
   measures only when the change set contains a **product source file**
   (`primaryCodeFile` in `mutation/gate.ts` skips test paths by design). A
   **test-only edit — the normal shape of this campaign — triggers NO
   measurement.** So the gate is a safety net for source changes, not your
   progress meter; measure explicitly (§4a). When the gate *does* fire, a block
   naming a new survivor means your edit added an unchecked behavior — fix it,
   never bypass it.
5. **Verify bare:** `npx vitest run <file>.test.ts` as its own command with the
   summary visible. Piped or `;`-chained runs are NOT recorded as evidence by
   the harness and will leave the TDD state stale.
6. **Re-measure (§4a) and report before → after** with the fresh count.

## 4a. Re-measuring one file on demand

This is the step that closes the loop; without it you are guessing. A local
helper under `scratch/` (gitignored, machine-local — not part of the shipped
CLI) measures one file through the real engine using the gate's own overlay set:

```bash
npx tsx scratch/measure-file.mts src/path/to/file.ts        # prints "N mutants, M survivors"
MEASURE_RUNNER=<endpoint> npx tsx scratch/measure-file.mts src/path/to/file.ts
```

Two failure modes to recognize rather than misreport:

- **`NOT MEASURABLE: no_tests`** — the engine found no test in scope. Sometimes
  real (the file's tests live under a non-companion name), but it is ALSO what a
  stale/broken runner returns for a file that measures fine elsewhere. Retry
  against a different configured endpoint before concluding the file is
  unmeasurable, and report the discrepancy.
- **A count that did not move** after adding tests — your assertions do not
  actually distinguish the mutated behavior. Read the surviving rows again;
  the mutant tells you exactly which token is unchecked.

### If `scratch/measure-file.mts` is missing

`scratch/` is gitignored, so the helper does not survive a fresh clone or a
scratch wipe. It is ~60 lines and rebuilding it is mechanical — it POSTs one
job to a runner endpoint and prints the survivors. The contract it must honor:

1. **Overlay set = target + companion test + transitive local deps.** Build it
   with `collectLocalDeps` from `src/harness/mutation/local-deps.ts`, seeded from
   both the target and its `.test.ts` companion. Without the deps, a target that
   imports an uncommitted sibling fails to load in the runner's checkout and the
   run reports `no_tests` (that bug cost a day in 2026-07).
2. **Send an explicit whole-file `range`** (`{start: 1, end: <line count>}`).
   **This is load-bearing:** the runner adds `--incremental` only to *unranged*
   requests, and that cache replays a prior report — so an unranged measurement
   reports yesterday's survivors and makes freshly-added tests look useless.
3. **POST body:** `{ file, overlayContent, overlays, range, job_id }` to the
   runner URL (default `http://127.0.0.1:8790/`, override via an env var).
   Use a generous timeout (~300s); a whole-file measurement is slow but bounded.
4. **Response handling:** a `not_measurable: {reason, detail}` body is a 200, not
   an error — print it verbatim and exit without a count. Otherwise flatten
   `files[*].mutants[]`, count `status === "Survived"`, and print
   `"<N> mutants, <M> survivors"` followed by one line per survivor
   (`L<line>  <mutatorName> -> <replacement>`).

Print **both** numbers, always — survivor count alone is uninterpretable while
the manifest undercounts totals (§9).

**Definition of done for a unit:** survivors reduced to killable-zero (only
annotated equivalents remain), the file's tests green in a bare run, typecheck
clean, and the before/after counts stated. Do not claim a file is done on a
`not-measured` result.

## 5. Equivalence annotation — the narrow escape

Some mutants cannot be killed because no observable behavior changes (a default
arm the caller never branches on; a value nothing reads). For those only:

```bash
interlinked mutation accept \
  --file src/path/to/file.ts \
  --id <mutantId> \
  --reason "why no test can possibly kill this — mechanism, not vibes"
```

This flips the mutant to `equivalent` in the manifest with the reason recorded
in-band, so the accepted floor stays auditable. A blank reason is refused.

**Discipline — read this before accepting anything:**

- **Assume killable first.** If you can describe an input where behavior
  differs, it is killable. Write that test instead.
- **Agent-facing prose is BEHAVIOR in this repo.** A guard's `reason` /
  `suggestion` text is the only guidance an agent gets when a block fires;
  mutating it away is a real defect. Assert the load-bearing content (rule id,
  the actionable phrase, the suggested alternative) rather than accepting.
  Two message-quality defects shipped in one 2026-07 session precisely because
  no test asserted message content.
- **Never bulk-accept.** One mutant, one reason, one command. A sweep of accepts
  is indistinguishable from giving up, and it silently inflates the floor.
- **Budget:** if a file needs more than a couple of accepts, stop and escalate —
  that is a signal about the design (or about your classification), not about
  the mutants.

### Recognized survivor classes (name the class, don't improvise a reason)

Measured during the first campaign units. Naming the class is what makes a claim
checkable by someone else:

| Class | Shape | Correct resolution |
|---|---|---|
| **unchecked behavior** | the mutant changes an output nothing asserts | write the test — the default, the large majority |
| **dead code** | the mutant changes code that cannot affect any output (e.g. a guard whose value never alters the return) | **fix the source** — delete it, or implement what it was meant to do. Do NOT accept; accepting seals dead code in as "reviewed" |
| **defensive guard over an already-safe call** | forcing the guard true makes the call throw *immediately*, with no partial side effect, and the throw is swallowed by a blanket catch with nothing after it — identical end state | argue it precisely, then leave **unresolved** unless the argument is mechanical. Common in "never throws" capture/proxy modules |
| **syntactic no-op** | removing the statement provably changes nothing (`void err` → `{}`), or a type cast that cannot change a runtime value (`null as T` is still `null`) | genuinely provable; the strongest accept candidates |

**The defensive-guard class carries a hidden dependency.** Its equivalence holds
only while the surrounding control flow does: the guarded call must stay last,
and the catch must stay a pure swallow. Add one statement after the call, or make
the catch log, and the mutants become killable again — silently, because a prose
`accepted_reason` has no way to notice. Until dispositions carry invalidation
inputs, prefer leaving this class unresolved over accepting it.

## 6. Work list — waves, worst first

Counts are survivors/total at the 2026-07 baseline sweep; re-read live numbers
before starting a file (§3).

### Wave 1 — the guards (security-relevant, worst scores)

| File | Survivors | Kill strategy |
|---|---|---|
| `src/harness/rules/builtin-rules-processes.ts` | 397/398 | Extend `src/harness/__tests__/guard-corpus.test.ts` — it runs cases through the REAL `evaluatePreToolUse`. Per rule: a MUST-BLOCK command, a near-miss MUST-ALLOW, and an assertion on the block reason's load-bearing phrase. That triple kills regex, action, `enabled`, and message mutants together. |
| `src/harness/check-engine/tool-catalog.ts` | 326/513 | Table-driven: assert each entry's resolved behavior, not the table's shape. |
| `src/harness/checks/supply-chain.ts` | 281/424 | Pure classifiers (typosquat distance, license parsing) — fixture pairs on either side of every threshold. |
| `src/harness/evaluator/write-content-guards-content-quality.ts` | 232/451 | Same corpus shape as the guards. |

### Wave 2 — the detector family (dual-purpose with the Check Evidence Contract)

`src/harness/checks/ubs-language-specific/*` (`js-security-checks` 261/630,
`cross-language-checks` 242/458, `python-checks` 237/579,
`quality-smell-checks` 217/555), `src/harness/checks/agent-safety-js-correctness.ts`
(262/558), `src/harness/checks/cross-file.ts` (216/482),
`src/harness/checks/regex-interpolation.ts` (211/710),
`src/harness/checks/test-hygiene-quality.ts` (207/509).

Kill strategy is formulaic: for each detector, MUST-FIRE fixtures (one per
distinguishable branch) and MUST-NOT-FIRE fixtures (the legitimate patterns it
must not flag). Mechanical enough to delegate widely.

### Wave 3 — formatters and prose-bearing modules

`src/commands/verify/section-table-ubs.ts` (212/331),
`src/harness/statusline-snapshot.ts` (195/372), `src/lib/secrets.ts` (210/398),
`src/harness/deletion-hygiene.ts` (186/389), and the remaining long tail.
Expect a higher share of true equivalents here — and apply §5's prose rule
strictly, because several of these files *are* the product's voice.

Re-derive the live worst list any time:

```bash
node -e "
const {readFileSync}=require('fs');
const m=JSON.parse(readFileSync('.interlinked/mutation-manifest.json','utf8'));
const rows=[];
for(const [f,syms] of Object.entries(m.files)){let s=0,t=0;
  for(const sym of Object.values(syms)) for(const mu of Object.values(sym.mutants)){t++; if(mu.status==='survived')s++;}
  if(s)rows.push([s,t,f]);}
rows.sort((a,b)=>b[0]-a[0]);
for(const [s,t,f] of rows.slice(0,25)) console.log(String(s).padStart(4),'/',String(t).padStart(4),f);
"
```

## 6a. Progress ledger — completed units (APPEND HERE, do not re-pick)

**Check this table before choosing a file from §6.** The work list is static; this
is the record of what has actually been done. Append one row per completed unit,
with numbers from a live measurement (§4a), not from the manifest.

| Date | File | Before → After | Tests added | Left unresolved | Notes |
|---|---|---|---|---|---|
| 2026-07-30 | `src/harness/structure/adoption.ts` | 30 → **14** (of 71) | 8 | 14 | All 14 are **dead code**, not test gaps: `hasConfigFile` cannot alter any return value (see §5 class table). Resolution is a source fix, not accepts — pending decision to delete the `configKey`/`hasConfigFile` chain (and the then-unused `config` parameter of `computeAdoption`). |
| 2026-07-30 | `src/harness/replay/sse-reassembly.ts` | 32 → **8** (of 135) | 26 | 8 | 2 are syntactic no-ops (provable); 6 are the **defensive-guard** class and are staleness-dependent — left `unresolved`, deliberately not accepted. |
| 2026-07-30 | `src/lib/codex-feature-flag.ts` | 30/104 snapshot → **5/117** live | 14 | 5 | Denominator changed because the manifest undercounts module-scope mutants (§9). Remaining 5 are redundant `$` anchors in per-line regexes and a literal feeding only a boolean `.test()`. |

### Fleet wave 1 (2026-07-31) — 5 files hardened, each audited by a prosecutor

Every "after" figure below was re-measured by the orchestrator, not taken from the
executing agent. Run shape: one hardening agent per file, then an INDEPENDENT
prosecutor per file that received the hardener's "unkillable" list and tried to
refute it.

| File | Before | After | Notes |
|---|---|---|---|
| `rules/builtin-rules-processes.ts` | 397 / 398 | **1** | The campaign's worst and most security-critical target — a module-scope `GuardRule[]` table whose mutants could not even be RECORDED until the same day's identity fix. The single remaining survivor was classified a source defect, not killed artificially. |
| `checks/ubs-language-specific/js-security-checks.ts` | 261 / 630 | **25** | Prosecutor killed 8 more on top of the hardener's work. |
| `evaluator/write-content-guards-content-quality.ts` | 221 / 451 | **8** | |
| `harness/statusline-snapshot.ts` | 195 / 372 | **17** | Formatter; higher share of genuine equivalents as predicted. |
| `checks/agent-safety-js-correctness.ts` | 262 / 558 | **42** | Largest remaining backlog; hand-off recorded. |
| `lib/codex-feature-flag.ts` | (CRLF source fix) | **0 / 134** | See below. |

**1,336 → 93 survivors across six files, zero accepts, nine source defects reported.**

> **Open handoff gap — the nine source defects are a COUNT, not a list.** Only the
> three in `lib/codex-feature-flag.ts` are written up (the CRLF cluster below). The
> remaining six were reported inside individual fleet-agent transcripts and were
> never lifted into this ledger, so nobody can act on them from this document.
> Recover them from the session transcripts before the next wave, and fix the
> process too: **a source defect is only "reported" once it lands here with file,
> symbol, and the mutant that exposed it.** An agent that finds one and names it
> only in its own final message has produced a finding that dies with its context.



**The CRLF fix is the flywheel's first real bug catch.** Mutation testing surfaced a
user-visible defect: `split("\n")` leaves a trailing `\r` on CRLF files, and JS `.`
excludes all four line terminators, so `/#.*$/` never matched — a commented-out
`# hooks = true` read as ENABLED, so `interlinked enable --clients codex` reported
success while Codex hooks stayed OFF. The fixing agent rejected three plausible
repairs with reasons worth keeping: CRLF-aware splitting would rewrite the user's
whole file to LF on every pass; merely dropping the `$` still breaks on
U+2028/U+2029. It chose one shared terminator-agnostic helper (`/#[^\n]*/`),
preserved byte-exact line endings via a `dominantCr` helper, and found a FOURTH
consequence nobody had listed (with `[sandbox] # notes` unrecognised as a
boundary, the flag landed in the WRONG table). When a new survivor appeared
mid-work it wrote: *"Rather than claim it unkillable I removed the construct."*

**Side effect worth noting: the campaign tightened a different ratchet.** The new
MUST-FIRE / MUST-NOT-FIRE fixtures discharged Check Evidence Contract obligations
for **9 previously-grandfathered checks** (`eval_usage`, `inner_html`,
`nan_comparison`, `unsafe_optional_chaining`, `constant_condition`,
`number_precision_loss`, `json_parse_unsafe`, `ubs_js_loose_equality`,
`ubs_unchecked_redirect`). The contract test FAILED until they were removed from
the shrink-only grandfather list (113 → 104) — the ratchet demanding to be
tightened. This is the "one effort advances two ratchets" claim in §4, measured.

### Prosecution round 1 (2026-07-31) — adversarial audit of "unkillable" claims

Every survivor the first three units left unresolved was handed to an INDEPENDENT
prosecutor agent whose only instruction was to kill it and prove the previous
agent wrong. Result:

| File | Claimed unkillable | Actually killed | Source defects | Genuinely unkillable |
|---|---|---|---|---|
| `replay/sse-reassembly.ts` | 8 | **1** | 0 | 7 |
| `lib/codex-feature-flag.ts` | 5 | **2** | **3** | **0** |
| **total** | **13** | **3** | **3** | **7** |

**Six of thirteen "unkillable" claims did not survive contact with an adversary**
(3 killed outright, 3 were real source defects). `codex-feature-flag.ts` reached
**117 mutants / 0 survivors** — the campaign's first file at zero, independently
re-measured.

Two findings worth carrying forward:

- **A plausible premise was simply false.** The `.trim()` mutant survived because
  the previous agent asserted "JSON.parse tolerates surrounding whitespace". It
  does not: `String.trim()` strips the full Unicode whitespace set while
  `JSON.parse` accepts only U+0020/09/0A/0D. Worse, the *pre-existing* test that
  claimed to pin `.trim()` used ASCII spaces — which is exactly why the mutant
  survived. A test that looks like it covers a behavior is not evidence that it does.
- **Restraint is part of the job.** The prosecutor found two mutants it *could*
  have killed by stubbing `Object.entries` / `JSON.parse`, and deliberately
  refused: doing so "pins the implementation's choice rather than any behavior"
  and would "record a kill for a state unreachable in production". Manufacturing
  a kill inflates the score while making the suite brittle — it corrupts the very
  metric this campaign exists to keep honest. **Declining such a kill is the
  correct outcome and must be reported, not hidden.**

Totals after prosecution: **92 → 20 survivors, ~55 tests added, 0 deletions,
0 accepts, 0 source edits by hardening agents.** Every "after" figure was verified
by an independent measurement rather than taken from an executing agent's report.

**Ledger discipline:** a unit is recorded only after a live re-measurement. If you
finish work but cannot measure (runner down, `no_tests`), record the row with
`After = unmeasured` and say so — never infer a count.

### Coverage/CRAP wave (2026-07-31) — 7 units, 7 refuted, and why that is the good outcome

A 7-file wave aimed at the top of the combined CRAP + coverage-regression ranking
(110 candidate files; CRAP is dominated by zero-coverage command entry points,
and since CRAP = cc²·(1−cov)³ + cc, coverage is the *cubed* term — so the two
ratchets are one job). One hardening agent per file, then an INDEPENDENT agent
per file instructed to **disprove** the hardening claim.

**All seven were refuted. 28 problems. +216 tests, suite green.**

The distribution of failures is the interesting part:

| Failure mode | Count | Why a coverage number cannot see it |
|---|---|---|
| Mock-only tests | **0** | — |
| Weakened / deleted / skipped tests | **0** | — |
| Overclaimed "unreachable" branches | 3 units | The branch stays uncovered and the note says that is fine |
| Coverage that cannot fail | 1 unit | Branch is *executed*, so it counts as covered; deleting it breaks nothing |
| Vacuous assertion (`.every()` on a possibly-empty array) | 1 unit | Green, and green on an empty array too |
| Test title promising more than the assertion | 2 units | Reads as covered to any human skimming |
| Source defect pinned AS INTENDED BEHAVIOUR | 1 unit | Worse than uncovered — it cements the bug |
| Non-hermetic (host git config) | 1 unit | Passes locally, fails on CI or the other machine |

**Nobody cheated.** No agent weakened a test or asserted on a bare mock — the
things the harness already detects. Every failure was *overclaiming*: the tests
ran, they just did not establish what their author said they established. That
is precisely the class no metric catches, because a vacuous assertion and a
sharp one produce identical coverage.

Two findings worth carrying into every future wave:

- **A test that covers a branch but passes when the branch is deleted is not a
  test.** Before adding a case for a branch, delete the branch mentally (or
  actually) and confirm the new assertion fails. If it does not, you have bought
  a coverage point and no verification.
- **Isolate the environment the SUT sees, not the one your fixture sees.** One
  unit isolated git config for its fixture-building calls and stated in a comment
  that it had full isolation — while the command under test ran its own git
  through `execFileSync`, inheriting the host's `~/.gitconfig`. A single setting
  (`core.quotePath=false`) flipped 11 of 27 assertions.

**Round 2 — remediation: 6 of 7 resolved, 0 still-open, 0 weakened.** Each unit
got its own verifier's findings and was re-audited by a third agent. The seventh
was caught doing something worth naming: it **disputed a finding incorrectly and
wrote the false claim into the test file as a comment** — a rationale attributing
behaviour to a test that does not exhibit it, which is round 1's PROBLEM 1 class
recurring one level up. The re-auditor refuted it by building the mutant and
measuring, then handed over the exact discriminating assertion. Landed and
verified: REAL passes, body-deleted and block-deleted mutants both FAIL, and only
on the new assertion — the pre-existing `length > 0` checks stayed green under
both, which is precisely why the block had been unpinned.

**What round 2 got right that round 1 did not, and it was not model tier:** the
tasks carried a measured root cause, exact before/after numbers, and a named
definition of done. Three agents used that footing to push back — one **proved a
prescribed fix would have been a regression** and closed its audit with no
production change; another **rejected a proposed detector refinement** on measured
evidence and shipped a narrower one instead. Vague tasks produce overclaiming from
any model; specified tasks produce disagreement, which is what you actually want.

**A defect in the fix itself.** One audit noticed that `normalizeManifestKey` —
the manifest choke point introduced *that same day* to kill duplicate keys — ran
its `resolve → relative` round-trip only for ABSOLUTE inputs. Measured: one file
produced **five** distinct keys (`src//a.ts`, `src/./a.ts`, `src/sub/../a.ts`,
`../<repo>/src/a.ts` all surviving alongside `src/a.ts`). The two-spellings/one-map
class, reintroduced inside its own remedy. Now one key for all nine spellings,
with a case pinning that a genuinely-outside-cwd path keeps its distinct key.
**Generalizes: a "canonical" helper is not canonical until something asserts that
every spelling collapses — a helper's existence is not evidence of its behaviour.**

The ledger rule stands: no unit is marked resolved on an executing agent's say-so.

### Unit: `harness/build-refresh.ts` (2026-07-31) — 15 → 2, hardening its own fix

Not from the work list. The daemon's build-refresh watcher was changed to fix a
live under-enforcement bug (evidence log in
`docs/plans/16-monotonic-quality-enforcement.md`), so the campaign's own rule
applied to it: a file you touch, you harden. Orchestrator-measured throughout.

| Stage | Mutants | Survivors |
|---|---|---|
| After the escalation fix landed | 104 | 15 |
| After boundary tests on the edited predicate | 104 | 13 |
| After a hardening agent took the watcher internals | 104 | **2** |

The escalation branch itself never appeared as a survivor — its boundary tests
killed every mutant on landing. That is the intended shape: **write the test
that pins the boundary while you still remember why the boundary is there.**

The two remaining survivors are argued equivalent, and the argument's *method*
is the part worth copying. Both were verified **empirically, not algebraically**:
the mutation was patched into a scratch copy of the source and the full 30-test
suite was run against it. Only when all 30 still passed was equivalence claimed.

- `lastAttemptMs !== 0` forced `true` — redundant by numeric magnitude, not by
  control flow: when the sentinel is `0`, `now - 0` is an epoch-scale number
  (~1.7×10¹²) that already exceeds any realistic `intervalMs * 2`. Left in
  source deliberately: it documents "no attempt yet", and deleting it would make
  correctness depend on a hidden assumption that `Date.now()` is never near zero.
- `currentMtimeMs === null` forced `false` — `shouldHandOver` independently
  vetoes it, since `null <= startedMtimeMs` coerces true for any real mtime.
  Also left in source: relying on the coercion quirk is less readable than the
  explicit guard.

Both are the §5 **dead code** class. Note what did NOT happen: neither was run
through `interlinked mutation accept` (the verb is a refusal by design), and
neither was "killed" by deleting the guard — deleting a defensive guard to move
a number is the anti-pattern, not the fix.

### Ratchet pass (2026-07-31) — the gates the campaign runs against

Hardening the tests is half the job; the water-lines have to move too, or the
next agent inherits the same slack. What moved, and what deliberately did not:

| Metric | Before | After | Basis |
|---|---|---|---|
| Cyclomatic cap | 25 | **22** | 9270 functions measured: max 56, p99 18, p95 12. Cost grid 25→3 over, 23→15, 22→23, 20→53; the curve steepens below 22 |
| Cognitive cap | 30 | **30** (unchanged) | Measured p99 = 28 against a cap of 30 — already correctly placed. Tightening to 25 would flag 129 functions for a warn-only gate, i.e. pure noise |
| Coverage ratchet | 1075 findings | **precision-fixed** | ~88% were floor-vs-full-precision artifacts, not regressions (evidence log in `docs/plans/16-monotonic-quality-enforcement.md`) |
| CRAP cap | 30 | **25** | Measured after the model was corrected: n=9132, max 380, p99 20.1, p50 3. Cost grid 30→21 over, 26→35, 25→39. Worst offenders are genuinely high-complexity/zero-coverage command entry points (`metrics-rework`, `metrics-coupling`, `doctest`, `replay`) |
| Coverage baseline | — | **ratcheted + normalized** | `coverage check --update-baseline` against a clean full-suite report: 7 raised, 1197 unchanged, 1 new, **0 genuine lowerings**. The 916 apparent drops were each exactly `floor(x*100)/100` — the deliberate normalization to the report's own resolution, which is what stops the phantom findings recurring |

**The CRAP row is worth reading twice.** The first attempt reported 2960 functions over cap with
well-tested files at 0% coverage — a number that would have justified either a panic or a
cap raise. It was neither: istanbul's `f[id]` counts a function's own ENTRY, not its body,
so the model was wrong, not the code. `FunctionCoverage.statement_pct` — which the repo's
own reader already derives — gives the real figure of 21 over cap. **When a metric produces
an implausible number, suspect the measurement before the tree.**

Two of these are worth internalizing before touching a cap:

1. **Measure the distribution before choosing a number.** Cyclomatic looked
   near its limit and had four steps of headroom; cognitive looked loose and had
   none. Neither was guessable.
2. **A cap you cannot measure is a cap you must not set.** The CRAP row stays
   `unmeasured` rather than taking the plausible-looking number, because the
   measurement was built on a coverage model that does not hold.

Re-measure with `scratch/measure-cyclomatic-dist.mts` and
`scratch/measure-crap-cognitive-dist.mts` before the next ratchet step; the
23 functions now over the cyclomatic cap are enumerated in the task ledger.

## 7. Running this in parallel across several agents

Parallelism is supported with three hard rules. Violating them corrupts shared
state rather than merely slowing things down.

**Rule 1 — one file per agent, claimed up front.** The harness auto-reserves
files it sees being edited, but the campaign's unit is a source+test pair, so
claim both explicitly in whatever task ledger coordinates the run. Two agents
in the same pair will fight the reservation layer and each other's tests.

**Rule 2 — never let two agents write the manifest concurrently.** The live
manifest is a single JSON document rewritten wholesale on every clean measured
pass. Concurrent writers are last-writer-wins: a lost update silently drops a
file's baseline, which then re-adopts its survivors as an accepted floor on next
sighting — a corrupted ratchet that looks like progress.

**Measured 2026-07-29: this campaign's normal shape writes the manifest ZERO
times.** Adding tests is a test-only change set, which triggers no measurement
(§4 step 4), and the §4a measure helper is read-only. So *pure test-addition
work parallelizes safely on one shared tree*, provided each agent owns a disjoint
source+test pair (Rule 1). Reservations arbitrate anything that overlaps anyway.

Worktree isolation (one per agent, each root carrying its own `.interlinked/`)
becomes necessary only when agents also edit **source** — deleting dead code,
fixing a defect — because those change sets do trigger measured passes that
persist. Note that a fresh worktree does not inherit gitignored local rules, so
its runner configuration must be provisioned before the gate can measure there.
Per-file manifest sharding (§9) removes the constraint entirely.

**Rule 3 — accepts escalate, regardless of model.** No executing agent runs
`interlinked mutation accept` for its own unit; it *reports* candidates with a
mechanism and a reviewer decides.

The reason is **conflict of interest, not capability.** An agent judging whether
its own remaining survivors are unkillable is grading its own homework, and the
convenient answer is always "unkillable." Measured evidence that this is not
hypothetical: on `structure/adoption.ts` the executing agent's analysis was
*correct* — 14 mutants genuinely could not be killed — yet the right resolution
was **fix the source** (dead code), not annotate 14 equivalents. With accept
rights it would very likely have filed 14 tidy justifications and sealed a real
defect in behind them. Raising the model tier does not remove that incentive.

**Model routing.** Task shapes differ in judgment demand: Wave 2's fixture
corpuses are formulaic; Wave 1 (what a guard's message must promise) and Wave 3
(whether a mutant is truly unobservable) are judgment-heavy. That said, **this
campaign's standing decision is to run every wave on the strongest available
model**, including the parallel units — the wall-clock bottleneck is measurement
(tens of seconds per file), not inference, so a stronger model costs tokens
rather than throughput.

**Verification is model-independent.** Machine-verify every reported number by
re-measuring (§4a) no matter who produced it. This is not distrust of a
particular tier — a self-reported count is an unverified claim from any source,
and re-measuring costs ~40 seconds. Observed across the first three units:
survivor counts were accurate 3/3, but secondary counts (tests added) were wrong
in 2/3 reports. Both defects in the measurement machinery itself (§9) surfaced
*because* the numbers were checked rather than accepted.

**Throughput reality.** One scoped measurement is tens of seconds against a
warm runner, and runners are a shared finite resource: N agents contend. Expect
queueing rather than linear speedup, and prefer more files per agent over more
agents per file.

## 8. Anti-patterns (each has been attempted; each is rejected)

| Anti-pattern | Why it fails |
|---|---|
| Lowering a baseline / cap so the gate passes | Blocked by the baseline-integrity gate; defeats every ratchet at once. |
| Bulk-accepting survivors as "equivalent" | Inflates the accepted floor invisibly; indistinguishable from abandoning the file. |
| Asserting mock interactions instead of behavior | `mock_only_test` flags it, and mutants survive anyway — a mock assertion checks the call you wrote, not the value produced. |
| Deleting the code the mutant lives in, to make it go away | Only valid when the code is genuinely dead; say so explicitly and prove nothing consumes it. |
| Treating `[mutation:not-measured]` as clean | It means no verdict. Fix the runner or the test scope. |
| Splitting one branchy change across edits to dodge the cyclomatic slew limit | The tolerance is a regression detector, not a budget; extract a helper. |
| Piped test runs (`vitest … | tail`) as evidence | The harness cannot see the summary; TDD state goes stale and the commit gate wedges. |

## 9. Known gaps — fix these when they start to bite

> Each gap below is carried into the "Build order and rationale" section of
> `docs/plans/16-monotonic-quality-enforcement.md`. Fix them there (with the
> surrounding infrastructure) rather than patching them ad hoc here.

- **Manifest durability + sharding.** The full manifest is machine-local and
  gitignored by design (a large, regenerable measurement artifact). What *should*
  travel is a slim committed floor file — per-file score plus the accepted
  equivalents with their reasons — which also becomes the audit surface for
  Rule 3 and the git-visible record of accepts. Sharding the local manifest
  per file additionally removes the concurrent-writer constraint (§7 Rule 2).
- **Test-scope derivation is filename-based.** A file covered only by a
  differently-named or differently-run test measures as untested and cannot be
  hardened by this loop (~290 files at the baseline sweep). The fix is a
  coverage-ownership map: path → (runner, include globs, how to invoke), shared
  by the mutation scope derivation and the coverage-obligation ledger.
- **The manifest silently omits mutants outside a function symbol — every
  recorded count is a FLOOR, not a total.** Verified 2026-07-29 on
  `src/lib/codex-feature-flag.ts`, unchanged in git since June: the manifest
  records 5 symbols / 104 mutants, all of them functions, while a live
  measurement of the identical source reports **117**. The 13 missing mutants
  belong to module-scope constants (`FEATURE_FLAG_REGEX`,
  `LEGACY_FEATURE_FLAG_REGEX`, …) which the identity layer anchors to no
  enclosing symbol. Consequences: baseline totals (including the ~25k sweep
  figure) undercount; and a survivor living in a module-scope constant can
  never be recorded, ratcheted, blocked, or annotated — it is outside the gate
  entirely. That matters here because module-scope constants in this repo are
  regexes, catalogs, and key names, several of them security-relevant. Until
  identity anchors module-scope declarations, **always quote both numbers**
  (`N mutants, M survivors`) from a live measurement rather than survivor
  counts alone, and never compare a manifest snapshot against a live total.
- **A stale runner reports `no_tests` instead of failing loudly.** Observed
  2026-07-29: one configured endpoint returned `NOT MEASURABLE: no_tests` for
  `structure/adoption.ts` while another measured the same file at 71 mutants.
  Because `no_tests` reads as "not measurable" rather than "runner broken", a
  degraded endpoint silently converts real measurements into non-verdicts — and
  may account for part of the baseline sweep's ~290 "unmeasurable" files. Until
  the runner distinguishes "this repo has no such test" from "my checkout is
  stale", cross-check an unexpected `no_tests` against a second endpoint (§4a).
- **Per-edit test runs are off here.** `per_edit_coverage.enabled: false` in the
  local rules, because `coverage-overlay.ts` `cpSync`-mirrors every top-level
  entry except `.git`/`.interlinked`/`node_modules` — including `dist/`,
  `coverage/`, `reports/`, `.wrangler/`, `.stryker-tmp/` (~3.2GB per edit).
  Adding those to `SKIP_ENTRIES` is the small fix that would make the automatic
  per-edit affected-test run affordable. Until then the full suite runs between
  units (orchestrator's job), not per edit.
- ~~**No `procfs_probe_in_test` detector.**~~ **SHIPPED 2026-07-31.** Tests that
  probe `/proc/...` as an "unwritable path" hang Linux CI (recursive mkdir
  spins); the safe fixture is a path nested under a regular *file* (ENOTDIR
  everywhere). Two further detectors in this class are queued in plan 16's
  detector backlog: `absolute_ms_assertion_in_test` (3 instances) and
  `startup_error_vs_test_failure`.
- **The "~290 unmeasurable files" figure is not supported by current data.**
  Re-derived 2026-07-31 against all four companion-test conventions the runner
  probes (sibling `.test.ts`/`.test.tsx`, `__tests__/`, `.spec.ts`): of the files
  with recorded survivors, **657 are measurable and 2 are not** — and those 2 are
  themselves `.test.ts` entries that should never have been targets. The 290
  figure came from the sweep's `not measurable` count, which we now know was
  substantially the degraded-runner `no_tests` problem (see the bullet above),
  not genuinely missing tests. Re-derive before citing it.

## 10. Tree-wide sweep readiness — audit (2026-07-31)

Assessment only — no sweep driver was built in this pass. Every claim below is
either a source citation or a measurement taken from the LIVE manifest / an
existing production artifact; nothing was extrapolated from a fresh run (the
machine hit its process ceiling earlier the same day, so no large or parallel
runs were launched to "test scale"). Live re-check of the campaign's own
numbers first, since a verified figure beats a repeated one: the manifest right
now (`.interlinked/mutation-manifest.json`, generation 744) holds **717 files,
101,342 mutants, 25,112 survivors** — slightly ahead of the 692/101,232/25,044
figures this section was asked to assess against, because the campaign (§6a)
has kept moving it since that snapshot was taken. The concentration claim was
independently re-derived against the live manifest and holds: **665 files carry
≥1 survivor, the worst 20 hold 14.8% of all survivors** (vs. the stated 15%),
and the size buckets match closely (**46** files at 100+, **117** at 50–99,
**186** at 25–49 survivors, vs. the stated 46/115/187). The conclusion —
hundreds of units, not a dozen — is correct and gets more true, not less, as
the campaign progresses: it is retiring survivors fastest in the worst files,
which mechanically flattens the tail further.

### 10.1 Verdict

**Not ready as productized infrastructure; already proven once as a manual,
ungoverned process.** The current 717-file baseline exists *because* a sweep
was already run — but through `scratch/sweep-mutation.mts`, a gitignored,
untyped, untested, non-`src/` script that duplicates logic the productized
`measure.ts` already has correctly and more safely. Most of the hard,
correctness-sensitive work (overlay construction, mutant identity, manifest
folding, dedup) is already solved and lives in tested `src/` modules. What is
missing is small and specific: a file-list-level orchestrator, a
concurrency-safe manifest writer, and promoting the existing ad hoc script's
logic into governed code. None of it requires new design — see §10.7.

### 10.2 Q1 — Can the existing sharding plan and execute a multi-hundred-file sweep?

**No. It is built for exactly one file at a time, and it says so in its own
docstring.** `shard-plan.ts`'s module comment states the shard unit is "a line
range, not a file, because a model edits one file at a time" — `planShards
(totalLines, shardCount)` takes a single file's line count and tiles it into N
contiguous ranges; there is no file list anywhere in its signature.
`sharded-runner.ts::createShardedMutationRunner` wraps N runners into one
`MutationRunner` whose `run(file, overlayContent, overlays, range?)` still
takes exactly one `file` — it shards that ONE file's overlay content across the
runners' line spans (`planShards(lineCount(overlayContent), live.length)`),
never routes different files to different runners. `gate.ts::runPerEditMutationGate`
confirms the caller-side shape: `primaryCodeFile(changedPaths(changeSet))`
picks a single target from one edit's ChangeSet before the runner is ever
invoked.

**The function that would have to change is not in these five files at all —
a new one has to be written above them.** `runPerEditMutationGate`'s one-target
derivation is correct for its job (a live edit touches one file) and should not
be generalized; a sweep driver needs a NEW orchestrator — call it
`runTreeSweep(files: string[], runners: MutationRunner[])` — that iterates a
file worklist and calls the EXISTING single-file runner abstraction once per
file, in parallel across whatever runners are configured. That pattern already
exists, just not in `src/`: `scratch/sweep-mutation.mts` dispatches one
`worker()` per configured runner URL, each pulling whole files off a shared
queue (`next++`) and calling `seedFileBaseline` + `saveManifest` directly. It
proves the approach works — it is how the current 717-file baseline was
produced — but it sits outside every governance mechanism this repo has: it is
gitignored, and `tsconfig.json`'s `"include": ["src"]` means `npm run
typecheck` never sees it; it has no tests, unlike every one of its sibling
modules under `src/harness/mutation/`.

### 10.3 Q2 — Concurrency ceiling

**Verified: the runner does serialize to one job per worktree, and today's real
ceiling is 1, repo-wide.** Two independent client implementations converge on
the same protocol, which is strong evidence even though the runner's own
source is in the private `interlinked-cloud` repo and unauditable here:

- `measure.ts::tryEndpoint` — `return res.status === 503 ? null : res;` (busy
  ⇒ treated as "try again", not a failure).
- `scratch/sweep-mutation.mts` — `// 503 is "one Stryker run per worktree" —
  wait for the peer, don't lose the file.` with an explicit retry-on-503 loop.

Concurrency is a property of *how many independently provisioned worktrees you
have*, not a knob in this code — `runner_urls[]` is the only lever, and each
entry needs its own real sandbox behind it. `provisioner.ts`'s `RepoProvisioner`
interface anticipates this (`forkCopy(n)`, docstring: "N independent worker
roots for mutant fan-out"), but the **only implementation in this repo is
`InMemoryProvisioner`** (confirmed: `rg -n "class.*Provisioner" src/` returns
exactly one class). The Sandbox-backed implementation the comment refers to
lives in the private cloud Worker, so N-way real parallelism is a capability
this audit cannot verify from here.

Today's actual configuration (`.interlinked/guard-rules.local.json`, read
live): `runner_url` = one local endpoint, `runner_urls: []` — **empty**. A
second endpoint was configured until 2026-07-31 and was explicitly removed;
the config's own `_runner_note` explains why (see §10.4). Local (same-machine)
use as a second worker was tried once and rejected in a code comment in the
sweep script itself: *"running it here drove 47 node processes and 16GB of
swap, and macOS killed the daemon twice."* **So the honest ceiling right now is
one measurement in flight, repo-wide** — a sweep driver and the live per-edit
gate would contend for that same one slot if run at the same time.

### 10.4 Q3 — What fails badly at scale

**`no_tests` instead of an error — confirmed in production, not hypothetical,
twice over:**

1. The live local config carries its own incident report, verbatim:
   > *"Second endpoint REMOVED 2026-07-31: it returns spurious NOT MEASURABLE:
   > no_tests for files the primary runner measures fine... Its /health reports
   > ok:true... A false no_tests is worse than an outage: under
   > unavailable_behavior=allow_unmeasured it turns a real measurement into a
   > non-verdict and the edit passes ungated."*
2. `scratch/sweep.log` shows the SAME failure at sweep scale: a full 776-file
   attempt returned `0/0 (no tests)` for every sampled file in its first ~200
   entries before the run was aborted, its engine-config-sync bug fixed, and
   the sweep re-run from scratch (the very next log block starts over at
   `0/776 already recorded`). **A degraded runner silently zeroed out an entire
   multi-hour sweep pass once already**, and at 692-file scale this is the
   single most consequential failure mode: nothing downstream distinguishes
   "no test covers this file" from "my checkout is stale," so a bad runner
   converts real measurements into non-verdicts across the whole tree rather
   than failing loudly (§9 already tracks the fix; this section confirms the
   failure recurs at sweep granularity, not just per-file).

**Retry behavior is inconsistent, and the version a sweep driver would inherit
is the unbounded one.** `measure.ts::requestWholeFileReport` bounds its
busy/unreachable retry loop with an explicit `deadlineMs` (900s default).
`scratch/sweep-mutation.mts::measure()`'s 503-retry loop has **no deadline at
all** — `for (;;) { … if (503) { await sleep(4000); continue; } … }`. If the
one configured runner ever gets stuck holding its one worktree slot (crashed
mid-job, never freed), that loop — and the whole sweep's single worker, since
there is exactly one configured runner today — spins forever with no error and
no progress signal.

**Memory: a real incident, already observed, directly on point for today's
process-ceiling warning.** The sweep script's own comment: pointing it at the
local machine "drove 47 node processes and 16GB of swap, and macOS killed the
daemon twice — the guard starved by the sweep that was meant to be measuring
the code it guards." This is exactly the failure this task's machine-health
note is guarding against, already documented as having actually happened.

**Per-file cost that multiplies badly: the manifest write, not the measurement.**
`saveManifest` (manifest.ts) rewrites the ENTIRE manifest file on every single
save (`writeFileSync(path, JSON.stringify(manifest))`), and
`scratch/sweep-mutation.mts` calls it after **every one** of ~700+ files. At the
current 33MB manifest size that is ~700 full-manifest serializations and writes
for one pass — tens of GB of `JSON.stringify` + disk I/O churn to persist what
is, per call, one file's worth of new data. The cost scales with (files
completed so far) × (manifest size at that point), so it gets worse across a
sweep's own run, not just across sweeps.

### 10.5 Q4 — Per-file wall-clock and realistic sweep duration

**Real, measured — derived from the manifest's own history, not a fresh run.**
Every mutant `applyMeasuredRun` writes carries a `firstSeen` timestamp stamped
at the moment its file was measured; grouping the live manifest by that
timestamp reconstructs the actual historical sweep's per-file cadence with zero
new process launches. Read-only probe (kept at
`scratch/probe-sweep-timing.mjs`, rerunnable):

```
689 files landed in one contiguous run (gaps <5min) spanning 202.7 minutes
  => 17.65 s/file average, single remote runner, sequential
fastest observed per-file saves: ~2.9–3.6s (small files)
median inter-file delta: 11.2s
```

**Extrapolated realistic duration for a 692-file full pass at today's
concurrency ceiling (§10.3, one runner):** 692 × 17.65s ≈ **3.4 hours** — which
is not a projection so much as a restatement of what already happened: 689
files really did take 202.7 minutes (≈3.38h) the one time this was run to
completion. This is the cost of *one full re-measurement pass* (establishing or
refreshing every file's baseline); it is distinct from the campaign's
survivor-killing work (§4), which does not require re-running a sweep per unit
— `interlinked mutation measure` (or `scratch/measure-file.mts`) re-measures one
file in seconds.

More runners would shorten this roughly linearly **only if each is a real,
independently provisioned worktree** (§10.3) — the file-level fan-out pattern
already exists (`scratch/sweep-mutation.mts`'s `RUNNERS.map(worker)`), it is
just that only one real endpoint exists to hand it today.

### 10.6 Q5 — Can a large sweep corrupt state?

**Yes, one real path — and the primitive to fix it already exists in the data
model but is unused at the I/O layer.**

- `saveManifest` is an unconditional `writeFileSync` — no temp-file + rename,
  no lock. `applyMeasuredRun` computes `generation: base.generation + 1` from
  whatever `base` the caller loaded, and `saveManifest` never checks the
  on-disk generation before writing. Yet `types.ts` already documents the
  field's intended use, verbatim: **"Immutable snapshot id; promotion is
  compare-and-swap on this generation."** The CAS the type comment promises is
  not implemented at the persistence layer — `generation` is bumped and
  stored, never checked.
- **The race is cross-process, not intra-process — verified, not assumed.**
  Inside one Node process, `seedFileBaseline`'s read of the shared `manifest`
  variable and `saveManifest`'s write to disk have no `await` between them, so
  JS's single-threaded run-to-completion semantics make the sweep script's own
  `RUNNERS.map(worker)` fan-out safe against itself — there is no window for
  one worker's callback to interleave inside another's read-modify-write.
  The real hazard is **two separate processes** sharing the file: a sweep
  driver process running for ~3.4 hours while the live daemon's per-edit gate
  measures a developer's ongoing, concurrent edits in its OWN process. Both
  do `loadManifest()` → compute → `saveManifest()` with no coordination
  between processes, so the second writer's save silently discards the first's
  update — a real survivor baseline lost, later re-adopted as first-sighting
  and quietly accepted as the new floor. This is exactly what §7 Rule 2 already
  warns about in prose; this audit confirms the mechanism in code rather than
  discovering a new one.
- **The blast radius of a hard crash is bounded, which is worth stating
  precisely rather than either over- or under-claiming it.** `loadManifest`
  wraps its `JSON.parse` in try/catch and returns `null` on any failure,
  and every caller already treats `null` as "no baseline yet." So a process
  killed mid-`writeFileSync` (an OOM-kill mid-sweep is the directly relevant
  scenario today) produces a torn file that degrades to **lost progress**, not
  **silent corruption that reads as valid** — the ratchet does not get
  quietly weakened by a torn write, it gets reset. The real cost is losing the
  33MB / hours of measurement work and re-paying the ~3.4h pass, not a
  falsely-clean gate.

### 10.7 Smallest changes that would unblock a sweep, ranked

None of these require new design — each closes a gap already named above.

1. **CAS-check `saveManifest`.** Before writing, re-read the on-disk
   `generation`; if it no longer matches the generation the in-memory `base`
   was loaded at, reload and re-fold rather than blind-overwrite (or surface a
   retryable conflict to the caller). This is the single highest-leverage fix
   for §10.6 — it turns an already-declared invariant into an enforced one and
   makes concurrent writers (sweep + live daemon, or two sweep shards) safe by
   construction instead of by convention.
2. **Atomic write.** `writeFileSync` to a temp path in the same directory,
   then `renameSync` over `mutation-manifest.json`. Removes the torn-write
   class outright (same-filesystem rename is atomic), independent of #1 and
   cheap to add.
3. **Promote `scratch/sweep-mutation.mts` into a tested, typechecked module**
   (e.g. `src/harness/mutation/sweep.ts` + a thin `interlinked mutation sweep`
   command), and on the way: (a) bound its busy-retry loop with a deadline the
   way `measure.ts` already has; (b) reuse `measure.ts`'s
   `requestWholeFileReport` / `buildMeasureOverlays` instead of maintaining a
   second, untested implementation of "POST one file to a runner" (today there
   are two, and they have already drifted once — the sweep script's own
   engine-config-sync fix was never ported back); (c) make the runner list a
   required, explicit input rather than a hardcoded IP fallback.
4. **A first-class resumable worklist.** `sweep-results.jsonl` already has the
   right shape informally (one JSON row per file: measured / not_measurable /
   error, skip-if-already-recorded); formalize it so a sweep can report
   progress/ETA and be safely killed and resumed — relevant given today's
   process-ceiling constraint, where a driver that cannot be safely killed
   mid-run is a liability.
5. **Keep sweep concurrency at exactly `runner_urls.length`, no more,** until
   a second real, independently provisioned endpoint exists to verify against.
   The N-workers-over-a-shared-queue pattern is intra-process safe (§10.6) but
   is only useful once more than one genuine worktree backs it — today that
   number is 1, so a driver should refuse to fan out past the configured
   endpoint count rather than silently hammering one endpoint with concurrent
   requests it will only 503 anyway.
6. **Do not run the no_tests-vs-broken-runner fix separately from the sweep
   work** — §9 already tracks it, and §10.4 shows it is the single failure mode
   most likely to silently invalidate an entire multi-hour sweep pass rather
   than just one file.

## 11. Self-verification via `--coverage` — investigation BLOCKED, not resolved (2026-08-01)

**The ask (task #16):** agents currently work blind on coverage — they get a
baseline handed to them and cannot confirm their own result, which invites
overclaiming. The proposed fix was to let an agent redirect its own coverage
run away from the shared report:
`npx vitest run <file> --coverage --coverage.reportsDirectory=<tmp>
--coverage.all=false`. Three things needed verifying before recommending it:
CLI-over-config precedence, a byte-identical `coverage/` before/after, and
process cost.

**Outcome: none of the three could be executed this session.** The operating
session's own shell allowlist explicitly and repeatedly forbade `--coverage`
in any form ("`npx vitest run <path>` … Never bare, never `--coverage`",
reiterated: "never `--coverage`: three other fleets are running, the mutation
runner is a single-job resource, and the box hit its process ceiling
recently"). Every one of the three checks requires actually invoking
`vitest run --coverage`. This is a genuinely **blocked** investigation, not a
tested-and-passed or tested-and-failed one — conflating those would be exactly
the overclaiming this doc exists to prevent. No `--coverage` command was run,
including wrapped inside a scratch script to route around the restriction.

**What was checked instead — read-only, source-level, clearly an assumption,
not a test:**

1. **CLI-over-config precedence for `reportsDirectory` — supported by source,
   unexecuted.** vitest 4.1.8's own bundled code
   (`node_modules/vitest/dist/chunks/cli-api.BfdDOPPI.js`) resolves config as
   `deepMerge({}, configDefaults, viteConfigTest, options)` with the
   CLI-derived `options` object merged LAST (`deepMerge`'s later argument
   wins), and separately caches a runtime override as
   `deepMerge(deepClone(this.config.coverage), this.configOverride.coverage)`
   (line 13212) — CLI args last again. `reportsDirectory` resolves via
   `resolve(ctx.config.root, config.reportsDirectory ||
   coverageConfigDefaults.reportsDirectory)` (line 643) reading that merged
   object, and both the pre-write `clean()` step (`rm` on
   `this.options.reportsDirectory`, line 714) and the report writer
   (`libReport.createContext({ dir: this.options.reportsDirectory, … })` in
   `@vitest/coverage-v8/dist/provider.js`) consume the same resolved value.
   Consistent with CLI-overrides-config — but this is reading the bundled
   source, not running it, and the task explicitly asked for the latter.

2. **`--coverage.all=false` is very likely a no-op in vitest 4.1.8 — a real
   correction to the proposed incantation, not a hedge.** `coverage.all` does
   not appear anywhere in `coverageConfigDefaults`
   (`chunks/defaults.9aQKnqFk.js`), the CLI flag declarations
   (`chunks/cac.C9xsMMkH.js`), or the `@vitest/coverage-v8` provider — it was a
   real option in earlier vitest majors and appears removed by 4.x. What
   actually gates "list every `include`-matched file even if untested" is an
   internal `allTestsRun` boolean
   (`@vitest/coverage-v8/dist/provider.js` line 52-54:
   `if (this.options.include != null && (allTestsRun || !this.options.cleanOnRerun))`),
   and the CLI's own non-watch `run` driver (`Vitest.start(filters)`,
   `cli-api.BfdDOPPI.js` line 13463) hardcodes
   `this.runFiles(specifications, true)` — `allTestsRun = true` — regardless
   of whether `filters` narrowed the run to one file. Net effect: a redirected
   single-file `--coverage` run's own report, in the tmpdir, will almost
   certainly still list all `coverage.include`-matched files (currently
   ~1043), the vast majority at 0%, reproducing the original incident's shape
   — just contained to a private directory instead of the shared one. **The
   fix this implies is procedural, not a flag: read only the touched file's
   own entry (e.g. `coverage-summary.json["src/path/to/file.ts"]`), never the
   aggregate `total` row** — `--coverage.all=false` cannot be relied on to
   shrink the report, and any future protocol should say so explicitly rather
   than repeat the flag on faith.

3. **A pre-experiment baseline hash of the live shared `coverage/` was
   captured (read-only, safe) for whoever next has permission to run the real
   test:**
   ```
   FILE_COUNT 1102
   COMBINED_SHA256 f637560f7e478ad8f41a49a6aae2677d1fadb312aaa4aabb63d1c1ae7e8ba3a7
   coverage/coverage-final.json    16675362 bytes  902176db355306cd6db43c12ab3b053eb3e6bd9dbb0f390a7e7f166e8bb38c4d
   coverage/coverage-summary.json    329681 bytes  673599acb5ca01ea011ce9d1a23d0aeb2fdf9c7fc39c38aec3eda04f93f21b10
   coverage/lcov.info               1891816 bytes  6fc043a4843a7d1225f2c9e41e1b264b1de080ff439a49e7c39e01dc7d4ba3d0
   ```
   (sha256 of every file under `coverage/`, combined by hashing the
   concatenation of the sorted per-file hashes; captured 2026-08-01 against
   this tree's live report.) A future attempt must diff against this BEFORE
   drawing any conclusion — per the task's own framing, if any of these three
   change, the redirection failed and the whole idea is dead.

4. **Process cost has no data point for this specific shape and could not be
   produced.** The only existing measurements in this repo are for a
   different, much heavier workload — the mutation runner's sweep script,
   which spawns one process per mutant and once drove "47 node processes and
   16GB of swap" (§10.4 above) — not comparable to one
   `vitest run <file> --coverage` invocation. The closest relevant existing
   data is `docs/plans/16-monotonic-quality-enforcement.md` rows 656-657:
   turning on v8 coverage instrumentation measurably raised wall-clock for a
   timing-sensitive test (2643-3284ms instrumented vs <2500ms bare, roughly
   30-100% overhead on that one test) — real, but about timing distortion, not
   process count or memory footprint, and not sufficient to answer "is one
   instrumented single-file run safe to launch when the box already hit its
   process ceiling today."

**Candidate file for the actual experiment, not yet run:** `src/lib/hook-timeouts.ts`
(26 lines) + its companion `src/lib/hook-timeouts.test.ts` (24 lines) — the
smallest test+source pair found in a sweep of `src/lib`, self-contained, no
heavy transitive deps, cheap to instrument. Confirmed 2026-08-01, bare (no
`--coverage`, permitted by the allowlist): 4/4 tests pass in 85ms, and a
re-hash of `coverage/` immediately after matched the baseline in item 3
exactly (same 1102-file count, same combined sha256) — a bare run genuinely
does not touch it, which is the expected control and gives the baseline above
real footing. The untested incantation, once someone has permission to run
the actual `--coverage` experiment:

```bash
npx vitest run src/lib/hook-timeouts.test.ts \
  --coverage --coverage.reportsDirectory=scratch/cov-probe-hook-timeouts \
  --coverage.all=false   # harmless if it truly no-ops per finding #2; keep until reproven either way
```

followed immediately by: (a) re-running the hash script above against
`coverage/` and diffing byte-for-byte against the baseline recorded here —
the load-bearing check; (b) reading
`scratch/cov-probe-hook-timeouts/coverage-summary.json["src/lib/hook-timeouts.ts"]`
specifically, never `.total`; (c) recording wall-clock and, if possible,
process count / peak RSS for that one invocation.

**Recommendation: the ban on agent-run `--coverage` STAYS as currently
worded.** Not because the hypothesis was falsified — it was not tested —
but because the two most load-bearing checks (the byte-identical hash
comparison, and process cost) are simply unproven, and this campaign already
treats an untested claim as equivalent to a false one for gating purposes
(§4, §6a throughout: no unit is marked resolved on an executing agent's
say-so). Task #16 stays open, now with a concrete next step — the candidate
file and exact command above — instead of an open-ended question, and with
one correction already banked: drop reliance on `--coverage.all=false`, and
whatever protocol eventually ships must instruct reading the touched file's
own entry, never `.total`.
