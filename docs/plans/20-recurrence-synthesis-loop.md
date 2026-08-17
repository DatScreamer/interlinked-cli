# `recurrence synthesize` — closing the steering loop

**Status:** design proposal, 2026-08-14. Not built. This is one of six parallel
design memos derived from
[`session-2026-08-11-synthesis.md`](../design/session-2026-08-11-synthesis.md)
Part 4 (design principle 1, "Close the recurrence loop"; ranked backlog item 2)
and Part 11 (recommended decision 6). See **Depends on / feeds** at the end for
how this memo composes with the other five.

**Companion docs:**
[`session-2026-08-11-synthesis.md`](../design/session-2026-08-11-synthesis.md)
Parts 4, 7 and 11 (the requirement this memo turns into a build plan);
[`verification-density-program.md`](../design/verification-density-program.md)
(the Check Evidence Contract every accepted sensor must satisfy);
[`skills/enforce/SKILL.md`](../../skills/enforce/SKILL.md) (the guide-side
precedent: distill-to-artifact, review-before-activation, manual invocation
only); [`baseline-integrity-gate.md`](../design/baseline-integrity-gate.md)
(the water-line discipline this memo must not weaken).

**Verification status of every claim below:** §2 is verified by reading the
named files at the named lines, plus three commands run this session (marked
**Measured**). §3 onward is **PROPOSED, UNVERIFIED SKETCH** — no `src/` file
was written or type-checked for this memo.

---

## 1. Problem + evidence

Interlinked has a rich *feedback* layer (a check fires, the agent is told) and
almost no *feedforward* layer (the agent is told before it makes the mistake for
the 2,962nd time). The recurrence log records the repeats; nothing converts a
repeat into either a new sensor or a piece of steering prose. The synthesis
document names this as design principle 1 and backlog item 2:

> "Close the recurrence loop. Repeated observed mistakes should draft both a
> sensor and a concise guide, with human review before activation. `/enforce`
> distills stated rules; recurrence synthesis would learn from actual failures."
> — `session-2026-08-11-synthesis.md:158`

### The log is large, hot, and heavily skewed

**Measured** this session against `.interlinked/recurrences.jsonl`
(53,407,801 bytes, 193,854 rows):

| Kind | Rows |
|---|---:|
| `codebase_existing` | 132,983 |
| `harness_caught` | 60,718 |
| `tool_failure` | 151 |
| `harness_missed` | 2 |

**Measured** — top `harness_caught` rows (`interlinked recurrence list --kind
harness_caught --top 12`):

| Count | Check | Scope | Last |
|---:|---|---|---|
| 7,851 | `persistent_warning_escalation` | 119 sessions / 710 files | 3d |
| 2,962 | `tdd_cycle_violation` | 124s / 591f | 2d |
| 2,590 | `ubs_magic_number_no_const` | 128s / 443f | 19m |
| 2,346 | `no_test_file` | 113s / 806f | 12m |
| 2,331 | `function_arg_count` | 123s / 284f | 18m |
| 2,313 | `unvalidated_json_sibling` | 96s / 21f | 4h |

**Measured** — top `codebase_existing` rows: `unjustified_cast` 41,397 hits over
679 files; `same_typed_primitive_params` 10,153 / 325f; `write_without_mkdir`
8,007 / 167f.

Three things follow directly from that table, and they shape the whole design:

1. **The hottest signatures already have a sensor.** `tdd_cycle_violation` fired
   2,962 times across 124 sessions. Drafting a *new* detector for it would be
   nonsense; what is missing is the guide that stops the behavior. So synthesis
   must route by kind, not emit one artifact type for everything.
2. **The kind that most wants a new sensor is nearly empty.** `harness_missed`
   has 2 rows, because it is manual-only (`recurrence.ts:438-443` documents the
   v1 manual surface and the unbuilt v2 detector). A synthesizer keyed only on
   `harness_missed` would have almost nothing to do. `tool_failure` (151 rows) is
   the realistic sensor-drafting source today.
3. **Any ambient trigger must stream.** `loadRecurrenceEvents`
   (`recurrence.ts:235-251`) does `readFileSync` + `split("\n")` over the whole
   file. `recurrence propose` calls it (`commands/recurrence.ts:218`). A 53 MB
   full read is acceptable for a human-typed verb and unacceptable on the Stop
   path.

### A verified defect the synthesizer must not inherit

`commands/recurrence.ts:150-161` re-implements signature derivation inline,
with a comment claiming it is the "same shape as recurrence.ts's
deriveSignature". It is not: it handles `harness_caught` and
`codebase_existing`, then falls through to `harness_missed:` for everything
else — while the real `deriveSignature` (`recurrence-signature.ts:50-76`) gives
`tool_failure` and `outcome_marker` their own namespaces. `KNOWN_KINDS`
(`commands/recurrence.ts:52-57`) also omits `outcome_marker`.

**Measured** consequence — `list` prints a signature that `detail` cannot find:

```
$ interlinked recurrence list --kind tool_failure --top 1 --json | …
tool_failure:Read:filesystem-shape:EISDIR: illegal operation on a
$ interlinked recurrence detail "tool_failure:Read:filesystem-shape:EISDIR: illegal operation on a"
No events found for signature: tool_failure:Read:filesystem-shape:EISDIR: illegal operation on a
```

Synthesis takes a signature as its argument. It must consume `deriveSignature`
directly, and M0 removes the divergent copy rather than adding a third.

### Why this is not `/enforce`

`/enforce` distills *stated* rules from markdown that a human already wrote
(`skills/enforce/SKILL.md:3`). Recurrence synthesis works from *observed*
failures, where no prose exists. The two are complementary and the operational
shape should be identical: produce an artifact, park it for review, never
auto-activate (`skills/enforce/SKILL.md:24,121`).

---

## 2. Current state (verified, file:line)

Everything in this section was read this session at the cited lines.

### 2.1 The recurrence substrate exists and is well-factored

| Piece | Location | What it actually does |
|---|---|---|
| Event kinds | `src/harness/recurrence.ts:26-31` | Five: `harness_caught`, `harness_missed`, `codebase_existing`, `outcome_marker`, `tool_failure` |
| Event shape | `src/harness/recurrence.ts:49-71` | `ts`/`kind` required; `check_id`/`agent_source`/`session_id`/`file`/`message`/`signature`/`phase`/`severity` optional |
| Aggregation | `src/harness/recurrence.ts:110-199` | Pure fold into `(kind, signature)` buckets; emits count, first/last seen, distinct sessions, distinct files, agent sources, ≤10 sample files, assembly-index tiebreak |
| Row shape | `src/harness/recurrence.ts:73-92` | `Recurrence` — the input a candidate evaluator needs, **except** it does not retain the observing session **ids** (only `distinct_sessions`, line 177) |
| Signature | `src/harness/recurrence-signature.ts:50-76` | Per-kind namespaced key; forwarded `tool_failure` signatures are re-namespaced (lines 62-66) |
| Suggested action | `src/harness/recurrence.ts:201-223` | `proposeAction(row)` → one of three `RecurrenceAction` kinds (`recurrence.ts:101-105`): `scaffold_rule` for `harness_missed`, `cleanup_pr` for `codebase_existing`, `ratchet` for everything else |
| Storage | `src/harness/recurrence.ts:107-108, 225-233` | Append-only `.interlinked/recurrences.jsonl` |
| Write helpers | `src/harness/recurrence.ts:330-463` | `recordHarnessCaught`, `recordToolFailure`, `markOutcome`, `recordHarnessMissed`; the first three swallow storage errors (hot path) |
| Live callsites | `evaluator/edit-contract-phase.ts:31`, `server/post-tool-file-checks.ts:409`, `failure-channels.ts:96` | Three producers wired today |

`proposeAction` is **advice text only**. It returns a headline and a detail
string (`recurrence.ts:204-222`); it generates no file, stages nothing, and has
no review state. `recurrence propose` prints it (`commands/recurrence.ts:214-234`).
That is the entire "loop closure" that exists today.

Note two shortfalls that bind the design: `proposeAction` routes `tool_failure`
through the default `ratchet` branch (`recurrence.ts:217-222`), which suggests
tuning a check that does not exist; and `Recurrence` carries no session-id list,
which is the exact field the self-approval refusal in §3.5 needs.

### 2.2 The DOWN direction already shipped; the UP direction did not

`src/harness/check-health.ts` is the closest existing relative and the best
model to copy:

- streaming fold, one line at a time — `foldRecurrenceLine` (`check-health.ts:86-97`),
  written specifically because "the 40k+-row production log is never
  materialized as one array" (`check-health.ts:13-14`);
- named thresholds with rationale comments — `PROBATION_REPEAT_RATE_THRESHOLD = 5`
  (line 30), `PROBATION_UNIQUE_FINDINGS_FLOOR = 5` (line 35), `LOW_DATA_EVENT_FLOOR = 10`
  (line 39);
- a deliberate determinism restriction — only `heuristic` checks are demotion
  eligible, because a `proven` check re-firing is "evidence about the agent, not
  the check" (`check-health.ts:168-171, 182`);
- "NO LLM, NO network, NO clock reads" (`check-health.ts:11-12`);
- surfaced as `interlinked harness health` (`registrars/harness.ts:72-82`).

Its header states the asymmetry outright: the recurrence log "already powers the
UP direction (recurrence propose → ratchet a noisy pattern into a harder gate)"
(`check-health.ts:4-5`). That UP direction is a print statement.

### 2.3 The CLI surface today

`src/registrars/observability-logs.ts:20-80` registers `recurrence` with five
subcommands: `list` (line 24), `detail` (39), `flag` (~50), `scan` (~65),
`propose` (74). `observability-logs.test.ts:149-151` pins the subcommand-name
set, so adding verbs updates that pin in the same change.

### 2.4 Check-scaffolding conventions the accepted sensor must satisfy

CLAUDE.md steps 1-7, verified against source:

1. Detector in `src/harness/checks/<family>.ts` with signature
   `(content: string, filePath: string) => InlineMatch[]`
   (`check-registry/types.ts:70`); `InlineMatch` is `{line, text}` (lines 6-11).
   `checks/policy-constant-drift.ts:1-40` is a representative small detector.
2. Registry entry in `check-registry/entries-warnings.ts` (or `entries-errors.ts`).
   `CheckRegistration` (`check-registry/types.ts:33-92`) requires
   `id`/`name`/`description`/`tier`/`determinism`/`severity`/`pipeline`/`phase`/
   `fix_instruction`/`fn`/`resultsPropName`; `content_keywords` optional.
   `entries-warnings/quality-frontier.ts:25-42` is a filled-in example.
   `phase: "pre_block"` is "reserved for fully-deterministic, zero-FP errors"
   (`check-registry/types.ts:16-19`).
3. Metadata entry — `check-metadata.ts:16-20` re-exports per-family fragments.
4. Legacy mirror — no longer required (auto-re-exporting shim).
5. Verify wiring under `src/commands/verify/`.
6. `DEFAULT_ADVISORY_SKIPS` + its regression test when advisory.
7. Labeled MUST-FIRE / MUST-NOT-FIRE cases meeting the phase-scaled obligation.

Step 7 is machine-enforced. `check-evidence/obligations.ts:25-66` defines four
tiers; `tierFor` (lines 76-80) selects one from phase + advisory membership;
`post_advisory` requires 1 positive / 1 negative, `post_default` 2/2,
`pre_warn` and `pre_block` 2/2 and 3/3 with corpus, mutation and adversarial
dimensions attached. `case-parser.ts:44-55` defines the two labeling dialects
(`directionFromTitle`: a direction-naming `describe`, or a `P1:` / `N3:`
per-test prefix). CLAUDE.md is explicit that "New checks get no
grandfathering."

### 2.5 The guide-side precedent

`/enforce` writes `.interlinked/distilled-rules.json` plus a user-owned
`.interlinked/distilled-rules.overrides.json`; the harness loads the pair
through `loadDistilledRules` (`rules/distilled-rules.ts:237-268`) with paths at
lines 78-84. Two properties matter here:

- **Review-before-activation exists already**: `/enforce --review` writes
  `.interlinked/distilled-rules.review.json`, and "the harness does not load
  `.review.json`" (`skills/enforce/SKILL.md:775`); `--accept` promotes it
  (line 779).
- **Never auto-fires**: `skills/enforce/SKILL.md:24, 121`.

### 2.6 The staging-and-protection precedent

`.interlinked/scanner/pending/` is the existing model for "an artifact the agent
must not read or rewrite":

- directory constant `content-scanner/review-files.ts:39`;
- documented protection model at `content-scanner/review-files.ts:21-24`
  ("the `pending/**` glob is in `protected_files`… The agent cannot read either
  file");
- the `protected_files` entry at `rules/default-config-resolvers.ts:198`
  (`glob: ".interlinked/scanner/pending/**"`), from the array at line 74;
- the long-tail guard rule `builtin-scanner-pending-access`
  (`rules/builtin-rules-security.ts:88-120`) blocking Bash/Grep/Glob paths that
  merely *mention* the path.

### 2.7 Generated-code precedent

`src/harness/scaffold-fuzz.ts` is a pure `findings → findings` transformer that
appends a fenced, copy-paste-ready property test to a finding's message
(lines 1-33, 55-63). Two of its documented properties carry over directly: the
scaffolds "are SUGGESTIONS — they do not execute" (lines 6-8), and emitting
code-shaped strings trips this repo's own detectors, so it assembles some
literals from fragments to keep `ubs_hardcoded_localhost` quiet (lines 29-33).

### 2.8 What does not exist

**Measured**: `rg -n "synthesize" src/ --glob '!*.test.ts'` returns only
unrelated uses (`scaffold-fuzz.ts:63`, `session-state.ts:149`, …).
`ls .interlinked/proposals` → `No such file or directory`. There is no
proposal staging area, no accept/reject verb, no sensor generator, and no guide
emitter anywhere in the tree.

---

## 3. Design

**PROPOSED, UNVERIFIED SKETCH.** Nothing below has been written or
type-checked.

### 3.0 The one-paragraph shape

`recurrence synthesize` is a **human-typed CLI verb** that reads the recurrence
log, finds signatures that cross a per-kind threshold, and writes a *proposal
directory* under `.interlinked/proposals/`. A proposal holds up to three
drafts — a sensor skeleton, its labeled evidence-case stubs, and a provisional
feedforward guide fragment — all generated by deterministic templates from the
signature and its own recorded events. Nothing loads. Nothing activates. A
separate `accept` verb materializes drafts into the working tree after a
refusal ladder, and the sensor still has to clear the ordinary Check Evidence
Contract before it can be registered. The only hook-phase surface is an optional
one-line Stop nudge saying "N signatures crossed the threshold".

### 3.1 Routing: kind decides artifact, not one-size-fits-all

The §1 evidence forces this. A kind whose sensor already exists must never
produce a second sensor.

| Kind | Sensor exists? | Emits | Rationale |
|---|---|---|---|
| `harness_missed` | No (by definition) | `sensor` + `guide` | The canonical case: a repeat nothing catches |
| `tool_failure` | No | `sensor` + `guide` | 151 rows today; a repeated tool error the harness could pre-empt |
| `harness_caught` | Yes, and firing | `guide` only | 2,962 fires means steering failed, not detection |
| `codebase_existing` | Yes | `cleanup` only | Already `proposeAction`'s `cleanup_pr`; a scan artifact, not a new sensor |
| `outcome_marker` | n/a | nothing | Bookkeeping rows for the FP aggregator (`recurrence.ts:43-47`) |

This is a strict extension of `proposeAction` (`recurrence.ts:201-223`), not a
replacement: `scaffold_rule` becomes an artifact instead of a sentence,
`cleanup_pr` is unchanged, and the `ratchet` default stops mis-routing
`tool_failure`.

### 3.2 Data shapes

```typescript
// src/harness/recurrence-synthesis/types.ts — PROPOSED, UNVERIFIED SKETCH

import type { RecurrenceKind } from "../recurrence.js";
import type { ObligationTier } from "../check-evidence/types.js";

export type SynthesisArtifactKind = "sensor" | "guide" | "cleanup";

/** One row of the trigger policy table. Pinned by a regression test so a
 *  threshold change surfaces in the diff (the DEFAULT_ADVISORY_SKIPS idiom). */
export interface SynthesisTriggerPolicy {
	kind: RecurrenceKind;
	min_count: number;
	min_distinct_sessions: number;
	min_distinct_files: number;
	/** Signature must have recurred within this window to be actionable — an
	 *  old signature is a solved problem, and steering prose for a solved
	 *  problem is pure context cost. */
	max_age_days: number;
	emits: readonly SynthesisArtifactKind[];
}

export interface SynthesisCandidate {
	signature: string;
	kind: RecurrenceKind;
	check_id?: string | undefined;
	count: number;
	distinct_sessions: number;
	distinct_files: number;
	first_seen: string;
	last_seen: string;
	sample_files: string[];
	/** Session ids that produced these events. NOT on `Recurrence` today
	 *  (recurrence.ts:177 keeps only the size) — §4.1 adds it. This is the
	 *  denominator for the self-approval refusal in §3.5. */
	observing_sessions: string[];
	emits: SynthesisArtifactKind[];
	/** One line per satisfied clause: "count 2962 ≥ 8", "sessions 124 ≥ 3".
	 *  A candidate must be able to explain itself without re-running. */
	because: string[];
}

/** A literal token common to the recorded messages. NEVER a semantic
 *  inference — the generator does not know what the check means. */
export type PatternSeed =
	| {
			kind: "literal";
			literal: string;
			/** Fraction of sampled messages containing it (0..1). */
			support: number;
			/** How many distinct messages were sampled. */
			sources: number;
	  }
	| { kind: "none"; reason: "no_common_substring" | "too_short" | "no_messages" };

export interface SensorFixture {
	/** Repo-relative, straight from the recorded event. */
	file: string;
	line?: number | undefined;
	/** EXACT recorded text. Escaped at render time, never at store time. */
	excerpt: string;
	event_ts: string;
}

export interface SensorDraft {
	/** camelCase detector name derived from the signature slug. */
	detector_fn: string;
	/** snake_case check id; refused at draft time on CHECK_REGISTRY collision. */
	check_id: string;
	/** Proposed home, e.g. "src/harness/checks/synthesized-<slug>.ts". */
	family_file: string;
	/** Synthesis NEVER proposes pre_warn or pre_block. §7 risk 5. */
	proposed_phase: "post";
	proposed_determinism: "heuristic";
	proposed_severity: "warning";
	/** Always true: a synthesized detector starts in DEFAULT_ADVISORY_SKIPS. */
	advisory: true;
	pattern_seed: PatternSeed;
	/** Positive fixtures lifted from real recorded events. */
	positive_fixtures: SensorFixture[];
	/** Tier-derived stub count the human must fill; there is no honest way to
	 *  generate a MUST-NOT-FIRE case from fire records alone. */
	negative_fixture_slots: number;
	tier_key: ObligationTier["key"];
	required_positive: number;
	required_negative: number;
}

export interface GuideDraft {
	/** Managed-block target, e.g. "CLAUDE.md" or "skills/<x>/SKILL.md". */
	target: string;
	/** Stable, signature-derived; the managed block's identity across redraws. */
	marker_id: string;
	/** Capped (§3.6). Rendered under a provisional marker with provenance. */
	body_lines: string[];
	provisional: true;
}

export type ProposalState = "drafted" | "accepted" | "rejected" | "superseded";

export interface SynthesisProposal {
	/** sha256(signature + drafted_at_date).slice(0,12) — redrafting the same
	 *  signature on the same day is idempotent; a later day supersedes. */
	id: string;
	signature: string;
	kind: RecurrenceKind;
	state: ProposalState;
	drafted_at: string;
	/** "template" on the default path. The optional cloud lane (§3.7) records
	 *  `cloud:<model>` so a reviewer always sees which one wrote the text. */
	drafted_by: "template" | `cloud:${string}`;
	/** Session that ran `synthesize`. Half of the self-approval refusal. */
	drafted_in_session: string;
	candidate: SynthesisCandidate;
	sensor?: SensorDraft | undefined;
	guide?: GuideDraft | undefined;
	/** Logical name → path relative to the proposal directory. */
	artifacts: Record<string, string>;
}

export type AcceptRefusal =
	| "self_approval"        // approving session observed the signature
	| "same_session_draft"   // drafted and accepted inside one session
	| "insufficient_sessions"
	| "check_id_collision"   // id now exists in CHECK_REGISTRY
	| "stale_candidate"      // counts moved materially since drafting
	| "already_decided";

/** Appended to decisions.jsonl. Append-only; a prior row is never rewritten. */
export interface AcceptDecision {
	proposal_id: string;
	ts: string;
	actor_session: string;
	approved_by: string;
	decision: "accept" | "reject";
	refusal: AcceptRefusal | null;
	reason?: string | undefined;
	/** Repo-relative paths written on a successful accept. */
	materialized: string[];
}
```

### 3.3 Trigger policy (starting values, deliberately conservative)

```typescript
// src/harness/recurrence-synthesis/triggers.ts — PROPOSED

export const TRIGGER_POLICIES: readonly SynthesisTriggerPolicy[] = [
	// A user-flagged miss is the highest-confidence signal in the system —
	// a human already decided the harness should have caught it. Low bar.
	{ kind: "harness_missed", min_count: 2, min_distinct_sessions: 1,
	  min_distinct_files: 0, max_age_days: 90, emits: ["sensor", "guide"] },

	// A repeated tool failure the harness could pre-empt. Needs cross-session
	// evidence: one session hitting EISDIR ten times is one confused loop.
	{ kind: "tool_failure", min_count: 5, min_distinct_sessions: 3,
	  min_distinct_files: 0, max_age_days: 30, emits: ["sensor", "guide"] },

	// The sensor already fires. Only steering is missing — and only when the
	// repeat spans sessions (within one session the agent may simply not have
	// reached the fix yet).
	{ kind: "harness_caught", min_count: 25, min_distinct_sessions: 5,
	  min_distinct_files: 5, max_age_days: 30, emits: ["guide"] },

	// Inherited debt. File spread, not hit count, is what makes a cleanup
	// worth proposing.
	{ kind: "codebase_existing", min_count: 50, min_distinct_files: 25,
	  min_distinct_sessions: 0, max_age_days: 180, emits: ["cleanup"] },
];
```

`evaluateCandidate(row, policy, nowMs)` is pure: it returns
`SynthesisCandidate | null` and a `because[]` explaining each satisfied clause.
No clock read inside the module (the caller injects `nowMs`), matching
`check-health.ts:11-12`.

**These numbers are calibrated against this repo's log and are therefore
suspect.** `halstead_difficulty` was tuned to 25 against fixtures and fired
2,226 times against the real tree (CLAUDE.md). The `harness_caught` floor above
admits roughly the top-30 signatures here; a legacy repo would flood it. The
policy table is pinned by a test so recalibration is a visible diff, and §7
records that second-codebase validation is required before any of these numbers
is treated as a default.

### 3.4 Deterministic scaffolding — what a template can and cannot do

**It cannot write a detector.** A template has no idea what
`unvalidated_json_sibling` means. Saying otherwise is the failure mode this
repo's own synthesis document warns about — an artifact that looks like evidence
and is not.

What it *can* do, deterministically, is remove every piece of ceremony between a
recognized repeat and a reviewable stub:

| Generated | Source | Honest status |
|---|---|---|
| Detector file skeleton with the exact `(content, filePath) => InlineMatch[]` signature | `check-registry/types.ts:70` | Compiles, returns `[]`, marked `// TODO(interlinked): predicate` |
| Pattern seed | Longest common substring across sampled `message` values, ≥8 chars, ≥60% support | A *literal*, with its support recorded. Emitted as an escaped string constant, never as an inferred regex |
| MUST-FIRE cases | One per distinct `sample_files` entry, using the recorded excerpt verbatim | Real evidence. These are the events that actually happened |
| MUST-NOT-FIRE stubs | `required_negative` empty `it("N1: …", …)` blocks | **Deliberately empty.** Fire records contain no counter-examples; generating one would be fabrication |
| Registry fragment | `CheckRegistration` fields the draft knows | Emitted as `registry-entry.jsonc.draft` — data, not code, and not applied |
| Tier + required counts | `tierFor(phase, id, advisorySkips)` (`obligations.ts:76-80`) | Exact, from the live obligation table |

Rendered case labels use the `P1:` / `N1:` prefix dialect
(`case-parser.ts:31, 44-46`) so the real parser counts them — M1's key test
asserts exactly that by running `case-parser.ts` over the generated text.

**Every emitted artifact carries a `.draft` suffix** (`sensor.ts.draft`,
`sensor.test.ts.draft`). A `.ts` file inside `.interlinked/` should already be
invisible to the scanner (`recurrence-scanner.ts:44` skips `.interlinked`), but
this tree has been bitten by tools that walk it anyway — `stryker.conf.json`
MUST ignore `.interlinked/` because Stryker's tree-copy crashes on the harness
socket (CLAUDE.md). The suffix makes "not live code" true by construction and
visible in the filename.

### 3.5 Staging area, review verbs, and the Goodhart guard

```
.interlinked/proposals/
  index.json                     # id → {signature, state, drafted_at}
  decisions.jsonl                # append-only AcceptDecision rows
  approvals/                     # protected; see below
  <proposal_id>/
    proposal.json                # SynthesisProposal
    sensor.ts.draft
    sensor.test.ts.draft
    registry-entry.jsonc.draft
    guide.md.draft
```

CLI surface, all under the existing `recurrence` command
(`registrars/observability-logs.ts:20`):

```
interlinked recurrence synthesize --list                      # candidates only; writes nothing
interlinked recurrence synthesize <signature>                 # draft a proposal
interlinked recurrence synthesize <signature> --draft-with-cloud   # §3.7, opt-in
interlinked recurrence proposals [--state drafted]            # the review queue
interlinked recurrence proposal <id> [--show sensor|cases|guide]
interlinked recurrence accept <id> --approved-by <handle> [--apply-guide]
interlinked recurrence reject <id> --reason <text>
```

**Accept does not activate.** It materializes `sensor.ts.draft` →
`src/harness/checks/<file>.ts` and `sensor.test.ts.draft` → its companion test,
and prints the remaining CLAUDE.md steps 2-6. It **never** edits
`check-registry/entries-*.ts` or `check-metadata/`. The check therefore enters
the registry the ordinary way, where `check-evidence/contract.test.ts` demands
real labeled cases and grants no grandfathering.

#### The Goodhart guard, stated honestly

The brief's requirement — "the agent whose mistakes generate signatures must not
be able to auto-accept its own proposals" — has no cryptographic local solution.
The agent and the user share a shell; any CLI verb the user can type, the agent
can run. This repo already holds that position:
`feedback_local_checks_not_a_trust_boundary.md`. So the memo claims deterrence
and visibility, not a boundary. Four layers, weakest claim first:

1. **Acceptance is not activation** (the durable one). Even a fully
   self-accepted proposal yields a stub detector that returns `[]` and a test
   file with empty negative cases. It cannot be registered until a human or
   agent writes a working predicate and real MUST-NOT-FIRE cases, and the
   evidence-contract pin fails loudly if they do not. The expensive step is
   deliberately not automatable.
2. **Provenance refusals** (deterministic, from recorded data):
   `self_approval` when the accepting session id appears in
   `candidate.observing_sessions`; `same_session_draft` when accept and draft
   share a session; `insufficient_sessions` below the policy floor;
   `stale_candidate` when the live counts have moved materially since drafting.
   These block the naive loop — the agent that trips a check, drafts a sensor
   for it, and accepts it in the same breath.
3. **Diff visibility.** `decisions.jsonl` records every accept and reject with
   actor session and approver. If it is git-tracked (§8 decision 1), an accept
   shows up in a PR diff exactly like `check-evidence-baseline.json`
   (`.gitignore:185-188`) and `guard-disabled.json` (`.gitignore:198-201`).
4. **Defense-in-depth on the ledger.** `.interlinked/proposals/decisions.jsonl`
   and `approvals/**` get the `scanner/pending` treatment — a `protected_files`
   entry alongside `default-config-resolvers.ts:198`, plus a
   `builtin-proposal-ledger-access` guard rule modeled on
   `builtin-scanner-pending-access` (`builtin-rules-security.ts:88-120`) so the
   long-tail Bash/Grep/Glob path is closed too. This stops accidental rewriting;
   it does not stop a determined local process, and the rule comment must say so.

### 3.6 Guide emission

`guide.md.draft` is a small markdown fragment inside a managed block, using the
gen-marker idiom this repo already relies on (`<!-- gen:line_cap -->` in
CLAUDE.md):

```markdown
<!-- interlinked:recurrence-guide start id=<marker_id> provisional -->
**Provisional steering (from recurrence `<signature>`).**
Observed 2,962 times across 124 sessions, 591 files; last seen 2026-08-12.
<one to five imperative lines, each starting with a verb>
_Drafted <date> by `interlinked recurrence synthesize`. Review or remove; this
block is machine-managed and is replaced wholesale on redraw._
<!-- interlinked:recurrence-guide end id=<marker_id> -->
```

Three constraints:

- **Provisional and provenance-bearing.** A reader can always tell it was
  machine-drafted, from what, and when.
- **Capped.** `MAX_GUIDE_BODY_LINES` per fragment and a total cap on the managed
  region. Steering prose lives in a file loaded every session; unbounded growth
  converts a fix into a context tax.
- **Idempotently replaceable.** Redrawing the same `marker_id` replaces the
  block rather than appending, so a stale guide never accumulates beside its
  successor.

`--apply-guide` writes the block; without it, `accept` prints the fragment and
the target path and changes no file.

The body lines themselves come from a template keyed on the recurrence's
`check_id`, filled with the check's own registered `fix_instruction`
(`check-registry/types.ts:68`) — which is prose a human already wrote and
reviewed. This is the single most important design choice in §3.6: the default
path does not generate steering language, it *relocates* existing reviewed
language from a post-hoc warning into a pre-hoc guide. When no `check_id` is
available (a `harness_missed` or `tool_failure` signature), the body is a
provenance stub with a `TODO(human)` line, and the guide is honestly thin rather
than dishonestly fluent.

### 3.7 The optional cloud-draft lane

`--draft-with-cloud` exists to make the guide prose readable when the
template's relocated `fix_instruction` reads badly out of context. Constraints,
all of which are testable:

- **Never auto-fires.** No hook phase, no Stop path, no SessionStart. Only a
  human-typed flag, matching `skills/enforce/SKILL.md:24, 121`.
- **Off unless configured.** Refuses with a clear message when the Tier-2/3
  cloud config is absent, rather than silently degrading.
- **Bounded authority.** It may rewrite the guide body and the pattern-seed
  comment inside an already-generated deterministic skeleton. It may not choose
  the phase, severity, determinism, check id, tier, or state; it may not write
  `proposal.json`'s decision fields; it cannot accept anything.
- **Labeled.** `drafted_by: "cloud:<model>"` on the proposal and in the rendered
  header, so a reviewer never mistakes model prose for template output.
- **Not the check pipeline.** No LLM ever runs inside a check, a rule, or an
  evaluator. This lane is a document generator invoked from a CLI verb, at the
  cadence Part 7 assigns to inferential work (`session-2026-08-11-synthesis.md:419-426`).

### 3.8 Hook phases

| Phase | This design |
|---|---|
| PreToolUse | **Nothing.** No block, no warn. |
| PostToolUse | **Nothing.** |
| Stop | One optional line: "N recurrence signature(s) crossed the synthesis threshold — `interlinked recurrence synthesize --list`". Formatter returns `string \| null` and never blocks, matching the family in `verification-stop-checks.ts:121-438` wired through `server/lifecycle-stop-warnings.ts:23, 55`. |
| SessionEnd | Nothing. |

The Stop nudge must not read 53 MB. `trigger-cursor.ts` keeps a byte offset plus
folded per-signature counters in `.interlinked/proposals/trigger-state.json` and
folds only the new tail, reusing `foldRecurrenceLine`'s streaming shape
(`check-health.ts:86-97`) and the byte-offset cursor idiom already used by the
activity sync. It honors `event.dry_run` and writes nothing on a dry run — the
rule CLAUDE.md records after three simulated writes opened a real transient debt.

---

## 4. Integration points

### 4.1 Recurrence substrate

One additive change: `Recurrence` gains `observing_sessions: string[]`
(bounded, e.g. 25 most recent) alongside `distinct_sessions`
(`recurrence.ts:177`). The aggregator already holds the `Set<string>`
(`recurrence.ts:159`) and discards it; retaining a bounded sample costs nothing
and is the only field the self-approval refusal needs. Existing consumers are
unaffected — the field is additive.

`proposeAction` (`recurrence.ts:201-223`) gains a `tool_failure` branch instead
of falling through to `ratchet`.

### 4.2 CLI + registrar

Four new verbs on the existing `recurrence` command in
`registrars/observability-logs.ts:20-80`, following the existing lazy-import
pattern (`await import("../commands/recurrence-synthesize.js")`). The
subcommand-name pin at `observability-logs.test.ts:149-151` and the
option-shape assertions at lines 200-220 update in the same change.

### 4.3 Check registry and metadata

**Not touched by any synthesis code path.** This is a deliberate seam: the only
way a synthesized detector becomes live is a human-authored registry entry that
must then satisfy `check-evidence/contract.test.ts`. The generated
`registry-entry.jsonc.draft` is copy-paste input for that step, never an
applied edit.

`check-inventory.ts` counts stay unchanged, so `docs-freshness` and
`harness checks` are unaffected until a real check is registered.

### 4.4 `.interlinked/` files and gitignore

| Path | Content | Tracking |
|---|---|---|
| `.interlinked/proposals/<id>/**` | Draft artifacts | Gitignored by the root-anchored `.interlinked/*` (`.gitignore:171`) — runtime state |
| `.interlinked/proposals/index.json` | Review queue | Gitignored |
| `.interlinked/proposals/trigger-state.json` | Cursor + counters | Gitignored |
| `.interlinked/proposals/decisions.jsonl` | Accept/reject ledger | **Open decision** (§8.1). A carve-out (`!.interlinked/proposals/decisions.jsonl`) makes every acceptance PR-visible, matching the `check-evidence-baseline.json` rationale at `.gitignore:186-188` |
| `.interlinked/proposals/approvals/**` | Approval markers | Gitignored, and added to `protected_files` |

Note that `.gitignore:171` is root-anchored, so nested `.interlinked/` dirs are
covered separately at line 207 — a proposals directory under the repo root is
the only case that matters.

### 4.5 Baseline-integrity implications

**Invariant: no synthesis artifact may ever loosen a water-line.** Synthesis
proposes *new* advisory checks and *new* prose. It never edits
`coverage-baseline.json`, `metric-caps.json`, `large-files-baseline.json`,
`untested-files-baseline.json`, `check-evidence-baseline.json` or the mutation
baselines, so `detectBaselineGaming`'s covered-file regex
(`evaluator/baseline-integrity-gate.ts:47`) needs no change.

Two second-order points:

- **`check-evidence-baseline.json` must stay shrink-only.** The tempting
  shortcut for an accepted-but-unfinished sensor is to grandfather it. That is
  exactly the move the gate blocks, and CLAUDE.md states new checks get no
  grandfathering. The accept path must never write that file — worth a
  regression test, not just a comment.
- **If `decisions.jsonl` becomes tracked**, it acquires a monotonicity
  obligation of its own: append-only, prior rows immutable, and a `reject` may
  not be rewritten into an `accept`. That belongs in the commit-gate backstop
  (`evaluator/commit-baseline-gate.ts`) alongside the three other
  git-tracked/stageable baselines, and it is a reason the §8.1 decision is not
  free.

### 4.6 Interaction with `check-health`

A `harness_caught` signature whose check is a `probation-candidate`
(`check-health.ts:172-184`) is ambiguous: either the agent ignores good advice
(a steering problem) or the check is noisy (a demotion problem). The default
proposed here is to **annotate, not suppress** — the candidate carries a
`check_health: "probation-candidate"` note so the reviewer sees both readings
before writing steering prose for a check that may be about to be demoted.
Whether it should suppress outright is §8.6.

---

## 5. Milestones

Each milestone is independently landable and independently verifiable, and
leaves the tree committable.

### M0 — candidate detection only (no artifacts)

`src/harness/recurrence-synthesis/{types.ts,triggers.ts}` plus
`interlinked recurrence synthesize --list`. Pure evaluation over already
aggregated rows; writes nothing; creates no directory. Also removes the
divergent `signatureOf` copy at `commands/recurrence.ts:150-161` in favor of
`deriveSignature`, and adds `outcome_marker` to `KNOWN_KINDS` (line 52).

**Verification:** unit tests on `evaluateCandidate` — one per policy row, plus
boundary cases at exactly `min_count` and `min_count - 1`, an over-age
signature, and a kind with no policy; a test that `TRIGGER_POLICIES` matches its
pinned snapshot; a regression test that `list` then `detail` round-trips a
`tool_failure` signature (the §1 defect, currently reproducible); and a live run
against the real 193,854-row log with the candidate table and its `because`
clauses pasted into the PR description.

### M1 — deterministic sensor + evidence-case scaffolding

`pattern-seed.ts`, `render-sensor.ts`, `render-cases.ts`, `proposals.ts`.
`synthesize <signature>` writes a proposal directory. No accept verb yet.

**Verification:** golden-file tests for both renderers; **the load-bearing
test** — feed the generated `sensor.test.ts.draft` to the real
`check-evidence/case-parser.ts` and assert it yields exactly
`required_positive` positive and `required_negative` negative labeled cases for
the tier `tierFor` returned; a property test that `pattern-seed` output is a
genuine substring of every message it claims support from; a test that
`check_id` collision against the live `CHECK_REGISTRY` refuses at draft time;
and a probe run on the top real `tool_failure` signature with the generated
files read back.

### M2 — guide emission

`render-guide.ts` and `--show guide`.

**Verification:** golden fragment test; a test that re-rendering the same
`marker_id` replaces rather than appends (run it twice, assert one block); a cap
test asserting an over-long body truncates with an explicit marker rather than
silently; a test that a `check_id`-bearing candidate reuses the registered
`fix_instruction` verbatim and a `check_id`-less one emits the honest stub.

### M3 — review verbs and the refusal ladder

`accept.ts`, the `proposals` / `proposal` / `accept` / `reject` verbs,
materialization, the append-only decisions log, the `protected_files` entry and
the `builtin-proposal-ledger-access` guard rule.

**Verification:** one unit test per `AcceptRefusal` member; an integration test
that a successful accept writes exactly the paths in
`AcceptDecision.materialized` and touches no file under `check-registry/`,
`check-metadata/` or `.interlinked/check-evidence-baseline.json`; a test that a
second accept of the same id refuses `already_decided` and appends rather than
rewrites; guard-rule parity tests matching the `builtin-scanner-pending-access`
suite; and a live `interlinked harness test` probe showing the new rule blocks a
Bash read of the approvals path (with the daemon rebuilt and restarted first —
CLAUDE.md's stale-daemon rule).

### M4 — Stop-cadence nudge and trigger cursor

`trigger-cursor.ts` plus one formatter in the
`verification-stop-checks.ts` family, wired in `server/lifecycle-stop-warnings.ts`.

**Verification:** unit tests on cursor advance, truncation reset (file shrank),
and corrupt-state reset; a test asserting the Stop path reads at most the tail
past the cursor and never calls `loadRecurrenceEvents`; a `dry_run: true` test
asserting no cursor write; a rate-limit test asserting at most one nudge per
session; and a live session-end observation of the emitted line.

### M5 — optional cloud-draft lane (gated; may be dropped)

`--draft-with-cloud`.

**Verification:** a test that the code path is unreachable without both the flag
and configuration present; a test that no hook-phase entry point can reach the
module (import-graph assertion, in the spirit of the existing structural
checks); a test that the cloud lane cannot alter phase, severity, check id,
tier, or state; and a golden test that `drafted_by` reaches both the proposal
record and the rendered header.

---

## 6. Evidence obligations

The synthesizer registers no check, so the Check Evidence Contract does not bind
it directly. Four obligations bind it anyway:

1. **Companion tests per module.** Every file in
   `src/harness/recurrence-synthesis/` ships one, per house convention. The
   renderers get golden files; `triggers.ts` and `pattern-seed.ts` get property
   tests (`fast-check` is already used in
   `src/harness/__tests__/reservations.test.ts`).
2. **Generated stubs must satisfy the contract they propose.** M1's key test
   runs the real `case-parser.ts` over generated output. If the generator's
   labeling dialect drifts from `directionFromTitle`
   (`case-parser.ts:44-55`), the test fails — that is the whole point of using
   the real parser rather than a copy.
3. **Corpus obligation lands where it can mean something.** Running a corpus
   scan of a generated *stub* is meaningless (it has no predicate). The corpus
   obligation therefore stays where it already lives: on the human-completed
   detector at registration time, per `obligations.ts:104-113`. M0's live run
   over the real log is the corpus evidence for the *trigger*, and its output
   belongs in the PR description.
4. **Policy pinning.** `TRIGGER_POLICIES` and the guide caps are pinned by a
   regression test, so recalibration surfaces in a diff — the
   `DEFAULT_ADVISORY_SKIPS` idiom (CLAUDE.md).

Anti-obligation worth stating: **do not add a check that measures how many
proposals were accepted.** That is a Goodhart surface with no upside; see §7.2.

---

## 7. Risks + anti-goals

1. **Anti-goal: auto-activation.** No synthesized artifact ever loads. Not
   through `distilled-rules.json` (that file is `/enforce`-owned —
   `rules/distilled-rules.ts:78-84`), not through the check registry, not
   through `guard-rules.local.json`. If a future milestone proposes an
   "auto-enable trivially safe sensors" path, it is out of scope by
   construction, not by preference.
2. **Goodhart: check count as a score.** CLAUDE.md is explicit that more checks
   are a cost. A synthesis loop lowers the cost of *drafting* and therefore
   raises registry-inflation pressure. Mitigations: conservative thresholds,
   `--list` as the default surface, human-written negative cases as the
   unavoidable bottleneck, and no metric anywhere that rewards accepting
   proposals.
3. **Goodhart: the tautological detector.** An agent that wants a proposal
   accepted can write a predicate matching only its own recorded fixtures — a
   detector that fires on the stub cases and nothing else. The corpus obligation
   at registration time is the answer: a detector firing 0 times or 9,000 times
   across the tree is visible, which is exactly how `halstead_difficulty` was
   caught. State it in the generated file header so the reviewer looks for it.
4. **Determinism policy.** The default path contains no LLM: threshold
   arithmetic, longest-common-substring, and string templates. The cloud lane is
   opt-in, human-typed, off every hook phase, and cannot decide anything
   structural (§3.7). This satisfies `feedback_harness_deterministic_only.md`
   and Part 7's cadence table.
5. **FP bar.** Synthesized sensors are `post` + `heuristic` + advisory, always.
   Promotion to `pre_warn` or `pre_block` is out of scope and goes through the
   ordinary tier ladder with corpus, mutation and adversarial evidence
   (`obligations.ts:25-45`). A generated stub can never be a hard rail.
6. **Log-read cost.** `loadRecurrenceEvents` full-reads 53 MB
   (`recurrence.ts:235-251`). Acceptable for a typed verb, not for Stop. M4's
   cursor exists solely for this, and its test asserts the constraint rather
   than trusting the comment.
7. **Stale guide fragments.** A provisional block that outlives its signature is
   a permanent context tax on every session. Provenance headers make staleness
   visible; whether pruning is automatic is §8.5.
8. **N=1 discipline.** Nothing here reworks the registry, retires a check, or
   moves a threshold on an existing gate. The one genuinely repo-calibrated
   artifact is `TRIGGER_POLICIES`, and §3.3 marks it as provisional pending a
   second codebase. A quiet trigger in another repo is not a broken trigger.
9. **Trust-boundary honesty.** §3.5 claims deterrence and visibility, not a
   boundary. Any code comment, CLI message, or doc line that implies the agent
   *cannot* accept its own proposal is wrong and must not be written.
10. **The signature-derivation drift is live.** Two implementations disagree
    today (§1, measured). Adding a third consumer without fixing it converts a
    cosmetic bug into a correctness bug in the accept path, since a proposal is
    keyed by signature. M0 fixes it first for that reason.

---

## 8. Open decisions for the user

1. **Track `.interlinked/proposals/decisions.jsonl` in git?** Tracking makes
   every acceptance PR-visible (the strongest available Goodhart deterrent) but
   adds a tracked append-only file and a commit-gate monotonicity obligation
   (§4.5). Untracked keeps the tree clean and makes acceptance invisible.
2. **Where does `accept` materialize?** Directly into
   `src/harness/checks/` (convenient, puts generated stub code in the tree), or
   into `scratch/` for the human to move (safer, one more manual step)?
3. **Guide target.** A managed block in `CLAUDE.md` (read every session,
   maximum steering effect, direct context cost), a dedicated
   `docs/steering/recurrence-guide.md` (no automatic context cost, weaker
   effect), or a skill file (loaded on demand)?
4. **Build the cloud-draft lane (M5) in this tranche, or defer it entirely to
   the Tier-2/3 program?** The deterministic path is fully usable without it.
5. **Auto-prune stale guide blocks**, or report them and let the human delete?
   Auto-prune keeps the context tax bounded; it also means a machine silently
   deletes steering prose a human may have edited in place.
6. **Should a `probation-candidate` check (`check-health.ts:172-184`) suppress
   guide emission entirely?** Framed differently: when the agent repeatedly
   ignores a noisy heuristic check, is that a steering failure or a check
   failure? §4.6 currently annotates rather than suppresses.

---

## 9. Effort estimates

Basis: comparable landed work in this repo — `check-health.ts` (222 lines,
thresholds + streaming fold + CLI) and `check-evidence/` (types, tiers, parser,
resolver, sweep, baseline in one tranche).

| Milestone | Estimate | Basis |
|---|---|---|
| M0 — candidates + signature fix | 0.5 day | Two small pure modules, one CLI verb, one real bug fix with a reproducible test |
| M1 — sensor + case scaffolding | 1–1.5 days | Four modules; the renderers are mechanical, the parser round-trip test is the real work |
| M2 — guide emission | 0.5 day | One renderer + managed-block replacement; closely mirrors the gen-marker idiom |
| M3 — review verbs + refusal ladder | 1–1.5 days | Four verbs, six refusals, materialization, a guard rule with parity tests, protected-file wiring |
| M4 — Stop nudge + cursor | 0.5–1 day | Cursor correctness (truncation, corruption, dry-run) is most of it; the formatter is small |
| M5 — cloud lane (optional) | 0.5 day | Thin; nearly all effort is in the "cannot be reached" tests |
| **Total** | **3.5–5 days** (4–5.5 with M5) | Consistent with small, independently verifiable units |

---

## Depends on / feeds

**Depends on:** nothing blocking. M0 needs only `aggregateRecurrences` and
`deriveSignature`, both of which exist and are exercised today. The
`observing_sessions` field (§4.1) is an additive change to a shape this memo
also consumes; no other memo reads it.

**Feeds:**

- **The verification-evidence-ledger plan** (`18-verification-evidence-ledger.md`):
  an `AcceptDecision` is a natural `EvidenceRecord` — `subjectId` = the
  proposal id, `verdict.strength` = `"attested"` (a human approval artifact),
  `invalidatedBy` = the candidate's counts. This memo does **not** build that
  adapter and does not depend on the ledger landing. If the ledger lands first,
  M3 should write through it instead of only appending to `decisions.jsonl`;
  the sequencing is the integrator's call, and either order works because the
  decision row is the same data.
  One concrete request to that plan: `EvidenceSubjectKind` currently reserves
  `mutant`/`check`/`file_coverage`/`spec_finding`/`test_case`/`scenario`. A
  `"proposal"` member would be additive.
- **The dispositions plan:** no coupling. Different subject domain (mutants, not
  recurrence signatures) and different lifecycle.
- **The test-receipts plan:** no coupling in this tranche. One shared idea worth
  keeping aligned: both plans generate a stub that a human must complete, and
  both must resist the temptation to let generated evidence discharge an
  obligation. If a future milestone lets a synthesized sensor's cases count as
  receipts, that is a joint design, not a unilateral one.
- **The harness-coverage report** (synthesis backlog item 3, not yet a memo):
  it wants applicability, executions, skips, suppressions and adjudications per
  check. `synthesize --list`'s candidate set is one input to that report's
  "which checks are we ignoring" column, and `check-health`'s probation status
  is the other. Whoever writes that memo should read §4.6 first.
- **The integrator agent:** M0 can land in any order relative to the other five
  plans. M1-M4 are strictly sequential within this memo. Nothing here blocks
  another plan's milestone.
