# 20. Harness-coverage report — measuring whether a quiet check is clearance or a blind spot

**Status:** design memo. Nothing in `src/` was written or changed for this
document. Every current-state claim below carries a `file:line` citation and was
verified against the working tree on 2026-08-14. Every number in §1 was produced
this session by the commands shown; none is inherited from a prior doc.

**Backlog position:** item 3 of the ranked product backlog in
`docs/design/session-2026-08-11-synthesis.md:170` ("Harness-coverage report —
applicability, executions, skips, suppressions, yield, adjudicated false
positives, and blind spots"), and design principle 2 at `:159` ("Measure sensor
coverage, not only sensor fire rate"). Recommended decision 6 at `:495` puts it
before adding more detectors.

---

## 0. Depends on / feeds

**Depends on — nothing blocking.** M0 reads only files that exist today and adds
no `src/` module that another memo owns. It can land first, last, or in
parallel.

- **Soft dependency on the evidence-ledger memo**
  (`docs/plans/18-verification-evidence-ledger.md`). That memo's
  `EvidenceSubjectKind` already reserves `"check"` — "one registered check id —
  federates check-evidence-baseline.json". (Cited by SYMBOL, not line: that memo
  is being written concurrently and its line numbers moved between two reads
  during this session.) The adjudication verdicts designed here in §3.1 are the
  natural first population of that kind: an adjudication is an `attested`
  claim — that memo's `ClaimStrength` member for a human approval artifact the
  agent cannot manufacture — about a `check` subject, with
  `invalidatedBy: ["sourceHash"]` bound to the detector's own text. **This memo
  does not build that adapter.** It keeps its own append-only ledger with its
  own identity scheme (which it inherits from `check-evidence/corpus.ts`, not
  mints), and exposes a pure projection function so the ledger memo's M1 can
  fold it in without touching the writer. If the ledger lands first, M2 here
  writes through it instead of beside it — a one-module change, not a redesign.
- **Hard reuse of `src/harness/check-evidence/`** (already shipped, §2.4). The
  adjudication vocabulary, the hit-signature scheme, and the corpus scanner all
  exist. Duplicating any of them is a defect, not a milestone.

**Feeds:**

- **The dispositions memo** (`docs/plans/18-mutation-disposition-registration.md`)
  and this one share exactly one shape: a human-signed verdict about a machine
  finding, stored append-only, invalidated by a source hash. They do **not**
  share a ledger — a mutant disposition and a check adjudication have different
  subjects and different invalidation inputs. What this memo feeds back is the
  *gaming* analysis: §4.5 below extends `baseline_integrity_gate` with an
  append-only-file kind that the dispositions memo's §2.6 also needs.
- **The test-receipts memo** (`docs/plans/19-test-receipt-blinded-review-machine.md`)
  consumes the `clear`-verdict qualification from M5: a check whose detector has
  no mutation score cannot be reported as proven-clear, which is the same
  "coverage is not distinction" argument the receipts memo makes about tests.
  No code dependency.
- **`cross-repo-validate`** (skill, already built — cited at
  `docs/plans/06-cloud-metrics-program.md:30` and
  `docs/design/bun-regression-detectors.md:414`). M4 defines the artifact
  contract that skill writes so its results become this report's portability
  column instead of a transient agent message.
- **The integrator agent:** sequence M0 anywhere. M2 should follow the
  evidence-ledger memo's M0 if both land in the same tranche, purely to avoid
  writing the projection twice.

---

## 1. Problem + evidence

### 1.1 The question, and why the repo cannot answer it

`CLAUDE.md` states the fire-rate thesis as a binding constraint:

> **A check that never fires in this repo is not dead weight, and must not be
> retired or demoted for being quiet.** … **Fire rate measures the AGENT, not
> the check.**

The external-pulse intake records the strongest available challenge to it
(`docs/external-pulse/harness-engineering.md:145`): Böckeler's rule is the
literal opposite — "Which sensors are never failing? → a signal they are not
necessary" — and the intake's own recommendation is to "make it evidence-based
… a quiet check earns its keep only if it fired on *some* corpus".

Both positions are currently unfalsifiable in this tree, because **the harness
records fires and nothing else.** A quiet check is today indistinguishable
across four states with opposite meanings:

| State | Meaning | Correct response |
|---|---|---|
| No applicable population | No file in this repo qualifies (a Rust check in a TS repo) | Get a foreign corpus. Not evidence about the check. |
| Never executed | Registered but never dispatched — a wiring defect | **Fix the bug.** |
| Detector crashes | Throws on real source; contributes silent zeros | **Fix the bug.** |
| Executed and clear | The agent genuinely clears it | The fire-rate thesis's home. Keep. |

Two of these four are **bugs the harness is currently blind to**, and they are
reported identically to the state the fire-rate thesis is protecting. That is the
real cost of the missing report: not that quiet checks might be useless, but that
**broken checks look exactly like clean ones.**
`check-evidence/corpus-scan.ts:49-54` already states this in its own comment for
one narrow surface — "a detector that crashes on real source is silently
contributing zero findings for that file, which looks identical to 'clean' in
every downstream count."

### 1.2 Measured scale of the blind spot

All figures produced 2026-08-14 by a read-only probe written for this memo
(`scratch/harness-coverage-census.mts` — **gitignored**, so the reproduction
recipe is inlined below rather than left as a path a fresh clone cannot resolve).
Reproduce before trusting; these are point-in-time counts over a growing log.

```bash
# registry total (384) and per-family counts
interlinked harness checks --json | jq '.total, [.families[]|{key,count}]'

# distinct check ids that ever fired at the edit gate (4.2 MB file — safe to stream)
grep -o '"id":"[^"]*"' .interlinked/check-results.jsonl | sort -u | wc -l

# sweep-only ids: fired on the codebase scan but never at the edit gate
tail -n 200000 .interlinked/recurrences.jsonl | grep '"kind":"harness_caught"' \
  | grep -o '"check_id":"[^"]*"' | sort -u > /tmp/caught.txt
tail -n 200000 .interlinked/recurrences.jsonl | grep '"kind":"codebase_existing"' \
  | grep -o '"check_id":"[^"]*"' | sort -u > /tmp/scan.txt
comm -13 /tmp/caught.txt /tmp/scan.txt        # -> 19 ids

# corpus store: records / hits / adjudications
jq '[.checks|length, ([.checks[].hits]|flatten|length),
     ([.checks[].adjudications|length]|add)]' .interlinked/check-corpus.json
```

The per-family intersections in the table (96 inline fired, 43 with no evidence
from either surface) need the inline id set, which is what the probe adds: it
imports `CHECK_REGISTRY`, intersects its ids against the two sets above, and
prints the counts. Roughly 35 lines, no writes.

| Quantity | Value | Source |
|---|---|---|
| Registered checks, all families | **384** | `interlinked harness checks --json` → `total` |
| Inline `CHECK_REGISTRY` ids | 259 | same, family `inline` |
| Distinct ids that ever fired at the edit gate | **138** | `check-results.jsonl`, 14,459 rows, 2026-06-24 → 2026-08-14 |
| …of which inline | 96 | census probe |
| Inline checks that never fired at the edit gate | **163 of 259** | census probe |
| Inline checks with a corpus record | 153 | `.interlinked/check-corpus.json` |
| …that scanned **zero hits** over 1,089 real files | **135** | census probe |
| Inline checks with **no corpus record at all** | 106 | census probe |
| Inline checks quiet on **both** live and corpus surfaces | **159** | census probe |
| Inline checks with **no evidence from either surface** | **43** | census probe |
| Adjudicated verdicts recorded anywhere in the repo | **0** | `check-corpus.json`, 236 hits, 0 adjudications |

So: **159 of 259 inline checks are quiet on every surface the repo observes, and
the repo has no mechanism that can say which of the four states above any of
them is in.**

### 1.3 The evidence that does exist is scattered across three uncorrelated logs

Three surfaces record check activity, and nothing joins them. Concretely, of the
first 15 ids the census reports as having *no evidence from either* the edit gate
or the corpus store, **three did fire** on a third surface — the
`recurrence scan --record` codebase sweep recorded in `recurrences.jsonl`:

```
comment_claims_limit_no_guard
introverted_test
procfs_probe_in_test
```

(verified: `comm -12` of the sweep's distinct `check_id` set against the dark
list). More broadly, comparing the two recurrence kinds: **19 check ids appear in
`codebase_existing` sweep rows but never in a `harness_caught` edit-time row** —
they catch inherited code and have never caught the agent. That is a genuine,
actionable distinction (`eval_usage`, `ubs_sql_string_concat`,
`ubs_tls_verify_disabled`, `tautological_assertion`, `empty_catch`, …) and today
it is visible only to someone who writes the `comm` by hand.

### 1.4 The one governance surface that exists points only downward

`interlinked harness health` (`src/commands/harness-health.ts`) is the only
per-check report in the tree. Measured this session:

```
$ interlinked harness health --short
157 check ids graded, 27 probation candidate(s)
```

Three problems, all verified:

1. **It grades 157 of 384.** It folds only `harness_caught` rows
   (`check-health.ts:205-213` requires `kind === "harness_caught"`), so a check
   that never fired is not a row — it is *absent*. The population the question
   is about is precisely the population it cannot see.
2. **Its only verdict is demotion.** The status union is
   `"probation-candidate" | "healthy" | "low-data"`
   (`check-health.ts:20`), and the render calls the section "Probation
   candidates … demote to advisory or refine detection"
   (`harness-health.ts:115`). It is a well-built DOWN-direction signal — the
   module comment says so at `check-health.ts:6-9` — and it is currently the
   whole of check governance.
3. **Its pointer in `harness checks` is silently off.**
   `harness-checks.ts:25` caps the probation summary at
   `PROBATION_LOG_MAX_BYTES = 5 * 1024 * 1024` and returns 0 above it
   (`:35`). `.interlinked/recurrences.jsonl` is **53,407,801 bytes**. Verified:
   `interlinked harness checks` prints no probation line today despite 27 live
   candidates. A size guard degraded to silence rather than to a caveat.

### 1.5 The corpus obligation is stalled for want of a verb

`.interlinked/check-corpus.json` is committed (git-tracked, carved out at
`.gitignore:189-194`) and holds **155 check records / 236 hits / 0
adjudications**. `check-evidence/corpus.ts:14-15` calls the unadjudicated state
"the failure state: the detector fires on real code and nobody has decided
whether that was correct."

The reason is mechanical, not editorial: **there is no command that runs a corpus
scan or records a verdict.** `recordCorpusScan`, `scanCorpus`, `saveCorpusStore`,
and `loadCorpusStore` (`check-evidence/corpus-scan.ts:79,108,119,124`) have zero
callers outside `check-evidence/` — verified by `rg` across all of `src`. The
adjudication *type* has shipped; the adjudication *act* has no surface.

---

## 2. Current state (verified, file:line)

### 2.1 What is recorded per tool call — fires only, never executions

`src/harness/check-results-sink.ts:67-75` builds each row's `checks[]` array by
mapping `decision.check_results` — i.e. **findings**. A check that ran and
produced nothing contributes no entry. The row's only execution-ish field is
`ran` (`:87`), set to `ranList.length`.

That list is not per-check. `checks_ran` is assembled in
`src/harness/server/post-tool-pipeline.ts:271` as `[...new Set(checksRan)]`, and
its members are coarse pipeline/tool names — the pinning test asserts
`["structural", "typescript"]`
(`post-tool-pipeline.test.ts:1182`), and the trajectory pushes are literal
strings `"silent-failure"`, `"context-bloat"`, `"consecutive-errors"`
(`post-tool-pipeline.ts:161,171,181`).

**Consequence:** the tree has no record, anywhere, of an inline detector having
been invoked. `executed` is not a field that is empty; it is a field that does
not exist.

### 2.2 Where applicability is actually decided — and discarded

`src/harness/check-registry/builders.ts:68-72` is the dispatch. It is a filter
chain, and each link is a distinct, nameable reason a check did not run:

```
.filter((c) => c.pipeline === "agent_safety")                    // :68
.filter((c) => !phase || c.phase === phase)                      // :69
.filter((c) => !(skipWarnings && c.severity === "warning"))      // :70  whitespace-only diff
.filter((c) => !coldFileMode || c.determinism === "fully_deterministic") // :71
.filter((c) => matchesContentKeywords(c.content_keywords, lcContent))    // :72
```

The function returns the survivors and throws the rest away. **The skip reasons
already exist as code; they have never been named as data.** This is the single
most important fact in the memo: M1 does not invent a taxonomy, it labels
branches that ship today.

`content_keywords` is documented at `check-registry/types.ts:73-91` as the
per-content applicability gate. Note what it means for measurement: a check with
keywords that never appear in this repo reports `executed = 0` for a *legitimate*
reason, and one whose keywords are subtly wrong reports the same thing for a bug.

### 2.3 There is no declared applicability metadata

`CheckRegistration` (`check-registry/types.ts:33-92`) has no language, extension,
or file-glob field — verified by grep for `languages|extensions|appliesTo|file_match`
across `types.ts` and `check-metadata.ts` (no matches). Applicability is
*emergent*, from `content_keywords` plus whatever the detector's own `fn` does
with its `filePath` argument. **Any design that assumes a declared applicability
field is wrong.** Applicability must be measured by running the gate, not read
off metadata.

### 2.4 The adjudication vocabulary already exists — reuse it, do not re-mint it

`src/harness/check-evidence/corpus.ts`:

| Symbol | Line | What it already gives us |
|---|---|---|
| `Adjudication = "true_positive" \| "false_positive"` | `:36` | The verdict vocabulary, verbatim |
| `AdjudicationRecord { verdict, note? }` | `:39-43` | Per-hit verdict shape |
| `CorpusRecord { files_scanned, hits, adjudications }` | `:46-54` | `files_scanned` exists **specifically** so "an empty scan is distinguishable from a clean one" (`:48`) — applicability, already modelled |
| `CHECK_CORPUS_PATH` | `:62` | `.interlinked/check-corpus.json`, committed |
| `hitSignature({file, text})` | `:75-81` | Stable finding identity: `sha256(file + " " + whitespace-normalized text)`, **deliberately excluding the line number** so an unrelated edit above a hit does not invalidate its verdict (`:70-74`) |

`corpus-scan.ts` adds the scanner: `isScannable` (`:31-37`, excludes `.d.ts`,
tests, `__fixtures__`), `scanCorpus` (`:79-105`), and `DetectorFailure`
(`:40-43`) — the crash channel.

`recall.ts` and `adversarial.ts` supply the two dimensions that qualify a clean
result: derived case floors + detector mutation score (`recall.ts:1-23`), and a
source-hash-bound FP hunt that "goes stale automatically" when the detector is
rewritten (`adversarial.ts:14-18`). **The adversarial module's source-hash
binding is the exact invalidation primitive an adjudication needs**, and §3.1
copies it rather than inventing one.

One caveat for M5: `recall.ts:31` sources scores from
`MUTATION_BASELINE_PATH = ".interlinked/mutation-baseline.json"`, and that file
**does not exist** in this repo (verified). The mutation dimension therefore has
no data source locally today.

### 2.5 Suppression machinery — parsed, honored, never counted

`src/harness/suppressions.ts` implements three distinct silencing mechanisms:

| Mechanism | Function | Line | Semantics |
|---|---|---|---|
| `// interlinked-ignore: <check> — reason` | `scanInlineSuppressions` | `:53-85` | Finding never surfaces |
| `// interlinked: defer <check>` / `# …` | `scanInlineDeferrals` | `:126-160` | Finding still logged; amplification suppressed (`:91-98`) |
| `.interlinked/verify-suppressions.json` | `loadFileSuppressions` | `:205-237` | File-level, glob-capable |

`isSuppressed` (`:319-336`) is the decision point. It returns a boolean and
records nothing.

Live counts, verified this session: **14** real leading-comment
`interlinked-ignore` directives and **52** `interlinked: defer` markers across
`src/**/*.ts`; `.interlinked/verify-suppressions.json` **does not exist**, so
file-level suppressions are currently zero. The `defer`/`ignore` ratio (52:14) is
itself a governance signal nobody can see today.

### 2.6 The inventory is counts-only

`getCheckInventory()` (`check-inventory.ts:57-128`) collects per-family id arrays
internally (`:61-70`) and returns only `count` per family plus a DISTINCT-union
`total` (`:118-126`). **The ids are computed and discarded.** A per-check report
needs the id sets; exporting them is a small, additive change (§4.1), and
`check-inventory.test.ts` pins the counts so the pin must grow with it.

### 2.7 Existing CLI surfaces and what each is for

| Surface | File | Contract |
|---|---|---|
| `interlinked harness checks` | `commands/harness-checks.ts:1-4` | "Static (no daemon needed)" inventory printer. Explicitly a fast, IO-light surface. |
| `interlinked harness health` | `commands/harness-health.ts` | Streams `recurrences.jsonl` line-by-line (`:63-73`); grades fires; DOWN direction only. |
| `interlinked recurrence` | `commands/recurrence.ts` | Append-only JSONL + on-demand deterministic aggregation, **no cache** — the pattern this memo follows. |
| `interlinked query` | catalog verified by running it | Generic bounded log reader: 12 named sources, "newest 20k records / 64 MB tail", footer always states what was scanned. |

Registration pattern for a new `harness` subcommand is at
`src/registrars/harness.ts:58-82` (`checks` and `health` are adjacent examples,
both lazy-`import()` their command module).

### 2.8 Storage policy facts that bind the design

- `.gitignore:171` blanket-ignores `.interlinked/*`; carve-outs follow at
  `:172-196`. **11** files are git-tracked (verified by `git ls-files`), not the
  8 that `.interlinked/INDEX.md:67` claims — that line is stale.
- The `check-corpus.json` carve-out comment (`.gitignore:189-194`) states the
  governing principle for this memo's ledger verbatim: "the adjudication
  verdicts inside it are reviewed judgments and belong in PR diffs like any
  other policy record."
- `baseline_integrity_gate` protects nine baseline kinds via `BASELINE_RE`
  (`evaluator/baseline-integrity-gate.ts:45-46`), including
  `check-evidence-baseline`. **`check-corpus.json` is NOT among them** — the
  file whose adjudications the evidence contract reads is currently
  agent-writable with no direction constraint. That is a pre-existing hole this
  memo must not widen (§4.5).

---

## 3. Design

### 3.1 Data shapes

**UNVERIFIED SKETCH.** No file below has been written or type-checked. These are
proposals for review; per this task's constraint no `src/` edits accompany the
memo.

#### The skip taxonomy — naming branches that already exist

```typescript
// src/harness/coverage-report/types.ts — PROPOSED

/**
 * Why a registered check did not run against a given file. Every member maps
 * to a filter that ships TODAY in check-registry/builders.ts:68-72 or an
 * adjacent dispatch — this union NAMES existing branches, it adds none. A new
 * filter link in builders.ts must add a member here or the fold stops
 * accounting for it (enforced by the exhaustiveness pin, §6).
 */
export type CheckSkipReason =
	| "pipeline_mismatch"     // builders.ts:68 — c.pipeline !== dispatching pipeline
	| "phase_mismatch"        // builders.ts:69 — phase filter
	| "whitespace_only_diff"  // builders.ts:70 — diff-class skip, warnings only
	| "cold_file_heuristic"   // builders.ts:71 — coldFileMode drops non-deterministic
	| "content_keywords"      // builders.ts:72 — keyword pre-filter missed
	| "advisory_gate"         // DEFAULT_ADVISORY_SKIPS — verify default run
	| "verify_only"           // VERIFY_ONLY_CHECKS — never on the hook path at all
	| "file_suppressed"       // verify-suppressions.json entry covers the file
	| "not_scannable";        // corpus/sweep surface rejected the extension

/**
 * Where an observation came from. Surfaces are NOT interchangeable and are
 * never summed into one number: a corpus sweep sees every file once with no
 * agent involved, while the edit gate sees only what an agent touched. A
 * report that adds them produces a fire "rate" with no denominator.
 */
export type CheckObservationSurface =
	| "pre_tool"   // PreToolUse content gate
	| "post_tool"  // PostToolUse file checks
	| "verify"     // interlinked verify
	| "corpus"     // check-evidence corpus scan — offline, whole tree
	| "sweep"      // recurrence scan --record — offline, whole tree
	| "foreign";   // cross-repo-validate — a tree that is not this one
```

#### Per-surface counters — pure counts, no verdicts

```typescript
/** One check's counters on ONE surface over ONE window. Every field is a
 *  count of an observed event; nothing here is derived or judged. */
export interface CheckSurfaceCounters {
	/** Opportunities where the gating predicate ADMITTED the file. The
	 *  denominator. Generalizes CorpusRecord.files_scanned (corpus.ts:47). */
	applicable: number;
	/** Times the detector fn was actually invoked. */
	executed: number;
	/** Invocations that produced >= 1 match. */
	fired: number;
	/** Total matches produced (>= fired). */
	findings: number;
	/** Findings that produced a block/ask decision. */
	blocked: number;
	/** Findings surfaced as warnings. */
	warned: number;
	/** Findings dropped by `// interlinked-ignore` (suppressions.ts:319). */
	suppressed_inline: number;
	/** Findings dropped by verify-suppressions.json. */
	suppressed_file: number;
	/** Findings acknowledged by `// interlinked: defer` — logged, not silenced. */
	deferred: number;
	/** Invocations where the detector THREW. Never folded into `fired`;
	 *  a crash is a silent zero, not a clean result (corpus-scan.ts:49-54). */
	detector_failures: number;
	/** Distinct files touched. */
	files: number;
	/** Distinct sessions — live surfaces only; 0 for corpus/sweep/foreign. */
	sessions: number;
}
```

#### The verdict union — the anti-goal, encoded in the type system

```typescript
/**
 * The report's classification of one check.
 *
 * There is deliberately NO member meaning "retire", "dead", or "demote". The
 * union is the enforcement mechanism for the fire-rate thesis (CLAUDE.md):
 * a downstream switch cannot produce a retirement recommendation because no
 * value of this type carries one. Adding such a member is a policy change
 * that must be argued in a design doc, not a refactor.
 *
 * `no_population` and `clear` are the two states the thesis protects.
 * `never_executed` and `broken` are BUGS. Separating them is the whole point.
 */
export type CheckCoverageVerdict =
	| "no_population"   // applicable === 0 on every observed surface
	| "never_executed"  // applicable > 0 but executed === 0 — WIRING DEFECT
	| "broken"          // detector_failures > 0 and fired === 0 — DETECTOR DEFECT
	| "clear"           // executed > 0, fired === 0 — the agent clears it
	| "ungraded"        // fired > 0, adjudicated === 0 — nobody decided
	| "confirmed"       // fired > 0, true_positive-dominant
	| "noisy"           // fired > 0, false_positive-dominant — REFINE the detector
	| "mixed";          // fired > 0, both present, neither dominant
```

#### The row

```typescript
export interface CheckCoverageRow {
	check_id: string;
	/** Family key from getCheckInventory() — "inline", "sequence", … */
	family: string;
	phase?: CheckPhase;                 // check-registry/types.ts:30
	severity?: "error" | "warning";
	determinism: CheckDeterminismTag;   // REUSED from check-health.ts:18
	gate: "default" | "advisory" | "verify_only";
	by_surface: Partial<Record<CheckObservationSurface, CheckSurfaceCounters>>;
	skips: Partial<Record<CheckSkipReason, number>>;
	adjudications: {
		true_positive: number;
		false_positive: number;
		unadjudicated: number;
	};
	/** PORTABILITY COLUMN. Foreign repos where this check fired at least once,
	 *  and how many were scanned. `foreign_repos_scanned === 0` means the
	 *  portability question is UNASKED — never that the answer was "no". */
	portability: {
		repos_scanned: number;
		repos_fired: string[];
		/** Total foreign files that satisfied the check's gate. */
		applicable_files: number;
	};
	/** Recall qualification (M5). `null` = the detector's own distinguishing
	 *  power is unmeasured, so `clear` must not be rendered as proven. */
	detector_mutation_score: number | null;
	verdict: CheckCoverageVerdict;
	/** One actionable line, in the describeCheckHealth style
	 *  (check-health.ts:187-199). */
	why: string;
}

export interface CheckCoverageReport {
	generated_at: string;
	/** Scan accounting, in the `interlinked query` footer tradition: the
	 *  report always states what it read and whether it hit a bound. */
	window: {
		since?: string;
		scanned_records: number;
		scanned_bytes: number;
		truncated: boolean;
	};
	registry_total: number;
	rows: CheckCoverageRow[];
	/** Registered ids with NO row on ANY surface — the blind-spot list, and
	 *  the report's headline output. */
	unobserved: string[];
}
```

#### The adjudication ledger

```typescript
// src/harness/coverage-report/adjudication.ts — PROPOSED

import type { Adjudication } from "../check-evidence/corpus.js";  // REUSED :36
import { hitSignature } from "../check-evidence/corpus.js";        // REUSED :75

export type AdjudicationSource = "corpus" | "live" | "foreign";

/**
 * One human verdict on one finding. Append-only; a changed verdict is a NEW
 * row, never an edit (the recurrence.ts storage discipline).
 *
 * Identity is (check_id, hit) where `hit` is corpus.ts::hitSignature — this
 * ledger mints NO identity scheme of its own, so a live fire and a corpus hit
 * on the same normalized line of the same file are provably the same finding
 * and cannot be adjudicated twice under different keys.
 */
export interface CheckAdjudication {
	ts: string;
	check_id: string;
	/** hitSignature({ file, text }) — file + whitespace-normalized line text. */
	hit: string;
	verdict: Adjudication;
	/** Required for false_positive: it becomes a required negative case under
	 *  the Check Evidence Contract. */
	note?: string;
	/** WHO decided. Never an agent identity — see §7 risk 2. */
	by: string;
	source: AdjudicationSource;
	file: string;
	/** sha256 of the DETECTOR'S SOURCE TEXT at adjudication time. Rewriting
	 *  the detector invalidates the verdict automatically — copied from
	 *  adversarial.ts:14-18, which makes the same argument for FP reviews. */
	detector_hash: string;
	/** Foreign repo slug when source === "foreign". */
	repo?: string;
}
```

Storage: `.interlinked/check-adjudications.jsonl`, **committed** (§4.4), for the
reason the corpus carve-out already states — reviewed judgments belong in PR
diffs.

The aggregator reads **both** this ledger and the `adjudications` map already
inside `check-corpus.json` (`corpus.ts:52`), unioning them. No migration, no
rewrite of a committed policy file from a log, and the 236 existing hits become
adjudicable without touching the corpus store's schema.

#### The staleness rule

```typescript
/** A verdict holds only while the detector it judged is unchanged. Generalizes
 *  adversarial.ts's source-hash binding; the same shape as the ledger memo's
 *  `invalidatedBy: ["sourceHash"]` on its `EvidenceRecord` (that memo is cited
 *  by symbol — see §0 — because its line numbers are moving). */
export function adjudicationHolds(
	entry: CheckAdjudication,
	currentDetectorHash: string,
): boolean;
```

Stale adjudications are **counted separately**, never silently dropped and never
silently honored. A check whose detector was rewritten reverts to `ungraded`
with an explicit "N verdicts stale" note.

### 3.2 Module layout

New family, sibling of `check-evidence/` and `mutation/`. Every file well under
the 500-line cap (`large-file-policy.ts`).

```
src/harness/coverage-report/
  types.ts          # the shapes in §3.1 — no logic          (~120 lines)
  counters.ts       # pure fold: empty(), add(), merge()      (~90)
  verdict.ts        # classifyCoverage(row) -> verdict + why  (~110)
  adjudication.ts   # ledger read/append/aggregate, staleness (~140)
  sources/
    live-fires.ts   # stream check-results.jsonl  -> counters (~110)
    recurrence.ts   # stream recurrences.jsonl    -> counters (~100)
    corpus.ts       # read check-corpus.json      -> counters (~80)
    foreign.ts      # read .interlinked/foreign-corpus/*.json (~90)
  report.ts         # join registry x sources -> CheckCoverageReport (~140)

src/commands/
  harness-coverage.ts        # renderers + command entry      (~180)
  harness-coverage-adjudicate.ts # the adjudication verb      (~120)
```

Design rules for the family:

- **`verdict.ts` is pure and total.** `classifyCoverage` takes the assembled
  counters and returns a verdict; it reads no files and no clock. It is the one
  place the four-state distinction lives, and it is trivially unit-testable
  against fabricated counters — which is what makes the anti-goal auditable.
- **Every `sources/*` module streams.** `recurrences.jsonl` is 53 MB and
  growing; `check-results.jsonl` is 4.2 MB. Follow
  `harness-health.ts:63-73` (`createReadStream` + `readline`), not
  `recurrence.ts:235-251` (`loadRecurrenceEvents` full-reads into an array —
  acceptable for its original callers, not for this one).
- **No cache.** Aggregation is computed on demand from the logs, exactly as
  `interlinked recurrence` does. A cached coverage number is a number that can
  be stale in the direction that flatters the harness.

### 3.3 CLI surface — recommendation: a new subcommand

**Recommendation: add `interlinked harness coverage`. Do not fold this into
`harness checks`, and do not extend `harness health`.**

Three reasons, each grounded:

1. **`harness checks` has an explicit contract this would break.** Its header
   says "Static (no daemon needed)" (`harness-checks.ts:2-3`). Its one existing
   attempt at log-derived enrichment already had to be size-capped
   (`:25`) — and that cap is silently active today at 53 MB (§1.4). A full
   multi-log join belongs behind a verb the user chose to wait for.
2. **`harness health` is structurally a demotion report.** Its verdict union has
   three members, one of which is "probation-candidate", and its section header
   recommends demotion (`harness-health.ts:115`). Making the coverage report a
   flag on it would seat the whole feature inside the frame the anti-goal
   forbids.
3. **`interlinked query` is a log slicer**, not a registry join. Coverage needs
   the registry as the driving table — the interesting rows are the ones with
   *no* log records, which a log query can never produce.

```
interlinked harness coverage [options]
  --since <dur>        Window for live surfaces (7d, 30d). Default: all.
  --check <id>         One check.
  --verdict <v>        Filter: no_population|never_executed|broken|clear|
                       ungraded|confirmed|noisy|mixed
  --surface <s>        Restrict to one observation surface.
  --unobserved         Print only ids with no row on any surface.
  --json --short --full
```

`--short` output shape (the line a human actually wants):

```
384 checks · 43 unobserved · 2 never-executed · 0 broken · 159 clear · 20 ungraded · 0 adjudicated
```

The human render leads with the **bug classes** (`never_executed`, `broken`) and
prints `clear` as a neutral count with the thesis inline, never as a list ranked
for deletion:

```
Clear (executed, never fired) — 159
  These measure the AGENT, not the check (CLAUDE.md). A clear check is the part
  of the standard this agent already meets. Retirement is not an available
  action here. To learn more about one, give it a foreign corpus:
  `interlinked harness coverage --check <id>` shows its portability column.
```

The adjudication verb:

```
interlinked harness coverage adjudicate <check_id> <hit-signature>
  --tp | --fp
  --note "<why>"        Required with --fp
  --by <name>           Required. Recorded verbatim; never defaulted to an agent id.
  [--repo <slug>]       For a foreign-corpus hit.

interlinked harness coverage hits <check_id>    # list adjudicable hits + signatures
```

Placement: a nested `adjudicate` under `coverage`, registered in
`src/registrars/harness.ts` beside `checks` and `health`
(pattern at `:58-82`).

### 3.4 Hook phases

**The report itself has no hook phase.** It is an on-demand read verb, like
`recurrence` and `metrics`. It never runs on the edit path.

Exactly one hook-path change exists in the whole design, in M1:

| Phase | Change | Constraints |
|---|---|---|
| PostToolUse | `buildAgentSafetyChecks` additionally returns the skipped set with reasons; the pipeline increments an in-memory per-session counter | Pure counter arithmetic on data the filter chain already computes. No new file reads, no new detector runs. |
| Stop / SessionEnd | Flush one row per (session, check_id) with non-zero counters to `.interlinked/check-executions.jsonl` | **O(checks) per session, not O(calls)** — a per-call execution list would grow `check-results.jsonl` from 4.2 MB to well over 100 MB. |

Three non-negotiable properties, each with a precedent in the tree:

1. **Honor `dry_run`.** `interlinked harness test --write` sets `dry_run: true`,
   and CLAUDE.md records the incident where three simulated writes opened real
   transient debt. The flush must thread `event.dry_run` like
   `ephemeral-write-log.ts` does.
2. **Fail-open, fire-and-forget.** Copy `check-results-sink.ts:9-11,102-104`
   verbatim in posture: a sink failure must never affect the agent's tool loop.
3. **Measured before default-on.** The counter's cost goes through
   `.interlinked/logs/latency.jsonl` (`harness/latency-log.ts:69`) and must show
   no p99 regression, or it ships opt-in. See M1's verification.

---

## 4. Integration points

### 4.1 `check-inventory.ts` — export the id sets

`getCheckInventory()` computes per-family id arrays at `:61-70` and returns only
counts. Add a sibling that returns the ids:

```typescript
export interface CheckFamilyIds { key: string; ids: string[]; }
export function getCheckInventoryIds(): CheckFamilyIds[];
```

Additive, and `getCheckInventory()` should be re-expressed in terms of it so the
two can never disagree — the module's own stated discipline ("there is no second
place to keep in sync", `:55`). `check-inventory.test.ts` pins the counts; the
pin must grow to cover the id sets, and the memo's M0 owns that.

### 4.2 `check-registry/builders.ts` — return the skipped set

M1 changes `buildAgentSafetyChecks` to optionally report skips. The signature is
already 5 parameters (`:26-38`); adding a sixth positional boolean would trip
`positional_optional_boolean` and `many_optional_params` (both registered,
CLAUDE.md's agent-quality table). Correct shape: a sibling function that returns
both sets, with the existing one re-expressed as a thin wrapper.

```typescript
export interface CheckSelection {
	selected: Array<{ name: string; severity: "error" | "warning"; fn: () => InlineMatch[] }>;
	skipped: Array<{ id: string; reason: CheckSkipReason }>;
}
export function selectAgentSafetyChecks(/* same inputs */): CheckSelection;
```

### 4.3 `check-evidence/` — reuse, and give it its missing verb

- `Adjudication`, `AdjudicationRecord`, `hitSignature`, `CHECK_CORPUS_PATH`
  (`corpus.ts:36,39,62,75`) — imported, not re-declared.
- `scanCorpus`, `isScannable`, `DetectorFailure`, `recordCorpusScan`
  (`corpus-scan.ts:31,40,79,124`) — the `corpus` surface producer. M0 gives these
  their **first non-test caller**, closing the gap in §1.5 as a side effect.
- `recall.ts` — M5's `detector_mutation_score`. Note `MUTATION_BASELINE_PATH`
  (`:31`) has no file in this repo; M5 must handle absence as `null`, not 0.
- `adversarial.ts` — the source-hash staleness pattern, copied for
  `detector_hash`.

### 4.4 `.interlinked/` files and gitignore carve-outs

| File | Git | Written by | Why |
|---|---|---|---|
| `check-adjudications.jsonl` | **carve-out, committed** | `harness coverage adjudicate` | Reviewed judgments belong in PR diffs — the reason `.gitignore:189-194` already gives for `check-corpus.json` |
| `check-executions.jsonl` | ignored (blanket `.interlinked/*`) | daemon, Stop flush | Runtime telemetry; per-machine; regenerates |
| `foreign-corpus/<slug>.json` | **carve-out, committed** | `cross-repo-validate` (M4) | The portability evidence a `clear` verdict rests on; must survive a fresh clone, same argument as the corpus store's |

Carve-out lines go beside the existing ones at `.gitignore:172-196`, each with
the one-line rationale comment that block already uses.

### 4.5 `baseline_integrity_gate` — a new append-only kind

`BASELINE_RE` (`evaluator/baseline-integrity-gate.ts:45-46`) protects nine
baseline files by *direction* (values may only tighten). An adjudication ledger
needs a different constraint, because it has no numeric water-line:

> **Append-only.** A Write/Edit to `check-adjudications.jsonl` is admitted only
> when the new content is a prefix-extension of the on-disk content. Deleting or
> rewriting a prior verdict is refused.

This is the correct primitive for the gaming surface in §7.2 and it is
mechanically checkable — a byte-prefix comparison against current on-disk state,
which the gate already reads pre-write (CLAUDE.md: "Compares against the current
on-disk water-line … which the hook sees pre-write").

Two adjacent notes:

- **A verdict flip is a new row, not an edit.** The aggregator takes the newest
  non-stale verdict per `(check_id, hit)`. History is preserved, and a
  TP→FP flip is visible in the diff.
- **`check-corpus.json` is currently unprotected** (§2.8) — an agent can rewrite
  its `adjudications` map freely. This memo does not fix that (it is the
  evidence-contract's file), but it must not add a second unprotected verdict
  store, which is why the ledger gets the gate from M2 rather than "later".

### 4.6 Check registry — does this add a check?

**No.** The coverage report registers zero new checks. It adds a read verb and a
counter. This is deliberate: CLAUDE.md treats "more checks as a cost, not a win",
and a report *about* check governance that ships its own check would be
self-referentially absurd.

### 4.7 Docs and generated counts

No `gen:` marker changes — the registry counts do not move. `docs/harness.md`
and the `interlinked-observability` skill get a paragraph each; the
`interlinked-verify` skill gets the adjudication verb.

---

## 5. Milestones

Each milestone is independently landable and independently verifiable. M0
requires no daemon change and no hook-path code.

### M0 — Offline coverage derivation (the smallest landable spike)

**Scope.** `interlinked harness coverage`, read-only, deriving every counter it
can from what already exists: the registry id sets (§4.1), fires from
`check-results.jsonl`, sweep fires from `recurrences.jsonl`, and a live corpus
replay via the existing `scanCorpus`. No instrumentation, no new hook code, no
adjudication verb yet.

This alone separates the four states for all 384 checks, because a corpus replay
supplies `applicable` and `executed` directly: a check whose gate admits N files
and whose `fn` ran N times with zero matches is `clear`; one whose gate admits N
files but which the dispatch never selected is `never_executed`; one that throws
is `broken`; one whose gate admits zero files is `no_population`.

**Verification.**
- `interlinked harness coverage --json` emits a row for every id in
  `getCheckInventoryIds()`, and `rows.length + unobserved.length === 384`.
- The 43 ids this session's census found with no evidence from either surface
  appear with verdict `no_population` or `never_executed` — and each is
  *individually* explained by `why`, not lumped.
- The 19 sweep-only ids from §1.3 (`eval_usage`, `ubs_sql_string_concat`, …)
  show `by_surface.sweep.fired > 0` and `by_surface.post_tool.fired === 0`.
- `window.scanned_bytes` is reported and `truncated` is honest against a 53 MB
  recurrence log.
- Unit tests for `classifyCoverage` over fabricated counters cover all eight
  verdicts (§6).

### M1 — Live execution + skip-reason counters

**Scope.** `selectAgentSafetyChecks` (§4.2), per-session in-memory counters,
Stop-flush to `check-executions.jsonl`, `sources/` reader for it. Turns
`executed` and `skips` from corpus-derived approximations into measured
edit-path facts — which is what distinguishes "the agent never wrote a file that
qualified" from "the file qualified and the agent cleared it".

**Verification.**
- `node .interlinked/e2e-protocol-probe.mjs` still passes (no protocol change).
- A synthetic `harness test --write` run with `dry_run: true` produces **zero**
  rows in `check-executions.jsonl` — the regression CLAUDE.md's dry-run rule
  exists for.
- p99 latency from `.interlinked/logs/latency.jsonl` before vs after, over the
  same session length: no regression beyond noise, or the counter ships behind a
  config flag defaulting off.
- The skip-reason union is exhaustive over `builders.ts`'s filter chain, pinned
  by a test that fails when a filter is added without a reason (§6).

### M2 — Adjudication verb + append-only ledger + gate

**Scope.** `harness coverage hits` / `adjudicate`, the JSONL ledger, the
staleness rule, and the `baseline_integrity_gate` append-only kind (§4.5).

**Verification.**
- Adjudicate a real sample of the 236 existing corpus hits; `--json` shows
  `adjudications.true_positive + false_positive` rising and `unadjudicated`
  falling by the same amount.
- A `--fp` without `--note` is refused.
- A Write that deletes a line from `check-adjudications.jsonl` is **blocked** by
  the gate; an append is allowed. Verified by
  `interlinked harness test --write` against the real file path.
- Editing the detector's source flips its verdicts to stale, and the check
  returns to `ungraded` with a counted staleness note — verified by hashing a
  detector, adjudicating, then touching one character of it.

### M3 — Suppression and deferral counters

**Scope.** Count at `isSuppressed` (`suppressions.ts:319`) and the defer
consumption point; add a whole-tree static census so the report shows both the
runtime drops and the standing 14 `ignore` / 52 `defer` directives.

**Verification.** A file with a known `interlinked-ignore` directive produces
`suppressed_inline === 1` and does **not** increment `fired`. The static census
matches the `rg` count for the same tree.

### M4 — Portability column

**Scope.** Define the artifact contract `cross-repo-validate` writes
(`.interlinked/foreign-corpus/<slug>.json`, `CorpusScanResult` shape plus a repo
fingerprint), the `sources/foreign.ts` reader, and the render. Run the skill
across a small set of foreign repos — deliberately including a non-TS one, since
the UBS Python/Go/Rust checks are the largest `no_population` population here.

**Verification.** For at least one check that is `no_population` in this repo,
the foreign column shows `applicable_files > 0` and a non-empty `repos_fired` —
the first direct evidence for the portability premise CLAUDE.md admits is
unproven at N=1. Equally publishable: a check that is `no_population` *everywhere
scanned*, reported as **unvalidated**, with no action attached.

### M5 — Recall qualification (deferred)

**Scope.** Join `recall.ts`'s detector mutation score so `clear` renders as
`clear (recall unproven)` when the score is `null`. Blocked in practice:
`MUTATION_BASELINE_PATH` has no file in this repo (§2.4). Land the `null` path in
M0 and the join whenever the baseline exists.

**Verification.** With no baseline present, every row reports
`detector_mutation_score: null` and no row claims proven clearance.

---

## 6. Evidence obligations

The Check Evidence Contract governs *checks*; this feature registers none
(§4.6). Its obligations are therefore ordinary test obligations plus two pins
that exist specifically to keep the design honest.

**Unit tests (per module).**

- `verdict.ts` — all eight `CheckCoverageVerdict` members, each with a
  MUST-PRODUCE and a MUST-NOT-PRODUCE case over fabricated counters. Boundary
  cases are the load-bearing ones: `applicable=0,executed=0` →
  `no_population`; `applicable=1,executed=0` → `never_executed`;
  `executed=1,fired=0,detector_failures=1` → `broken`, **not** `clear`.
- `counters.ts` — merge is associative and commutative; merging a surface into
  itself does not double-count `files`/`sessions` (they are set cardinalities,
  not sums, so the fold must carry sets and materialize counts at the end).
- `adjudication.ts` — newest-wins per `(check_id, hit)`; a stale verdict is
  excluded from the tallies *and* counted as stale; a torn JSONL line is skipped
  (the `foldRecurrenceLine` tolerance, `check-health.ts:86-97`).
- `sources/*` — each reader is exercised against a fixture log including a torn
  line, an unknown-schema row, and a legacy row missing `session`
  (`check-results.jsonl` rows before 2026-07-24 lack it,
  `check-results-sink.ts:29`).

**Two pins.**

1. **Skip-reason exhaustiveness.** A test that walks the filter chain in
   `builders.ts` and fails when a filter exists with no `CheckSkipReason`
   member. Without it, a future filter silently converts `clear` checks into
   invisible ones — which is the exact failure this feature exists to prevent.
2. **The anti-goal pin.** A test asserting that no exported symbol in
   `coverage-report/` returns, contains, or renders a string matching
   `/retire|delete|remove.*check|demote/i` for the `clear` or `no_population`
   verdicts. Crude, and deliberately so: the anti-goal is a policy, and a policy
   with no test is a comment.

**Corpus obligation (self-applied).** M0's own first run is the corpus: run it,
read the `never_executed` and `broken` lists, and fix whatever they name before
declaring M0 done. If the report's first output is "0 bugs found" across 384
checks, treat that as a suspect result and verify the derivation against three
hand-computed checks before believing it.

**What is NOT claimed.** None of the above establishes that the report's
`applicable` count is the *right* denominator — only that it is the one the
dispatch actually uses. A check whose `content_keywords` are wrong reports a
truthful `no_population` for a false reason. Detecting that requires the recall
dimension (M5), and the report must not imply otherwise.

---

## 7. Risks + anti-goals

### 7.1 PRIMARY ANTI-GOAL — this must never become a retire-quiet-checks lever

The failure mode is concrete and close: the repo already ships a per-check
governance surface whose only verdict is demotion (§1.4), and the external-pulse
intake already argues on the record that never-fired checks are retirement
candidates (`harness-engineering.md:145`). A coverage report that ranks 159
checks by quietness is one `sort` away from being that list.

Four structural defenses, in order of strength:

1. **No retirement verdict exists in the type system** (§3.1). A downstream
   consumer cannot emit one without a type change that shows in review.
2. **The bug states are separated from the clearance states.** `never_executed`
   and `broken` are actionable; `clear` and `no_population` are not, and the
   render says so in words at the point of display (§3.3).
3. **`no_population` is never reported as an answer.** With
   `portability.repos_scanned === 0` it means *the question was not asked*. Only
   M4 can turn it into evidence, and even then the verdict is "unvalidated", not
   "unnecessary".
4. **The anti-goal pin** (§6). A test, not a paragraph.

**Explicitly out of scope, permanently:** wiring any coverage number to an
automatic disable, demote, or `DEFAULT_ADVISORY_SKIPS` mutation. The report
informs a human; it never acts.

### 7.2 Goodhart: adjudication as laundering

The agent being gated can write the adjudication ledger. Marking one's own fires
`false_positive` defeats every downstream use at once — structurally the same
attack `baseline_integrity_gate` exists to stop.

Mitigations, honestly rated:

- **Append-only enforcement** (§4.5) — *strong and mechanical*. Prevents
  rewriting history; does not prevent writing a false verdict in the first place.
- **Committed, so it lands in PR diffs** — *moderate*. The
  `check-corpus.json` carve-out already rests on this argument.
- **`detector_hash` staleness** — *moderate*. Bounds a verdict's lifetime to the
  detector's, so laundering does not persist across rewrites.
- **`by` must not be an agent identity** — *weak, and it must be labelled weak*.
  The agent writes the field. This is a convention, not a control. **Local checks
  are not a trust boundary** (the standing project position); a
  cryptographically-anchored adjudication is a cloud-tier concern and is not
  designed here.

The residual risk is accepted and named: **a determined agent can write false
adjudications.** What the design guarantees is that it cannot do so *invisibly*
or *durably*.

### 7.3 Goodhart: gaming applicability

Narrowing a check's `content_keywords` converts an inconvenient `clear` (or
`noisy`) check into a comfortable `no_population` one. Two things bound it: the
change is a source edit in `check-registry/`, visible in review; and the report
records skips **by reason**, so a `content_keywords` skip count that jumps is
itself the signal. No new mechanism is proposed — per the N=1 discipline, a
registry-wide anti-gaming mechanism waits for second-codebase validation.

### 7.4 Determinism policy

Every computation here is counting, grouping, hashing, and running existing
detectors. **No LLM appears anywhere in the pipeline**, consistent with the
deterministic-only rule. Adjudication is a *human act that is recorded*, not a
judgment that is computed. If an LLM is ever used to propose verdicts, it must
land as a separate `proposed_verdict` field a human confirms, at stop/CI cadence
— that is Tier 2/3 territory and it is an open decision (§8.5), not part of this
design.

### 7.5 False confidence from a clean corpus

`corpus.ts:17-21` states it already: a zero-hit run "is indistinguishable from a
detector that does not work at all." So `clear` must never render as a green
check. Until M5 supplies a mutation score, the render is
`clear (recall unproven)`, and the JSON carries
`detector_mutation_score: null` so no consumer can mistake absence for zero — the
same "unknown is not 0%" discipline the CRAP gate learned the hard way
(CLAUDE.md).

### 7.6 Cost and unbounded reads

`recurrences.jsonl` is 53 MB and grew ~35 MB since `.interlinked/INDEX.md` was
generated. Every reader streams and every run reports `scanned_bytes` +
`truncated`. The M1 hook-path counter is the only work that touches the edit
path, it is O(checks) per *session*, and it ships opt-in unless the latency log
shows no regression.

### 7.7 Anti-goal: this is not a ratchet

No water-line, no baseline, no tighten-only file. "N checks must be non-quiet"
as a ratchet would reward deleting quiet checks and loosening detectors —
directly inverting the thesis. The report produces a number for a human to read,
and nothing in `.interlinked/` gates on it.

### 7.8 Scope risk: the report exposes real bugs

If M0 reports a meaningful `never_executed` or `broken` population, fixing those
is real work that is not in this plan's estimates. That is a *success* condition,
and it should be sequenced as its own follow-up rather than absorbed silently
into M0.

---

## 8. Open decisions for the user

1. **Consolidate `harness health` into `harness coverage`, or keep both?**
   `health` is a working, shipped surface whose fire-based repeat-rate analysis
   the coverage report subsumes but does not replicate (repeat-rate is a genuinely
   different measurement). Options: keep both and cross-link; make `health` an
   alias for `coverage --verdict noisy`; or deprecate `health`. The memo assumes
   *keep both, cross-link* and does not churn a shipped surface.

2. **Is `check-adjudications.jsonl` committed or local?** Committed gives review
   and survives a clone (§4.4), and matches the `check-corpus.json` precedent —
   but an append-only JSONL in a multi-agent tree will produce merge conflicts,
   which is exactly the friction that left `check-corpus.json` with zero
   verdicts. Local avoids conflicts and loses the review property.

3. **Does the portability column ever change a gate?** The memo's position is
   **no** — a foreign fire is publishable evidence, never a promotion trigger.
   The alternative (a check earns default-gate status once it fires on K foreign
   repos with sampled precision above a bar) is the mechanism
   `docs/plans/06-cloud-metrics-program.md:30-33` sketches for
   `cognitive_complexity`. If that is wanted, it is a different memo.

4. **Does M1's per-session execution counter ship default-on?** Default-on gives
   real edit-path applicability data immediately; opt-in keeps the hook path
   provably unchanged for anyone who does not want it. The memo defaults to
   *on only if the latency measurement is clean*, which defers the call to data
   — say if you would rather it be opt-in regardless.

5. **Who may sign an adjudication?** Human-only is the honest position and the
   one the design assumes. The alternative worth considering: a *named
   deterministic verifier* (a compiler, a second detector) may sign a
   `true_positive` when it independently confirms the finding — which would let
   the 236 stalled corpus hits be partly cleared mechanically rather than by
   hand.

---

## 9. Effort estimates per milestone

Estimates are in focused working sessions for one agent on this codebase, and
assume the verification named in §5 is part of the milestone, not after it.

| Milestone | Estimate | Dominant cost | Confidence |
|---|---|---|---|
| **M0** — offline derivation + `harness coverage` | **1–1.5 sessions** | The registry×sources join and eight-verdict test matrix; the readers are small because the logs are well-shaped | High — every input file exists and was read this session |
| **M1** — execution + skip counters | **1.5–2 sessions** | `selectAgentSafetyChecks` refactor touches a hot path with an existing 5-parameter signature; latency measurement is a real gate, not a formality | Medium — the refactor is mechanical, the latency verdict is not predictable |
| **M2** — adjudication verb + ledger + gate | **1.5–2 sessions** | The `baseline_integrity_gate` append-only kind is new machinery with its own FP bar (a false block on a legitimate append is worse than the gap) | Medium |
| **M3** — suppression counters | **0.5–1 session** | Two counting sites plus a static census; the parsing all exists | High |
| **M4** — portability column | **1 session + fleet time** | Code is a reader and a render; the cost is the foreign-repo runs and adjudicating a sample of their hits | Medium — depends on `cross-repo-validate`'s current output shape, unverified here |
| **M5** — recall qualification | **0.5 session, blocked** | Trivial join; blocked on `mutation-baseline.json` not existing | Low — the blocker may not clear |

**Total for a useful first tranche (M0 + M2):** ~3 sessions, and it answers the
title question for all 384 checks with a working adjudication path. **M1 is the
biggest single jump in signal quality** (measured edit-path applicability rather
than corpus-inferred), and also the only milestone that touches the hook path —
sequence it second if the latency budget is available, third if it is not.

Not estimated, and deliberately excluded: fixing whatever bugs M0 surfaces
(§7.8), and any second-codebase validation work, which the N=1 discipline places
outside this plan entirely.
