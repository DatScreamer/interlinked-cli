# Mutation-residue ledger — R3/W5/W5b/W6 campaign

> **Document role:** the campaign's capstone deliverable. Every number below is
> generated from the artifacts named in each section — the manifest, the
> receipts corpus, the two sound-prover sweeps, and the campaign chronology —
> not transcribed from prior prose. Where a prior document's claim could not be
> independently reproduced from these artifacts, that is stated explicitly
> rather than repeated. **No source code was edited, removed, or otherwise
> modified to produce this ledger.** Removal candidates in §5 are recorded
> only.

## Read this first: vocabulary, framing, and the live-sweep caveat

Vocabulary and the evidence ladder are defined in
[`session-2026-08-11-synthesis.md`](./session-2026-08-11-synthesis.md) Part 5
("Equivalent mutants: corrected conceptual model") and are used verbatim here:
the 10-state disposition table, the 4 routing buckets, the defense-in-depth
caveat for redundant trust-boundary guards, and the evidence-grade discipline
below. This ledger does not redefine those terms; it applies them.

**Evidence grades** (same table as the synthesis doc):

| Grade | Meaning |
|---|---|
| **Measured** | Produced by a named script/tool in this session against the live manifest or receipts corpus, with output saved under `scratch/ledger-analysis/`. |
| **Observed** | Directly present in a transcript, log, manifest, source file, or command registration, read but not statistically aggregated. |
| **Claimed** | Reported by an agent, a prior receipt, or the task brief, and not independently re-derived here. |
| **Proposed** | A recommendation or interpretation, not a measured fact. |

**Census-cutoff caveat — read before trusting any absolute count in this
document.** `.interlinked/mutation-manifest.json` is being actively
rewritten by a live sweep for the entire duration this ledger was written.
Three successive reads during this session, all against the same file:

| My read (wall clock, local EDT) | Manifest generation | Manifest `authoritativeAt` |
|---|---:|---|
| 10:17:45 | 1074 | 2026-08-14T14:17:00.852Z |
| 10:22:15 | 1080 | 2026-08-14T14:21:30.575Z |
| **10:25:07 (canonical for this document)** | **1090** | **2026-08-14T14:24:42.616Z** |

The manifest's file mtime was already climbing (`10:08:11`) before this
analysis began (first checked 10:08:33). Generation rose 16 steps in an
8-minute window with the represented file count **unchanged at 738** across
all three reads — the live sweep is re-measuring already-represented files,
not (yet, as observed) discovering new ones. Every absolute count in this
document is pinned to the **10:25:07 / generation 1090** read unless marked
otherwise; a re-run after the sweep completes will show different numbers by
design, not by error. The synthesis doc's Aug-13 23:23 EDT snapshot (generation
1005, also 738 files) is the nearest independent prior data point — 85
generations of churn since then produced no visible growth in file coverage,
which this document reports as an open question, not a resolved one (§8).

**Reproducibility.** Every number below was produced by one of eight scripts
under `scratch/ledger-analysis/` (`manifest-census.mjs`,
`campaign-file-mutants.mjs`, `make-campaign-file-list.mjs`,
`receipts-aggregate.mjs`, `find-before-snapshots.mjs`, `removal-candidates.mjs`,
`disposition-routing.mjs`, `compile-per-file-table.mjs`), each read-only
against `.interlinked/` and `scratch/fleet-r3/`, each writing only its own
JSON output back into `scratch/ledger-analysis/`. Re-running them reproduces
every table here (against whatever the manifest looks like at that moment).

---

## 1. Headline census

**Source:** `manifest-census.mjs` → `scratch/ledger-analysis/manifest-census.json`. Grade: **Measured**.

| Field | Value |
|---|---:|
| Engine / version | `stryker` / `unknown` |
| Dependency-graph version | `1` |
| Environment hash | `cli-measure` |
| Files represented | 738 |
| Total mutants | 111,749 |
| Killed | 91,285 |
| Survived | **17,378** |
| Uncovered | 2,099 |
| Timeout | 982 |
| Indeterminate | 5 |
| Mutants carrying a typed disposition (`disposition.ts` states) | **0** |
| Extra per-mutant keys beyond the 8 known fields | none observed |

Same weak-fingerprint finding the synthesis doc flagged still holds:
`engineVersion:"unknown"` and `environmentHash:"cli-measure"` are not proof-grade
identities. Zero typed dispositions confirms Part 5's "not implemented as a
public end-to-end path" finding is still current — every disposition in this
ledger is this document's own derived reading of the receipts corpus, not a
value read from a `disposition` field in the manifest (there isn't one).

**Survived-mutator mix, all 738 files (n = 17,378):**

| Mutator | Count | Share |
|---|---:|---:|
| ConditionalExpression | 5,194 | 29.9% |
| StringLiteral | 4,806 | 27.7% |
| Regex | 1,662 | 9.6% |
| EqualityOperator | 1,298 | 7.5% |
| LogicalOperator | 932 | 5.4% |
| MethodExpression | 880 | 5.1% |
| BlockStatement | 599 | 3.4% |
| ArrayDeclaration | 475 | 2.7% |
| ObjectLiteral | 360 | 2.1% |
| ArithmeticOperator | 346 | 2.0% |
| BooleanLiteral | 339 | 2.0% |
| OptionalChaining | 217 | 1.2% |
| ArrowFunction | 155 | 0.9% |
| UnaryOperator | 50 | 0.3% |
| UpdateOperator | 34 | 0.2% |
| AssignmentOperator | 31 | 0.2% |

## 2. Campaign scope — which files this ledger covers

**Source:** `make-campaign-file-list.mjs`, derived from
`scratch/fleet-r3/receipts/*.jsonl` filenames, cross-checked against each row's
own `file` field (not assumed from the filename). Grade: **Measured**.

29 files carry receipts from the R3/W5/W5b/W6 campaign, totaling **2,854**
raw receipt rows — an exact match to the task brief's "~2,854," which is
itself confirmation that the scope below is the intended one. **Excluded**:
three receipt files for `check-metadata/{generic-demo-data,
generic-react-warnings,suggestion}.ts` (124 rows) whose mtimes are
2026-08-14 ~10:13 — minutes before this analysis began, none of the three
files appear in `scratch/fleet-r2/verification-queue.txt` (the 32-file wave
list) or `worklist.json` (the 16-file W5 list), and their receipt corpus is
still being written as this document is finalized. That is a separate,
later, in-flight effort; folding its partial rows into this ledger's counts
would silently understate what remains and overstate what a future ledger
update should re-verify. It is out of scope here and should be picked up in
the next ledger revision once it settles.

The 29 files split into three campaign lanes by provenance:

- **16 W5 files** — `worklist.json`, "top non-wave survivor files," 1,855
  survivors at assignment.
- **3 W5b repair files** — `pre-checks-bash-write-detect.ts`,
  `server-tsgo-bash.ts`, `checks/cyclomatic.ts` — original wave-1-4 files
  whose test-selection scope was broken and repaired mid-campaign
  (`repair-followups.txt`).
- **10 W6-direct files** — original wave-1-4 files that went straight to the
  W6 cheapest-first residue-classification pass without needing a scope
  repair: `agent-laziness.ts`, `agent-safety-advanced.ts`,
  `gitignored-write.ts`, `iteration-safety.ts`, `performance.ts`,
  `property-testing.ts`, `taste-smell.ts`, `taste.ts`,
  `test-hygiene-quality-mock-only.ts`, `edit-diagnostics.ts`.

**Known mapping, honored:** `project-graph.ts`'s receipts (90 rows) were
written against a `project-graph.mutation-kill.test.ts` at authoring time;
that file no longer exists on disk (`ls` confirms), having been merged into
`project-graph.test.ts` (untracked, 20,756 bytes, mtime 2026-08-13) by a later
Codex session. `project-graph.ts`'s current survivor count (29, down from a
before-count of 90) is consistent with the merged file still carrying the
claimed test cases rather than losing them — the receipts remain valid
evidence per the task's explicit instruction, and this ledger treats them as
such throughout §4.

## 3. THE PER-RUNG ATTRIBUTION TABLE

**Sources:** `receipts-aggregate.mjs` → `receipts-summary.json` +
`rung-assignment.json`, joined against `scratch/fleet-r3/tce-receipts.jsonl`
(619 rows) and `scratch/fleet-r3/typeflow-receipts.jsonl` (325 rows). Grade:
**Measured**.

### 3.1 Deduplication

2,854 raw rows → **2,736 unique mutants** after deduping by `(file,
mutantId)`, keeping the strongest-evidence row per mutant (rank:
`killed_by_test` > `equivalent_candidate[exhaustive]` >
`equivalent_candidate[tce]` > `equivalent_candidate[fuzz_no_divergence /
fuzzInputs>0]` > `equivalent_candidate[no evidence field]` > `left_open`).
118 mutants carried more than one receipt row (re-attempted or upgraded
across waves).

**Chosen-row classification (n = 2,736):**

| Classification | Count |
|---|---:|
| `killed_by_test` | 2,151 |
| `equivalent_candidate` | 581 |
| `left_open` | 4 |

`decided_by` tag, where explicitly present (W6-contract-era rows only —
older R3-era rows carry no such field even when they ran the required fuzz
pass): `fuzz_no_divergence` 227, `fixture` 110, `exhaustive` 72,
`fuzz_divergence` 15. `fixture`/`fuzz_divergence` describe *how a kill was
found* (110 by a hand-written fixture, 15 incidentally during the mandatory
equivalence-fuzz pass itself); they are not part of the equivalence-candidate
rung table below.

### 3.2 The equivalence-candidate pool and its cheapest-deciding rung

**Deduped equivalence-candidate pool: 581 mutants.** (The task brief's
estimate was "~612"; 581 is the measured figure and is used throughout this
document — see the reproducibility note above for how to re-derive it.)

For every mutant in the pool, this ledger looks up whether the TCE prover or
the type-flow prover produced a **confirmed** verdict for that exact
`(file, mutantId)`; if neither did, the mutant is attributed to whatever the
fleet's own receipt recorded (`exhaustive` > `fuzz_no_divergence` > no
evidence field at all, labeled `structural-argument-only`):

| Rung | Mutants | Share of pool | What "deciding" means here |
|---|---:|---:|---|
| **tce** | **1** | 0.2% | esbuild-transform-and-byte-compare confirmed identical output |
| **typeflow** | **0** | 0.0% | `ts.TypeChecker`-based origin tracing confirmed a provably-inert guard |
| **exhaustive** | 72 | 12.4% | fleet receipt tagged `decided_by:"exhaustive"` (see §3.4 — this tag is not what it says on the label) |
| **fuzz_no_divergence** | 508 | 87.4% | ≥300 generated inputs (or an explicit `fuzzInputs` count), zero output divergence |
| **structural-argument-only** | 0 | 0.0% | classified `equivalent_candidate` with no `decided_by` tag and no `fuzzInputs` count |

**Headline finding: sound provers confirmed 1 of 581 (0.17%).** Everything
else in the pool rests on either an unbounded empirical search that found no
counterexample (508, 87.4% — Part 5's rung 6, "adds search evidence to
`unresolved`; it never upgrades itself to `proved_equivalent`") or a
human/agent-written prose argument that a machine never checked (72, 12.4% —
see §3.4). `structural-argument-only` measuring exactly zero is itself a
finding: every fleet receipt in this corpus attached *some* computable
evidence field before claiming `equivalent_candidate` — the contract
discipline held even where the evidence itself doesn't rise to proof.

**Per-mutator breakdown of the 581-mutant pool:**

| Mutator | Pool count | `exhaustive` | `fuzz_no_divergence` | `tce` |
|---|---:|---:|---:|---:|
| ConditionalExpression | 209 | 28 | 181 | 0 |
| Regex | 118 | 14 | 104 | 0 |
| EqualityOperator | 77 | 12 | 65 | 0 |
| StringLiteral | 57 | 1 | 55 | 1 |
| MethodExpression | 36 | 6 | 30 | 0 |
| LogicalOperator | 16 | 3 | 13 | 0 |
| ArrayDeclaration | 17 | 0 | 17 | 0 |
| BlockStatement | 18 | 1 | 17 | 0 |
| ArithmeticOperator | 13 | 3 | 10 | 0 |
| BooleanLiteral | 5 | 1 | 4 | 0 |
| UnaryOperator | 6 | 0 | 6 | 0 |
| OptionalChaining | 3 | 2 | 1 | 0 |
| ObjectLiteral | 2 | 1 | 1 | 0 |
| ArrowFunction | 2 | 0 | 2 | 0 |
| UpdateOperator | 1 | 0 | 1 | 0 |
| AssignmentOperator | 1 | 0 | 1 | 0 |

### 3.3 Honesty caveat 1 — the type-flow prover's origin-tracing limits

`typeflow-prover.mts`'s own header states its scope: it examines **only**
mutators in `{ConditionalExpression, LogicalOperator, EqualityOperator,
OptionalChaining}` — every other mutator (StringLiteral, Regex,
MethodExpression, …) is "not examined by this rung at all," by design, because
a type checker cannot speak to them. That is exactly `209+16+77+3 = 305` of
the 581-mutant pool (52.5%) — **the other 276 mutants (47.5%) were never a
candidate for a typeflow confirmation regardless of outcome.**

Within the 325 `not_provable` verdicts the prover actually issued (305 inside
this pool + 20 against mutants later independently killed, see §3.5), this
ledger classified each `reason` string by regex into two buckets:

| Reason category | Count | Share |
|---|---:|---:|
| **Implementation-coverage limit** — prover states it has no rule for this AST shape, or could not trace the value's origin at all (`"not a recognized … shape"`, `"AST shape … not a recognized guard atom"`, `"origin expression shape not supported"`, `"origin is a function parameter (length not traceable locally)"`) | 178 | 54.8% |
| **Semantically attempted, inconclusive** — the prover reasoned about the code and reached a real "can't confirm" (checker type still admits null/undefined, occurrences didn't unanimously agree, value may be reassigned) | 147 | 45.2% |

**Just over half of every `not_provable` verdict is the prover admitting it
doesn't have a rule for the shape in front of it — an implementation-coverage
gap, not a semantic finding that the mutant is unprovable.** Zero typeflow
confirmations should be read against that ceiling: the rung's current
narrowness (4 mutators, a handful of recognized guard shapes) bounds what it
could possibly have found, independent of whether more equivalences exist
that a broader implementation would catch.

### 3.4 Finding: the "exhaustive" tag is not bounded-domain enumeration, as recorded

`CONTRACT-W6.md` defines rung 3 precisely: *"Bounded-exhaustive when the
input domain is finite and small: enumerate ALL of it, diff full output...
this one IS a proof."* This ledger read the `why` text of all 72
`decided_by:"exhaustive"` rows and searched for enumeration language
(`enumerat*`, `all N combinations`, `tried every`, `full domain`, …): **0 of
72 (0%) matched.** All 72 read as manual structural, loop-invariant, or
control-flow case-analysis prose — e.g. *"MAX_DEPTH independently bounds
recursion depth so weakening this guard cannot even cause runaway
recursion... this direction is provably unobservable"* — reasoned by an agent,
never executed by a machine.

19 of the 72 (from a later pass, tagged `"pass":"W6-second"`,
`2026-08-14T13:15:20.699Z`) self-label their method `"proofMethod":"invariant"`
— an honestly narrower description than "exhaustive," and a closer match to
Part 5's rung 3 (type/control-flow proof) than rung 4 (bounded
exhaustiveness). The other 53 (earlier W6 pass, no `proofMethod` field) read
identically in substance without that label.

**Practical implication for the headline number:** the count of mutants with
a genuinely machine-checked equivalence proof in this corpus is **1** (TCE),
not 73. The 72 `exhaustive`-tagged mutants are better read as a stronger,
argued form of `structural-argument-only` — plausible, often carefully
reasoned, but unverified by any prover this campaign ran. This ledger keeps
them in the `exhaustive` rung above (faithful to what the receipt actually
records) rather than silently reclassifying them, and surfaces this finding
so a reader does not mistake the tag for the contract's stricter definition.

### 3.5 The pool is not static — provers examined mutants later killed anyway

Of the 572 unique `(file,mutantId)` keys the TCE prover ever touched, 29 are
no longer in the current equivalence-candidate pool: 28 are now classified
`killed_by_test` (a distinguishing test was found after TCE ran and failed to
confirm), 1 has no receipt at all. Of the 325 unique keys the type-flow
prover touched, 20 show the same pattern — all 20 are now `killed_by_test`.
**48 mutants that a sound-prover sweep could not confirm equivalent were
subsequently killed by ordinary test-writing, not by a stronger proof.** That
is independent evidence the campaign's kill-finding continued to make
progress after the prover sweeps ran, and a reminder that "not provable today"
is a timestamped statement, not a permanent one.

## 4. Per-file reconciliation

**Sources:** `worklist.json` (16 files), `find-before-snapshots.mjs` (16
independently-dumped `mutation survivors --json` snapshots, 10 of which
overlap `worklist.json` and match it exactly — a clean cross-check), 3
pre-W6-residue array dumps for files with no formal snapshot, and the
canonical manifest read for "current." Grade: **Measured**, with the "before"
column's provenance kind marked per row (`measured` = an explicit
timestamped snapshot exists; `measured-mid-campaign` = a snapshot exists but
was taken mid-campaign, not at true campaign start; `unrecorded` = no
snapshot found anywhere in the campaign artifacts — the number shown is a
**floor** equal to the count of distinct mutants the file's receipts
actually touch, not a true "before").

| File | Before | Kind | Kills reg. | Cand. held | Left open | Current survivors | Overclaims | Net change |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| checks/agent-laziness.ts | 47 | measured | 21 | 26 | 0 | 26 | 0 | 21 |
| checks/agent-safety-advanced.ts | 38 | measured | 8 | 30 | 0 | 34 | 4 | 4 |
| checks/assert-side-effects.ts | 99 | measured | 67 | 29 | 3 | 33 | 3 | 66 |
| checks/cyclomatic.ts | 153† | **unrecorded** | 143 | 10 | 0 | 15 | 1 | — |
| checks/gitignored-write.ts | 49† | **unrecorded** | 30 | 19 | 0 | 19 | 0 | — |
| checks/iteration-safety.ts | 32 | measured | 9 | 23 | 0 | 23 | 0 | 9 |
| checks/performance.ts | 20† | **unrecorded** | 10 | 10 | 0 | 10 | 0 | — |
| checks/property-testing.ts | 38† | **unrecorded** | 1 | 37 | 0 | 36 | 0 | — |
| checks/shared-scan.ts | 101 | measured | 79 | 22 | 0 | 23 | 1 | 78 |
| checks/shared-text-utils-brace-scan.ts | 106 | measured | 90 | 16 | 0 | 20 | 0 | 86 |
| checks/taste-smell.ts | 78 | mid-campaign | 19 | 38 | 0 | 39 | 1 | 39 |
| checks/taste.ts | 82 | measured | 15 | 67 | 0 | 67 | 0 | 15 |
| checks/test-hygiene-quality-mock-only.ts | 24 | mid-campaign | 12 | 12 | 0 | 12 | 0 | 12 |
| edit-diagnostics.ts | 37 | mid-campaign | 0 | 37 | 0 | 37 | 0 | 0 |
| evaluator/file-dump-guard-parse.ts | 90 | measured | 70 | 20 | 0 | 22 | 2 | 68 |
| findings/parse-finding.ts | 107 | measured | 102 | 5 | 0 | 6 | 0 | 101 |
| package-install-parser-pypi.ts | 94 | measured | 77 | 17 | 0 | 20 | 3 | 74 |
| package-install-parser.ts | 97 | measured | 78 | 19 | 0 | 23 | 4 | 74 |
| pre-checks-bash-write-detect.ts | 189 | measured | 179 | 10 | 0 | 23 | 1 | 166 |
| project-graph.ts | 90 | measured | 83 | 7 | 0 | 29 | 0 | 61 |
| sequence-checks/security.ts | 144 | measured | 133 | 11 | 0 | 11 | 0 | 133 |
| server-tsgo-bash.ts | 115 | measured | 114 | 1 | 0 | 1 | 0 | 114 |
| server/post-tool-file-checks-structural.ts | 107 | measured | 104 | 3 | 0 | 4 | 0 | 103 |
| supermodel-graph.ts | 98 | measured | 64 | 33 | 1 | 36 | 1 | 62 |
| taste-checks-test-assertions.ts | 183 | measured | 176 | 7 | 0 | 34 | 1 | 149 |
| trajectory.ts | 137 | measured | 101 | 36 | 0 | 49 | **13** | 88 |
| trajectory/helpers.ts | 161 | measured | 148 | 13 | 0 | 22 | **9** | 139 |
| hook-entry-cold-gates.ts | 92 | measured | 69 | 23 | 0 | 24 | 1 | 68 |
| registrars/quality.ts | 149 | measured | 149 | 0 | 0 | **0** | 0 | 149 |
| **Total** | **2,497‡** | | **2,151** | **581** | **4** | **698** | **45** | |

†Floor only — count of distinct mutants the file's receipts touch, not a
verified pre-campaign count; no snapshot for this file survives in the
campaign artifacts. ‡Sum over the 25 rows with a genuine `before` value only
(excludes the 4 floors, which are not comparable).

`registrars/quality.ts` is the one campaign file with **zero** current
survivors — every one of its 149 pre-campaign survivors is now killed.
`trajectory.ts` and `trajectory/helpers.ts` carry by far the heaviest
overclaim load (13 and 9) — see §5's overclaim breakdown.

**Scope-narrowing reappearances.** `repair-followups.txt` names two directly
diagnosed test-scope bugs (barrel-export blindness in `parseImports`; a
150-mutant test-scope cap that falls back to a naive 4-stem filename glob)
against three specific files: `pre-checks-bash-write-detect.ts`,
`server-tsgo-bash.ts`, `cyclomatic.ts`. Of those, `pre-checks-bash-write-detect.ts`
and `cyclomatic.ts` each carry exactly 1 overclaim — plausibly a direct
instance of the named bug. `server-tsgo-bash.ts` carries 0 overclaims (its
repair evidently landed cleanly). The manifest carries no per-mutant
measurement-history field (§1), so this ledger cannot mechanically
distinguish "killed once, then reappeared when scope narrowed again" from
"never actually killed" for the other 42 overclaims — that distinction needs
either a historical manifest snapshot or a fresh targeted remeasure, neither
of which this document performs.

## 5. Disposition routing (Part 5, four buckets)

**Source:** `disposition-routing.mjs`, joining every mutant currently
`status:"survived"` on a campaign file (698 total, canonical read) against
its deduped receipt verdict. Grade: **Measured**. Every current survivor is
routed; **no mutant is marked `proved_equivalent`** — per instruction, every
candidate is reported as *unresolved with N-input search evidence* at most.

| Bucket | Definition (Part 5) | Count | Share |
|---|---|---:|---:|
| 1 — Test/observation gap | present suite/observation misses the difference | **117** | 16.8% |
| 2 — Redundant behavior | reachable, no observable difference under current invariants | **538** | 77.1% |
| 3 — Inert/dead implementation | no supported effect; normally removed or completed | **42** | 6.0% |
| 4 — Policy/uncertainty residue | outside contract / accepted / duplicate / not yet adjudicated | **1** | 0.1% |
| **Total** | | **698** | 100% |

Bucket 1 (117) splits into two distinct shapes:

- **72 — untouched.** No receipt exists for this mutant anywhere in the
  campaign corpus. Default routing per Part 5's own framing: assume a real
  gap until an agent proves otherwise via the ladder.
- **45 — overclaimed.** A receipt claims `killed_by_test`, naming a specific
  test, but the mutant still shows `survived` in the canonical manifest read.
  Cross-checked against `repair-followups.txt`'s "Singleton overclaims for
  W6 pickup" section plus its 9 named `trajectory/helpers.ts` mutants: **all
  11 named mutant IDs are present in this ledger's 45** (100% match — a
  validation of the join, not a new finding on its own). The other **34**
  are newly surfaced by this ledger's mutant-level join and were not
  individually named in prior campaign tracking. §4's scope-narrowing note
  applies: some fraction of the 34 most likely share `helpers.ts`'s
  diagnosed "shadow-kill did not translate to suite-kill" root cause (a
  standalone shadow-runner confirming a kill that the real Stryker-measured
  suite does not), but this ledger did not re-run the suite per-mutant to
  confirm that mechanically for each of the 34 — flagged for task #10
  (affected-test-selection parser gaps).

Bucket 3's 42 mutants are exactly the `equivalent_candidate` rows (any rung)
whose argument text reads as dead/unreachable/unused code by regex scan —
the same detection used to build §6's removal-candidate appendix, so every
bucket-3 mutant below also appears there (minus the ones flagged
defense-in-depth-keep).

Per-file bucket counts are in `scratch/ledger-analysis/disposition-routing.json`
(`perFileBucketCounts`); the two heaviest bucket-1 files are `trajectory.ts`
(13 overclaims + 0 untouched of its 49 current survivors) and
`agent-safety-advanced.ts` (4 overclaims among 34 current survivors).

## 6. Removal-candidate appendix

**Source:** `removal-candidates.mjs`, scanning every `equivalent_candidate`
row's `why` text for dead/unreachable/unused language, grouped by
`(file, symbol, argument-text)` since many mutants at one guard site share
one argument. Grade: **Measured** for the grouping and counts; the argument
text itself is **Claimed** (an agent's prose, not machine-verified — see
§3.4). **Recorded only — nothing below has been removed.**

**31 distinct arguments (42 mutants) read as dead/unreachable/unused code.**
23 of the 31 groups (27 mutants) sit in ordinary internal helper code with no
security relevance. **8 groups (15 mutants) sit in security-adjacent files
and are flagged defense-in-depth-keep, not removal candidates**, per Part 5's
explicit caveat that a redundant trust-boundary guard can be a deliberate
second line of defense even when currently inert:

| File | Symbol | Mutants | Argument (truncated) | Invalidation trigger |
|---|---|---:|---|---|
| `checks/agent-safety-advanced.ts` | `checkDefaultExport` | 6 | every candidate line already passed the per-line scan's literal `"export default"` gate before reaching this regex | if the upstream literal-string gate is removed or loosened |
| `checks/agent-safety-advanced.ts` | `checkCircularImports.dfs` | 3 | `cycles.length>=MAX_PATHS` guard is masked by an identically-worded sibling guard checked before every push; `MAX_DEPTH` independently bounds recursion | if the sibling guard or `MAX_DEPTH` constant is removed |
| `checks/agent-safety-advanced.ts` | `checkDefaultExport` | 1 | `stripComments` preserves line count/index correspondence by its own documented contract | if `stripComments`'s 1:1 index contract changes |
| `checks/agent-safety-advanced.ts` | `checkDefaultExport` | 1 | (same regex-gate argument as the 6-mutant row above, different mutator) | same as above |
| `checks/agent-safety-advanced.ts` | `checkLifecycleCleanup` | 1 | `stripCommentsAndStrings` preserves line count/index correspondence by its own documented contract | if that contract changes |
| `package-install-parser.ts` | `stripWrappers` | 1 | `next` is only read immediately after `out.shift()` on an element the while-condition already confirmed truthy | if the shift/read ordering changes |
| `package-install-parser.ts` | `stripWrappers.consumeEnvVar` | 1 | only ever called with a string already matched against `/^[A-Za-z_]\w*=/`, guaranteeing `indexOf('=')>=1` | if the call site's pre-match regex changes |
| `package-install-parser.ts` | `stripWrappers.consumeEnvVar` | 1 | same unreachable-guard class as the row above (different mutator, same site) | same as above |

The strongest single removal candidate in the whole pool is the **one
TCE-confirmed mutant**: `checks/cyclomatic.ts`, mutant `0dd98cf16082dc3d`
(StringLiteral on a `CLOSE_BRACE` module constant) — three independent
signals agree: grep-verified never referenced anywhere in the file, a
compiler-level byte-identical transform (TCE), and 320/320 zero-divergence
fuzz. This is the one mutant in the entire pool with machine evidence at
every rung available, not just a prose argument.

The remaining 23 non-security groups (27 mutants, spread across
`gitignored-write.ts`, `iteration-safety.ts`, `shared-scan.ts`,
`taste-smell.ts`, `edit-diagnostics.ts`, `test-hygiene-quality-mock-only.ts`,
`property-testing.ts`, `cyclomatic.ts`) are internal helper-function guard
clauses argued unreachable given an invariant elsewhere in the same function
— full list with exact mutant IDs and untruncated arguments in
`scratch/ledger-analysis/removal-candidates.json` (`groupedDeadCode`).

## 7. Cost accounting

**Sources:** workflow token/agent counts as given in the task brief (Grade:
**Claimed** — reported by the launching orchestrator; the one cross-checkable
figure, W5b's "984k tok, 3 agents," matches `CAMPAIGN-survivor-r3.md`'s own
text exactly, which is the only independent corroboration available in this
session). Kill/candidate counts are this ledger's own **Measured** figures
from §3.1.

| Wave | Tokens | Agents |
|---|---:|---:|
| W5 | 6,350,000 | 17 |
| W5b | 984,000 | 3 |
| W5c | 619,000 | 3 |
| W6 + W6-second ("W6b") | 3,830,000 + 2,740,000 | 12 (combined; provers included) |
| **Total** | **14,523,000** | **35 agent-runs** |

| Unit cost (blended over the whole campaign spend — not separately budgeted lanes) | Denominator | Tokens/unit |
|---|---:|---:|
| Cost per registered kill | 2,151 `killed_by_test` | **≈6,752** |
| Cost per classified candidate | 581 `equivalent_candidate` | **≈24,997** |
| Cost per classified mutant (any disposition) | 2,736 deduped | **≈5,308** |
| (footnote: per raw receipt row, before dedup) | 2,854 | ≈5,089 |

Candidates cost roughly **3.7×** what a registered kill costs per unit —
consistent with the ladder's own design: a candidate is reached only after a
kill attempt already failed (CONTRACT-W6's step ordering), so its token cost
includes the failed kill attempt plus the fuzz/exhaustive/prover pass on top.
These are blended figures across mixed-output agent work, not a claim that
kill-production and candidate-production draw from separate budgets.

## 8. What remains

**Sources:** `manifest-census.json` (`allFileSurvivedRanked`, all 738 files),
`heavy-excluded.txt` cross-referenced against the canonical manifest read,
and `session-2026-08-11-synthesis.md` Part 2 for historical eligible-file
context. Grade: **Measured** for current-manifest figures; **Claimed**
(historical, dated) for the eligible-file total.

**The campaign moved its 29 files from outlier-high to near-median, but they
were always a targeted, non-representative sample.** All 22 files with a
genuine snapshot were selected explicitly as "top survivor-count files"
(before range 32–189, mean 99.2/file) — the *lowest* of those 22 before-counts
(32) is still 1.6× today's global per-file median (20, across all 738 files;
mean 23.55, p90 49, p99 77, max 175). Today those same 29 files hold 698
combined survivors — 4.02% of the global 17,378 — a mean of ~24.1/file,
almost exactly at the current global median. **This is real, measured
progress on these 29 files; it licenses no claim about the other 709.** By
current rank the 29 files span the 3rd-percentile to the 99th (ranks 18–734
of 738, median rank 326 = 55.8th percentile) — no longer clustered at the
extreme, which is itself evidence the campaign worked, not evidence the
remaining backlog looks like these files.

**Backlog: 709 non-campaign files, 16,680 survivors (95.98% of the global
total).** Its mutator mix is nearly identical to the global mix (campaign
files are now too small a share to move the aggregate): ConditionalExpression
29.7%, StringLiteral 28.4%, Regex 9.1%, EqualityOperator 7.3%, LogicalOperator
5.4%, MethodExpression 5.0%, and the same long tail as §1.

**Ranked queue — top 10 non-campaign files by current survivor count** (the
mechanical next-wave input, computed fresh from the canonical read, not the
task brief's illustrative list):

| Rank | File | Survivors / total |
|---:|---|---:|
| 1 | `src/harness/checks/introverted-test.ts` | 175 / 424 |
| 2 | `src/harness/checks/ubs-language-specific/rust-go-checks.ts` | 116 / 264 |
| 3 | `src/harness/checks/placeholder-constants.ts` | 91 / 413 |
| 4 | `src/harness/pre-checks.ts` | 87 / 338 |
| 5 | `src/harness/evaluator/edit-doom.ts` | 82 / 236 |
| 6 | `src/commands/design.ts` | 79 / 202 |
| 7 | `src/commands/structure.ts` | 77 / 432 |
| 7 | `src/registrars/setup.ts` | 77 / 188 |
| 9 | `src/harness/evaluator/permission-patterns.ts` | 73 / 207 |
| 9 | `src/harness/payload-key-census.ts` | 73 / 208 |

**Unmeasured heavy tail.** The Aug-12 straggler pass flagged 402 files as too
heavy for the completed run (`heavy-excluded.txt`). Cross-referenced against
today's canonical manifest: **only 34 of those 402 (8.5%) now carry any
mutation provenance; 368 (91.5%) remain completely unmeasured.**

**Census completeness — explicitly incomplete, not re-verified fresher here.**
The synthesis doc's Aug-13 23:23 EDT reading (generation 1005) found 738
represented files against 1,118 known-eligible source files (≈66%). Today's
canonical read (generation 1090) shows the same 738 represented files — 85
generations of churn with no observed growth in coverage. This document did
**not** re-run `mutation sweep --all-eligible` to get a fresher eligible-file
total (out of scope for a documentation task, and would itself race the live
sweep), so it cannot state today's exact completeness fraction — this is
recorded as an open gap, not papered over with the stale 66%.

**Standing catch-up plan — `golden-gen`.** A new tool under
`scratch/fleet-r3/golden-gen/` (`manifest-reader.mts`, `ts-scan.mts`,
`serialize.mts`, `generate.mts`, `shadow-verify.mts`,
`eligibility-scan.mts`) was **actively being built during this analysis** —
its earliest files date 10:06–10:07 local, and `generate.mts`/
`shadow-verify.mts`/`eligibility-scan.mts` appeared only partway through this
session. Per its own header comments, it is a deterministic StringLiteral-class
kill-companion generator for pure-data modules (files whose exports are one or
more `export const X: Record<string, T> = {...}` tables): it reads the
manifest for `StringLiteral` survivors on a target file, locates the exact
site via the TypeScript compiler API, and writes a generated companion test
whose expected value is captured live from the running module (never
hand-transcribed) — then empirically shadow-verifies its own output the same
way the fleet's kill attempts were verified in §3. It is piloted against
exactly the 3 files this ledger excluded from scope in §2
(`check-metadata/{generic-demo-data,generic-react-warnings,suggestion}.ts`),
and had not produced a measured, landed result as of the canonical read.
StringLiteral is the second-largest backlog class (28.4% of the 709-file
backlog, 4,732 survivors) — a working, deterministic generator for it,
proven out on 3 files first, is the correct next lever before scaling to the
709-file backlog, ahead of another hand-authored agent fleet.
