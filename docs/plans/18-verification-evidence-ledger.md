# 18. Verification state machine + evidence ledger substrate

**Status:** design memo, 2026-08-14. **Not built.** No `src/` change accompanies
this document; every code block below is an **UNVERIFIED SKETCH** — proposed, not
type-checked, not run.

**Numbering note for the integrator:** this file and
`18-mutation-disposition-registration.md` both carry `18`, an artifact of the
six plans being drafted in parallel. Renumber at sequencing time; the content
does not depend on the number.

**Companions**

| Doc | Relationship |
|---|---|
| [`session-2026-08-11-synthesis.md`](../design/session-2026-08-11-synthesis.md) Parts 4–7, 11 | Requirements source. This memo is ranked-backlog item **#1** there ("Stable verification state machine and evidence ledger — the common substrate for mutation rounds, specs, scenarios, and ratchets", Part 4). |
| [`equivalent-mutant-handling.md`](../design/equivalent-mutant-handling.md) | The evidence ladder this substrate generalizes past mutants. |
| [`verification-density-program.md`](../design/verification-density-program.md) | The Check Evidence Contract — a narrower, **already-shipped** instance of "does this claim have enough evidence", scoped to check detectors only. §2.3 explains why it cannot simply be widened. |
| [`baseline-integrity-gate.md`](../design/baseline-integrity-gate.md) | The water-line pattern this design deliberately does **not** invoke at M0–M4, and names precisely as what a later ratchet would have to invoke (§4, §8 decision 4). |
| [`mutation-residue-ledger.md`](../design/mutation-residue-ledger.md) | The hand-rolled, `scratch/`-derived precursor this substrate would make durable. |

**Sibling plans in the same wave:** `18-mutation-disposition-registration.md`
(dispositions) and `19-test-receipt-blinded-review-machine.md` (test receipts).
See **Depends on / feeds** at the end — the composition with the dispositions
plan is load-bearing and is stated explicitly in §4.

---

## 1. Problem + evidence

### 1.1 Evidence in this repository dies twice

Every verification subsystem here answers the same two questions —
**"why should I trust this verdict?"** and **"when does it stop being
trustworthy?"** — and each answers them differently, or not at all.

Measured live against this working tree today (`node` over
`.interlinked/mutation-manifest.json`, generation `1292`,
`authoritativeAt: 2026-08-14T17:22:10.416Z`):

| Fact | Value |
|---|---|
| Files in the manifest | 738 |
| Symbols | 7,145 |
| Mutant records | **111,890** |
| `engine` / `engineVersion` | `stryker` / **`unknown`** |
| `dependencyGraphVersion` / `environmentHash` | `1` / `cli-measure` |
| Files carrying `fileProvenance` | 738 (all) |
| …of which carry `engine`/`engineVersion` | **0** |
| Provenance `scope` | `import_graph` 726, `glob_fallback` 12 |
| Provenance `surface` | `sweep` 469, `measure` 269 |
| Records carrying a typed `disposition` | **0 of 111,890** |

Two findings there, both of which this memo exists to fix.

**Finding 1 — one fingerprint for the whole snapshot.** `engine`,
`engineVersion`, `dependencyGraphVersion`, and `environmentHash` are
*manifest-level* fields (`src/harness/mutation/types.ts:146-152`), so 111,890
records measured across at least two surfaces and 469+269 separate runs all
share one environment identity — and that identity is the literal strings
`unknown` and `cli-measure`. `MeasurementProvenance` (`types.ts:129-138`) has
optional per-file `engine`/`engineVersion` fields; **no writer populates them**
(0/738 measured above). The synthesis reached the same conclusion from an
earlier snapshot and named it a design finding rather than a data-entry lapse
("a proof-grade or comparable measurement needs exact engine, mutator, runtime,
dependency, test-selection, and environment identities", Part 5, "Saved manifest
addendum"). It is still true, and it is structural.

**Finding 2 — the state that carries a judgment is dropped on remeasure.**
`toRecord` (`src/harness/mutation/manifest.ts:317-328`) rebuilds a `MutantRecord`
from exactly `(identity, status, firstSeen)`. `disposition` and
`accepted_reason` are not carried. `refreshSymbol`
(`manifest.ts:382-400`) preserves a prior record verbatim **only** when there
are no fresh measurements *and* the symbol hash is unchanged
(`if (ms.length === 0 && prev && prev.symbolHash === entry.symbolHash) return prev;`,
`:386`); every other path routes through `toRecord` at `:390` and loses the
judgment — including a remeasurement of an **unchanged** symbol. So a
`dead_code` finding an agent proved and recorded is erased by the next sweep of
the same untouched file. This is not speculative: 0 of 111,890 records carry a
disposition today, while `docs/design/mutation-residue-ledger.md` documents a
698-row classification of exactly these judgments (`:383`, `:394` — "698 total,
canonical read"), none of which is in the manifest.

Those two findings are the same disease at two altitudes. Evidence dies once
because nothing recorded *what produced it and under what conditions*, and again
because the row it lived in is rewritten by the next writer that touches the
file. **The fix is not a better field on `MutantRecord`. It is a record whose
lifetime is governed by its own invalidation inputs.**

### 1.2 The same problem, solved three times, at three different strengths

| Ledger | Verdict richness | Invalidation inputs | Verifier identity |
|---|---|---|---|
| `coverage-baseline.json` (`src/harness/coverage-ratchet.ts:61-67`) | `{lines_pct, branches_pct}` — a bare number pair | **none** — one file-level `updated_at` for all 1,097 entries (measured live; `updated_at: 2026-08-10T20:21:07.843Z`) | **none** |
| `mutation-manifest.json` (`mutation/types.ts:141-160`) | `MutantStatus` (6 states) + optional `SurvivorDisposition` (**8** kinds, `disposition.ts:115-128`) | manifest-level only (§1.1); a `ProofCertificate` carries per-record `CertificateValidity` (`disposition.ts:76-85`) — for 3 of the 8 kinds | `ProofCertificate.producedBy` / `verifierVersion` (`disposition.ts:87-94`), same 3 kinds |
| `.interlinked/check-evidence-baseline.json` (`check-evidence/types.ts:144-159`) | `EvidenceVerdict{satisfied, shortfalls}` (`types.ts:107-116`) | **none** — a check is exempt or it is not | **none** |
| `.interlinked/findings/reconciliation.jsonl` (`spec/reconciliation.ts:14-25`) | 3 states (`open`/`touched`/`acked`, `:12`) | **none** — `reanchored` moves the anchor without re-opening (`:66`) | `by` string, unvalidated |

The strongest of the four (mutation dispositions) got there by building, from
scratch, exactly the machinery this memo generalizes: per-record invalidation
inputs (`CertificateValidity`), a verifier identity that is explicitly *not the
command that recorded it* (`producedBy`, "never the accept command itself",
`disposition.ts:88`), and a staleness check that compares bound hashes against
current state before trusting a certificate (`certificateHolds`,
`disposition.ts:160-166`). That machinery is correct. It is also mutant-only,
and three sibling subsystems reinvented weaker versions of it.

### 1.3 What the weakness costs, concretely

The synthesis records that four Sonnet-fleet waves produced "489
proven-equivalents", and that the wording was wrong: a differential or fuzz
search that fails to find a counterexample makes a mutant `unresolved`, never
`proved_equivalent` (Part 5, "A survivor is not a conclusion"). Nothing in any
schema *forced* that distinction at write time. `disposition.ts` was built
afterward, specifically to stop prose from standing in for a mechanism
(`disposition.ts:1-35` header) — a correct fix, applied to one subject kind,
one time, after the misclassification had already happened.

This memo's claim is narrow and testable: **the distinction that had to be
retrofitted for mutants is the same distinction coverage, check evidence, spec
findings, test receipts, and scenarios will each need**, and it should be
declared once.

## 2. Current state (verified, file:line)

Everything below was re-checked against source in this session, independently of
the synthesis's own claims about it. Where the synthesis or `CLAUDE.md` is
stale, that is called out.

### 2.1 The transition-function pattern exists three times and converges

Each is a union declared once and folded by one function, so live execution and
replay agree by construction:

- **`src/harness/reservations-state-machine.ts`** — `ReservationTxn`, a 6-member
  discriminated union (`:105-123`). `applyTransition` (`:135-182`) switches on
  `txn.kind`; the `default` arm assigns to a `never`-typed local
  (`const _exhaustive: never = txn;`, `:177`), so an unhandled new member fails
  to compile rather than silently no-op. `replayTransitions` (`:187-191`) folds
  an event array over an empty cache — the property-test hook for `live ==
  replay`. The header calls this "the Bitar single-source-of-truth pattern
  adapted for TS" (`:9-12`).
- **`src/harness/spec/reconciliation.ts`** — the same discipline over an
  **on-disk JSONL sidecar**. `ReconciliationTxn` (`:14-25`) has a 4-value
  `action` (`touched`/`acked`/`reopened`/`reanchored`); `appendReconciliationTxn`
  (`:46-50`) appends one line to `.interlinked/findings/reconciliation.jsonl`
  (`SIDECAR_REL`, `:27`); `applyTxn` (`:58-70`) folds; `loadReconciliation`
  (`:119-136`) re-derives current state by replaying the whole file.
  Two operational details worth copying verbatim: `tornTailPrefix` (`:36-44`)
  prepends `\n` when the existing file lacks a trailing newline, so a torn write
  cannot corrupt the next record; `parseTxnLine` (`:110-116`) returns `null` on a
  malformed line, so a corrupt row is skipped rather than fatal. Its design doc
  names the lineage: "State transitions go through one `applyTransition` (the
  reservations `ReservationTxn` discipline) so live and replay can't drift"
  (`docs/design/spec-audit-runtime-checks.md:291`).
- **`src/harness/mutation/disposition.ts`** (447 lines) — `SurvivorDisposition`,
  an **8**-kind union (`:115-128`: `killed`, `dead_code`, `proved_equivalent`,
  `proved_unreachable`, `duplicate`, `outside_contract`, `accepted_risk`,
  `unresolved`). `EQUIVALENCE_REFUSALS` (`:175`) is typed
  `Record<SurvivorDispositionKind, string | null>`, so adding a kind without
  deciding its refusal text fails to compile. `certificateHolds` (`:160-166`) is
  the one place in the tree that already does what §3 generalizes: it checks a
  certificate's bound `mutantId` / `sourceSymbolHash` / `environmentHash` /
  `dependencyGraphVersion` (`CertificateValidity`, `:76-85`) against **current**
  state before trusting it. `dispositionOf` (`:438-447`) returns a
  `DispositionView` (`:420-426`) whose `source` field distinguishes `typed` from
  `legacy_prose` — legacy prose is surfaced verbatim and folded to `unresolved`
  (`:443`), never reinterpreted as evidence.

### 2.2 The disposition write path is callable; its CLI is unregistered

`recordDisposition` (`src/harness/mutation/accept.ts:180-186`) writes a
`SurvivorDisposition` onto a `MutantRecord` via `withMutant`, refusing anything
that grants equivalence (`grantsEquivalence`, `:181`) and never touching
`accepted_reason` — so a `dead_code` note can never be read back as a reviewed
acceptance. It is importable and callable **today**.

`src/commands/mutation-disposition.ts` exports `mutationDispositionCommand`
(`:125`) and deliberately narrows its surface to "the two kinds an automated
auditor can honestly reach" — `dead_code` and `unresolved` (`:18-31`) — because
"a command an agent can call is not a human approving anything" (`:31`).

It is **not registered**: `rg -n 'mutationDispositionCommand' src/ --glob '!*.test.ts'`
returns only its own definition, and the `mutation` command tree
(`src/registrars/quality.ts:317-433`) registers `check` (`:321`), `baseline`
(`:336`), `measure <file>` (`:345`), `survivors` (`:364`), `sweep` (`:383`), and
`accept` (`:422`) — no `disposition`. Registering it is the sibling plan's M0,
not this one's; this memo depends only on `recordDisposition` being callable,
which it is.

### 2.3 The Check Evidence Contract is the same idea, scoped to one subject kind

`CheckEvidence` (`check-evidence/types.ts:64-104`) and `EvidenceVerdict`
(`:107-116`) record per-check-id evidence (labeled cases, corpus adjudication,
detector cyclomatic, mutation score, adversarial gap) against four
`ObligationTier`s (`:39-56`). `sweepEvidence` (`check-evidence/extract.ts:178-201`)
produces `{evidence, verdicts, index}`. `loadCheckEvidenceBaseline`
(`check-evidence/baseline.ts:53`) is fail-closed — a missing or malformed file
yields `EMPTY_BASELINE` (`:24`), never "exempt everything".

**It cannot be widened to cover other subjects.** Its resolver
(`check-evidence/resolve.ts:143` `buildDetectorIndex`, `:178` `resolveDetector`)
is keyed by `detector_fn` name against the check registries; a subject that is
not a registered check has no address in it. That is not a defect — it is the
right scope for that contract — but it means mutants, files, findings, receipts,
and scenarios need their own envelope.

**Stale prose, corrected:** `CLAUDE.md` says "151/252 checks pass; 101
grandfathered". The committed baseline today is
`{"enforced": ["cases"], "exempt": []}` — **zero** exemptions; the grandfather
list has been fully drained. Any milestone that plans to assert something about
the exempt array must not assume it is non-empty (this invalidated a proposed
integration test in the earlier draft of this memo; see M2).

### 2.4 Storage and wiring conventions this design must follow

- **Gitignore.** `.interlinked/*` is blanket-ignored (`.gitignore:171`) with an
  explicit carve-out allowlist (`:172-201`). `mutation-manifest.json`,
  `coverage-baseline.json`, `check-evidence-baseline.json`… — of those, only
  `check-evidence-baseline.json` (`:188`) is carved out; the manifest and the
  coverage baselines are not, and `.interlinked/findings/reconciliation.jsonl`
  is not. A new `.interlinked/evidence/ledger.jsonl` therefore needs **no
  `.gitignore` edit** — it inherits the blanket rule, exactly like
  `reconciliation.jsonl`. The comment above the rule states this is intended:
  "New harness state files added by future features are gitignored
  automatically — no `.gitignore` update required" (`:168-170`).
- **Registrars.** `src/index.ts:26` imports `registerCapsCommands` from
  `./registrars/caps.js`; `:92` calls it with the shared `program`;
  `src/registrars/caps.ts:12` exports
  `function registerCapsCommands(program: Command): void`. §3.4 follows this
  exact shape. There are 18 registrar calls in `src/index.ts:84-106`.
- **Stop-event helpers** are dispatched from `buildStopWarnings`
  (`src/harness/server/lifecycle-events.ts:440-458`), **not** from `server.ts`
  directly — the dispatcher is "a flat list of 'produce a warning, maybe push
  it'" (`:436-437`) chaining `buildCommitCadenceNudge` (`:446`),
  `buildEditMechanicsStopNudge` (`:449`), `buildStaleBaselineNudge` (`:454`),
  and `buildVerificationStopWarnings` (`:456`). A new Stop reflection is one
  more `string | null` producer in that list.
- **JSON payloads** use `JsonValue` / `isJsonObject` from `src/lib/json-types.ts`
  (`:56`, `:46`) — already the `disposition.ts` convention (`:37-38`).

### 2.5 Name-space census (constrains §3, so it is recorded here)

`check-evidence/` already owns `EvidenceVerdict`, `EvidenceGap`,
`EvidenceDimension`, `EvidenceSweep`, `EvidenceSweepInput`, and the function
name `sweepEvidence`. Verified free repo-wide (`rg` count 0 files each):
`EvidenceRecord`, `EvidenceClaim`, `EvidenceTxn`, `EvidenceState`,
`ClaimStrength`, `SubjectHashes`, `VerifierIdentity`, `InvalidationInput`,
`admitTransition`, `sweepStaleEvidence`, `evidenceLedgerPath`. §3 uses only
names from the free list.

## 3. Design

**UNVERIFIED SKETCH throughout.** No file below has been written or
type-checked.

### 3.1 The envelope

Generalizes three things each already proven once: `CertificateValidity`
(per-record invalidation inputs, `disposition.ts:76-85`),
`MeasurementProvenance` (measurement-condition fingerprinting,
`mutation/types.ts:129-138`), and the reservations/reconciliation transition
discipline (one union, one fold).

```typescript
// src/harness/evidence-ledger/types.ts — PROPOSED, UNVERIFIED SKETCH
import type { JsonValue } from "../../lib/json-types.js";

/** The domain of the subject a record is about. Every switch over this union
 *  must handle a new member to compile (the reservations exhaustiveness
 *  discipline, reservations-state-machine.ts:176-180). */
export type EvidenceSubjectKind =
	| "mutant"        // one mutation site        — federates mutation-manifest.json
	| "check"         // one registered check id  — federates check-evidence-baseline.json
	| "file_coverage" // one file's coverage row  — federates coverage-baseline.json
	| "spec_finding"  // one ingested finding     — federates findings/reconciliation.jsonl
	| "test_case"     // one authored test receipt — RESERVED; built by plan 19
	| "scenario";     // one approved behavior scenario — RESERVED; synthesis backlog #4

/** Stable address of one subject, in the OWNING ledger's own identity scheme.
 *  This substrate never mints identities: `mutantId`, `check_id`, a
 *  repo-relative path, a `finding_id`. */
export interface SubjectRef {
	kind: EvidenceSubjectKind;
	subjectId: string;
}

/**
 * Content identity of the exact state evidence was gathered against.
 *
 * Every field is OPTIONAL and every field is a CLAIM DIMENSION: a subject kind
 * populates only the dimensions it actually varies over. An omitted field makes
 * NO claim — it must never read as "constant" or "already checked". Coverage
 * legitimately has no `engineHash` today because CoverageBaseline never
 * recorded one (§1.2); the adapter leaves it absent rather than inventing one.
 */
export interface SubjectHashes {
	/** Content hash of the subject's own source region — function, file, or
	 *  finding-anchor span. Generalizes `CertificateValidity.sourceSymbolHash`. */
	sourceHash?: string;
	/** Hash of the PROPOSED/overlay content, when the claim concerns a
	 *  not-yet-committed change. Generalizes `MutationReceipt.overlayHash`
	 *  (mutation/types.ts:178-187, field at :180). */
	overlayHash?: string;
	/** Identity of the exercised test set. */
	testsHash?: string;
	/** Verifying tool + version fingerprint — "stryker@8.2.1", "tsc@5.6.0".
	 *  This is the field whose absence made 111,890 records share the string
	 *  `unknown` (§1.1). */
	engineHash?: string;
	/** Toolchain / OS / dependency-graph fingerprint. Generalizes
	 *  `MutationManifest.environmentHash` + `dependencyGraphVersion`. */
	environmentHash?: string;
	/** Hash of the declared contract + observation model the claim assumed.
	 *  Absent means "no contract was declared", which is itself informative:
	 *  a `proved` claim with no observation model is under-specified. */
	contractHash?: string;
}

/** Which SubjectHashes dimensions, if they change, make a record stop being
 *  trustworthy. A record naming zero of them is unfalsifiable (see §3.3). */
export type InvalidationInput = keyof SubjectHashes;

/** WHO produced the evidence. Never the command that recorded it — the
 *  distinction `disposition.ts:88` already draws for ProofCertificate. */
export interface VerifierIdentity {
	name: string;
	version: string;
}

/**
 * The STRENGTH of a claim — one vocabulary every subject kind maps onto.
 *
 * `exempted` is deliberately NOT `attested`: conflating "a human looked and
 * approved this" with "this is grandfathered debt nobody has looked at" would
 * let exemption-list debt launder itself into apparent sign-off (§7 risk 3).
 * `searched` is deliberately NOT `proved`: this is the exact distinction that
 * had to be retrofitted after the "489 proven-equivalents" wording (§1.3).
 */
export type ClaimStrength =
	| "measured"  // a deterministic tool ran and produced a definite result
	| "proved"    // a certificate-bearing proof (rewrite lemma / bounded / SMT)
	| "searched"  // counterexample search found nothing — EVIDENCE, never proof
	| "attested"  // a human/policy approval artifact the agent cannot manufacture
	| "exempted"; // grandfathered / baseline-exempted — nobody verified anything

/** The claim itself. `detail` is an OPAQUE domain payload — a
 *  `SurvivorDisposition`, a shortfall list, a receipt fragment. The ledger
 *  never parses or reinterprets it; it gates only the ceremony around
 *  attaching it. Named EvidenceClaim, NOT EvidenceVerdict: check-evidence
 *  already exports that name for a narrower shape (§2.5). */
export interface EvidenceClaim {
	strength: ClaimStrength;
	detail: JsonValue;
}

export interface EvidenceRecord {
	/** Content-addressed: sha256 over (kind, subjectId, subject, verifier,
	 *  verdict). Two identical claims collapse to one id; a CHANGED claim about
	 *  the same subject is a NEW record — so the ledger is append-only with no
	 *  update-in-place operation. */
	id: string;
	subject: SubjectRef;
	hashes: SubjectHashes;
	verifier: VerifierIdentity;
	claim: EvidenceClaim;
	invalidatedBy: InvalidationInput[];
	/** ISO timestamp. */
	createdAt: string;
}
```

### 3.2 The state machine — one union, one fold

Directly modeled on `reconciliation.ts` (an append-only JSONL txn log folded to
a per-subject state) with `reservations-state-machine.ts`'s `never`-arm
exhaustiveness.

```typescript
// src/harness/evidence-ledger/state-machine.ts — PROPOSED, UNVERIFIED SKETCH

/** Folded state of ONE subject. `unverified` is the implicit initial state of
 *  every subject that has no record — never stored, always derived. */
export type EvidenceState =
	| "verified"   // an admitted measured/proved claim whose hashes still hold
	| "searched"   // best evidence is a counterexample search — honest residue
	| "attested"   // resting on a human approval artifact
	| "exempted"   // grandfathered; nobody verified it
	| "stale"      // an invalidation input changed; the claim no longer binds
	| "disputed";  // a later record contradicts an earlier one — needs a human

/** Every state change the ledger understands. Declared ONCE. */
export type EvidenceTxn =
	| { kind: "assert"; record: EvidenceRecord }
	| { kind: "invalidate"; subject: SubjectRef; recordId: string;
	    dimension: InvalidationInput; was: string; now: string; ts: string }
	| { kind: "dispute"; subject: SubjectRef; recordId: string;
	    against: string; reason: string; ts: string }
	| { kind: "retire"; subject: SubjectRef; recordId: string;
	    reason: "subject_removed" | "superseded"; ts: string };

export interface EvidenceEntry {
	state: EvidenceState;
	/** The record the current state rests on, if any. */
	restingOn?: EvidenceRecord;
	lastTxn?: EvidenceTxn;
	/** Why it went stale — preserved, never overwritten by a later assert of a
	 *  weaker kind. Round 3's "a timeout is not equivalence and must not
	 *  disappear from the report", applied to invalidation. */
	staleReason?: { dimension: InvalidationInput; was: string; now: string };
}

export type EvidenceLedgerState = Map<string, EvidenceEntry>; // key: `${kind}:${subjectId}`

/** The ONE place a txn kind affects state. The `default` arm assigns to a
 *  `never`-typed local, so a new kind fails to compile (reservations
 *  discipline). */
export function applyEvidenceTxn(
	state: EvidenceLedgerState,
	txn: EvidenceTxn,
): EvidenceLedgerState;

/** Replay a whole log against an empty state. Property test asserts
 *  replay(log) === fold(live appends), mirroring reservations.test.ts. */
export function replayEvidence(txns: readonly EvidenceTxn[]): EvidenceLedgerState;
```

Fold rules worth stating, because they are where a substrate like this usually
goes wrong:

| Situation | Rule | Why |
|---|---|---|
| `assert` over an existing `verified` entry with a **different** claim | → `disputed`, both records retained | Silent overwrite is how "489 proven-equivalents" survived review. A contradiction is a human's problem, not a last-writer-wins. |
| `assert` over an existing `stale` entry with **matching current hashes** | → the new claim's state; `staleReason` cleared | Re-verification after a real change is the normal, good path. |
| `invalidate` over `exempted` / `attested` | no-op | Their trigger is policy or time, not a content hash (§3.3). |
| `retire` on `subject_removed` | entry dropped from the fold, txn retained on disk | A deleted file's coverage row should not appear in a residue report forever; the audit trail still shows it existed. |
| Unparseable line | skipped, counted | `parseTxnLine`'s discipline (`reconciliation.ts:110-116`) — a torn tail must not be fatal. |

### 3.3 The admission gate — a state change requires evidence

```typescript
// src/harness/evidence-ledger/transition.ts — PROPOSED, UNVERIFIED SKETCH

export type TransitionRefusal =
	| "verifier_not_trusted"          // a measured/proved claim from an untrusted verifier
	| "missing_required_dimension"    // a dimension the (kind, strength) pair requires is absent
	| "missing_invalidation_trigger"  // measured/proved/searched with invalidatedBy: []
	| "invalidation_input_unhashed"   // a named invalidatedBy dimension is absent from hashes
	| "stale_on_arrival";             // a named dimension already disagrees with current state

export type Admission =
	| { admitted: true; txn: EvidenceTxn }
	| { admitted: false; refusal: TransitionRefusal; detail: string };

/** Declared ONCE per (kind, strength) pair — edge-defined-once. A new subject
 *  kind that forgets to declare its `proved` requirements fails at the type
 *  level (the table is a total Record over the kind × strength product), not at
 *  the first attempted claim. */
export function requiredDimensions(
	kind: EvidenceSubjectKind,
	strength: ClaimStrength,
): readonly InvalidationInput[];

export function admitAssertion(
	record: EvidenceRecord,
	currentHashes: SubjectHashes,       // read from the REAL subject at admission time
	trustedVerifiers: ReadonlySet<string>,
): Admission;
```

Indicative `requiredDimensions` table (the full one is a total
`Record<EvidenceSubjectKind, Record<ClaimStrength, readonly InvalidationInput[]>>`):

| kind | `measured` | `proved` | `searched` | `attested` | `exempted` |
|---|---|---|---|---|---|
| `mutant` | `sourceHash`, `testsHash`, `engineHash`, `environmentHash` | `sourceHash`, `engineHash`, `contractHash` | `sourceHash`, `engineHash` | `contractHash` | — |
| `check` | `sourceHash` (detector file), `testsHash` | *(n/a — no proof mechanism)* | — | — | — (baseline membership is itself the evidence) |
| `file_coverage` | `sourceHash`, `testsHash`, `environmentHash` | *(n/a)* | — | — | — |
| `spec_finding` | `sourceHash` (anchor span) | *(n/a)* | — | `contractHash` | — |

The five refusals, in evaluation order:

1. **`verifier_not_trusted`** — a `measured` or `proved` claim whose
   `verifier.name` is outside `trustedVerifiers`. The trusted set contains
   **only deterministic tool names** (`stryker`, `tsc`, `vitest`, a named
   solver) and **never an LLM or agent identity**. This makes "harness checks
   are deterministic-only" a compile-and-run constraint rather than a prose
   convention, and it reuses the axis `PROVEN_TOOL_CHECKS`
   (`src/harness/quality-checks/instructions.ts:28`) already draws for the
   `[proven]`/`[heuristic]` tag rather than inventing a second policy to keep in
   sync. An LLM-authored claim is admissible only as `searched` or with an
   `attested` approval artifact.
2. **`missing_required_dimension`** — every dimension `requiredDimensions`
   names must be a non-empty string in `record.hashes`.
3. **`missing_invalidation_trigger`** — a `measured`/`proved`/`searched` record
   with `invalidatedBy: []` is refused. An unfalsifiable claim is not evidence.
   `attested` and `exempted` may be empty: their trigger is policy or expiry,
   not a content hash — mirroring `accepted_risk`'s `expiresAt`
   (`disposition.ts:127`).
4. **`invalidation_input_unhashed`** — a dimension named in `invalidatedBy` that
   is absent from `hashes` would silently never fire. Refused.
5. **`stale_on_arrival`** — for every dimension in `invalidatedBy`,
   `record.hashes[d]` must equal `currentHashes[d]`. This is `certificateHolds`
   (`disposition.ts:160-166`) generalized past mutants, applied at write time so
   evidence about a state that has already moved is never admitted.

### 3.4 Module layout, and the invalidation sweep (Round 6)

```
src/harness/evidence-ledger/
  types.ts            # §3.1 — envelope + claim vocabulary
  state-machine.ts    # §3.2 — EvidenceTxn union, applyEvidenceTxn, replayEvidence
  transition.ts       # §3.3 — requiredDimensions, admitAssertion
  store.ts            # JSONL append/load — reconciliation.ts's exact shape
  sweep.ts            # M1 — sweepStaleEvidence (Round 6)
  residue.ts          # M4 — group by kind × state × age, honest denominators
  stop-nudge.ts       # M3 — session-scoped Stop advisory (string | null)
  adapters/
    mutation.ts        # M0 — mutation-manifest.json
    check-evidence.ts  # M2 — check-evidence sweep + baseline
    coverage.ts        # M2 — coverage-baseline.json
src/commands/evidence.ts     # M1 — handlers
src/registrars/evidence.ts   # M1 — registerEvidenceCommands(program)
```

Every file is small and single-responsibility, in the range this repo's
comparable families already occupy (`disposition.ts` 447, `reconciliation.ts`
144, `check-evidence/baseline.ts` well under 100); none is expected to approach
the 500-line cap (`DEFAULT_MAX_LINES`).

`store.ts` copies `reconciliation.ts` operationally: `evidenceLedgerPath`
(mirrors `reconciliationPath`, `:29-31`), torn-tail-safe append (mirrors
`tornTailPrefix`, `:36-44`), parse-tolerant fold (mirrors `parseTxnLine`,
`:110-116`). Path: `.interlinked/evidence/ledger.jsonl`.

**The adapter interface is the whole federation strategy.** One interface, one
implementation per existing ledger, all read-only:

```typescript
// src/harness/evidence-ledger/adapters/types.ts — PROPOSED, UNVERIFIED SKETCH
export interface EvidenceAdapter {
	readonly kind: EvidenceSubjectKind;
	/** Recompute the subject's CURRENT hashes from live state. Returns null when
	 *  the subject no longer exists — which is a `retire`, not a staleness. */
	currentHashes(subjectId: string, cwd: string): SubjectHashes | null;
	/** Optional: project the owning ledger's existing rows as records, so a
	 *  subsystem gets ledger coverage with zero writer changes. */
	project?(cwd: string): EvidenceRecord[];
}
```

**`sweepStaleEvidence` (the Round 6 pass)** — for each entry in the folded
state: ask the owning adapter for `currentHashes(subjectId)`; if `null`, emit a
`retire`; otherwise, for each dimension in `restingOn.invalidatedBy`, compare
`restingOn.hashes[d]` against `currentHashes[d]`; on the first mismatch emit an
`invalidate` txn carrying `{dimension, was, now}`. The txn is appended — the
ledger records *why* a claim went stale, not merely that it did. A stale entry
is **reported, never dropped or relabeled**: the synthesis is explicit that "a
timeout is not equivalence and must not disappear from the denominator/report"
(Part 6, Round 3), and the identical discipline governs Round 6's certificate
revalidation.

The sweep is a **CLI / nightly-cadence** operation, never a hook-path one. It
re-reads the 37 MB manifest and can re-run a full check-evidence sweep; per
`CLAUDE.md`'s "Never full-read `collection.jsonl`…", every adapter read is
bounded and the sweep is opt-in.

### 3.5 CLI surface

```
interlinked evidence status [--json]                      # counts by kind × state
interlinked evidence show <kind> <subjectId> [--json]     # full txn history + resting claim
interlinked evidence sweep [--kind <k>] [--json]          # Round 6 invalidation pass
interlinked evidence residue [--kind <k>] [--json]        # M4: stale/searched/exempted by age
```

`src/registrars/evidence.ts` exports
`registerEvidenceCommands(program: Command): void`, imported and called from
`src/index.ts` exactly as `registerCapsCommands` is today (`src/index.ts:26`,
`:92`). All four subcommands follow the repo's `getOutputMode(opts)` / `output(...)`
convention. No existing command changes.

### 3.6 Hook phases

**No new PreToolUse or PostToolUse gate at M0–M4. This is a decision, not an
omission.**

A record's purpose is to admit uncertain states — `searched`, `exempted`,
`stale` — that are explicitly *not* pass/fail. Gating a Write/Edit on ledger
state would have to clear the same ~zero-FP bar every `pre_block` check clears,
and nothing here has been corpus-calibrated as a gate input. §8 decision 4 names
a future gate as a possible milestone; this memo does not pre-clear its bar.

| Phase | This design | Rationale |
|---|---|---|
| PreToolUse | **nothing** | No zero-FP evidence; a ledger whose whole job is honest uncertainty is the wrong pre-disk gate input. |
| PostToolUse | **nothing at M0–M4** | The M0 write-through happens inside `recordDisposition`, a CLI/library path, not a hook. |
| Stop | **one advisory (M3)**, `string | null`, session-scoped | Joins the existing dispatcher at `lifecycle-events.ts:440-458`; reports only records **this session** asserted whose subjects already moved. A full-repo sweep does not belong on a synchronous Stop path. |
| CLI / nightly | `evidence sweep`, `evidence residue` | Where the expensive re-derivation belongs, per the synthesis's cadence table (Part 7). |

## 4. Integration points

**Registrars.** One new file, `src/registrars/evidence.ts`, wired into
`src/index.ts` next to the other 18 registrar calls (§2.4). No existing
registrar is edited.

**Check registry — deliberately not touched.** This substrate is a library plus
a CLI, not a `CHECK_REGISTRY` detector: it has no
`(content, filePath) => InlineMatch[]` signature, fires on nothing, and is not
subject to `check-registry/entries-*.ts` or the phase contract. Stated
explicitly because `CLAUDE.md`'s check-addition checklist is the obvious
template to reach for, and it does not apply here.

**`.interlinked/` files.** Exactly one new path,
`.interlinked/evidence/ledger.jsonl`, gitignored by the existing blanket rule
with **no `.gitignore` edit** (§2.4). No existing `.interlinked/*` file changes
shape. The M0 write-through adds one appended line per `recordDisposition` call;
the manifest write that call already performs is unchanged.

**Baseline-integrity implications: none at M0–M4.** The ledger is regenerable
local telemetry (the `activity.jsonl` / `reconciliation.jsonl` class), not a
committed water-line. `baseline_integrity_gate` protects committed ratchet
inputs an agent could loosen; `baselineKind`
(`src/harness/evaluator/baseline-integrity-gate.ts:61-66`) resolves exactly nine
filenames via `BASELINE_RE` (`:44-45`), and `evidence/ledger.jsonl` is not among
them and must not be added — nothing here is read as a pass/fail threshold.
**If** a later milestone adds a committed ceiling over ledger contents (e.g.
"the count of `stale` + `searched` records may only shrink", shaped like
`untested-files-baseline.json`'s exemption list), that new file needs one more
row in `baseline-integrity-gate.md`'s direction table and one more `KIND_MAP`
entry — retargeting existing machinery, not new machinery. This memo does not
build that ratchet (§8 decision 4).

### 4.1 Federation, not migration

Per the brief: **no existing ledger's on-disk schema changes.**

| Adapter | Reads | Writes | Mapping notes |
|---|---|---|---|
| `mutation.ts` | `loadManifest` (`mutation/manifest.ts:196`) → `SymbolRecord.symbolHash` for `currentHashes`; `dispositionOf` (`disposition.ts:438-447`) for projection | **nothing to the manifest** | Only *dispositioned* survivors project — never all 111,890 mutants (§7 risk 5). `proved_equivalent`/`proved_unreachable`/`duplicate` → `proved`; `unresolved` with `evidence` → `searched`; `unresolved` without → *no record* (nothing was claimed); `dead_code` → `measured`; `outside_contract`/`accepted_risk` → `attested`. `dispositionOf`'s `source: "legacy_prose"` → **`searched` at most, never `proved`** — prose is not a mechanism (`disposition.ts:1-35`). |
| `check-evidence.ts` | `sweepEvidence` (`check-evidence/extract.ts:178`) or the committed baseline | nothing | `satisfied && !grandfathered` → `measured`; `grandfathered` → **`exempted`, never `attested`** (§7 risk 3). Note the baseline's `exempt` array is currently `[]` (§2.3), so the `exempted` branch has **zero live instances** and must be proven by fixture, not by dogfood. |
| `coverage.ts` | `CoverageBaseline` (`coverage-ratchet.ts:61-67`) | nothing | `engineHash`/`contractHash` are **left absent** — the source file has no such data, and inventing values would hide the weakest-ledger finding (§1.2) that motivates this work. |

No existing writer (`saveManifest`, the check-evidence sweep, the coverage
ratchet) is required to change. Nothing currently shipped depends on this
substrate; nothing here requires a shipped system to change its storage.

### 4.2 Composition with the dispositions plan (load-bearing)

`18-mutation-disposition-registration.md` §3.2 recommends keeping dispositions
on `MutantRecord.disposition` in the manifest and **explicitly rejects a
sidecar**, because `survivors.ts` already reads `.disposition` off the record it
is folding and a second file is a second way to drift.

**This memo does not reopen that fork, and must not be read as doing so.** The
two artifacts hold different things:

| | `MutantRecord.disposition` (their plan) | `EvidenceRecord` (this plan) |
|---|---|---|
| Holds | the **consumed state** — what the gate and `mutation survivors` read | the **evidence envelope** — who verified, under what hashes, what invalidates it |
| Read by | `survivors.ts`, the per-edit gate | `interlinked evidence *`, residue reporting, sweeps |
| Lifetime | governed by the writer that last rewrote the row | governed by its own `invalidatedBy` dimensions |
| Cardinality | one per mutant | one per **assertion event** |

The ledger never becomes the read path for `survivors.ts`. Their fix keeps the
state; this ledger keeps the *proof of why the state was asserted* — and it
survives the `toRecord` drop (§1.1) because it is append-only and keyed by
subject plus hashes, not by a row a later writer rebuilds. If their carry-forward
fix lands first, this substrate simply has fewer resurrections to explain; if it
lands second, the ledger is the record that says what was lost.

## 5. Milestones

Five milestones. Each is independently landable and independently verifiable.
None depends on a sibling plan landing first.

### M0 — Substrate + the one existing consumer: disposition write-through

**Deliverable.** `types.ts`, `state-machine.ts`, `transition.ts`, `store.ts`,
`adapters/mutation.ts`, plus **one** added call inside
`mutation/accept.ts::recordDisposition` (`:180-186`): after a successful
manifest update, build an `EvidenceRecord` from the disposition, run
`admitAssertion` against the symbol's current `symbolHash`, and append the
resulting txn. A refusal is logged and never blocks the disposition write.

**Why this is the smallest independently-verifiable spike, rather than a
substrate with zero call sites.** A substrate that nothing calls cannot
demonstrate the invariant it exists to enforce, so it cannot be *verified*, only
type-checked. The write-through is a ~5-line addition at a call site that
already exists and is already callable (§2.2), which makes M0 one self-contained
change that proves the whole chain: assert → admit → append → fold → detect
staleness. It is also the composition point the brief names, so the dispositions
plan inherits ledger coverage regardless of landing order.

**Verification.**
- `npm run typecheck` clean; `npx vitest run src/harness/evidence-ledger/` green.
- Unit: each of the five `TransitionRefusal` reasons has one case that triggers
  it and one adjacent case that does not (10 cases).
- Property (`fast-check`, mirroring `__tests__/reservations.test.ts`):
  `replayEvidence(log) === ` the state produced by folding the same txns one at
  a time; and re-appending an identical record (same content-addressed `id`) is
  idempotent in the fold.
- Integration (`mkdtempSync` fixture repo, the pattern
  `mutation-disposition.test.ts` already uses): write a fixture manifest, call
  `recordDisposition` with a `dead_code` disposition, assert **both** the
  existing manifest mutation **and** an admitted ledger record whose
  `subject.subjectId` is the `mutantId` and whose
  `hashes.sourceHash` equals the symbol's `symbolHash`. Then rewrite the
  fixture's `symbolHash` and assert `sweepStaleEvidence` (stubbed adapter is
  fine at M0) reports the record `stale` with `staleReason.dimension ===
  "sourceHash"`.
- Regression: the existing `mutation/accept.test.ts` and
  `src/commands/mutation-disposition.test.ts` suites pass **unchanged**.

### M1 — `evidence` CLI + registrar + the real invalidation sweep

**Deliverable.** `sweep.ts` (`sweepStaleEvidence` over the adapter interface),
`src/commands/evidence.ts`, `src/registrars/evidence.ts`, wired per §3.5. Only
the mutation adapter is registered at this point.

**Verification.** End-to-end in a `mkdtempSync` fixture: seed a manifest, record
a disposition, `interlinked evidence show mutant <id> --json` returns the
resting claim; mutate the fixture's `symbolHash`; `interlinked evidence sweep
--json` reports one `invalidate` with the correct `{dimension, was, now}`;
`evidence status --json` moves that subject from `verified` to `stale`. Plus a
registrar test asserting the four subcommands and their options exist (the
pattern `src/registrars/quality.test.ts` already uses for the mutation tree).

### M2 — Read-only federation adapters: check-evidence + coverage

**Deliverable.** `adapters/check-evidence.ts`, `adapters/coverage.ts` per §4.1.
No writer changes anywhere.

**Verification.** Unit tests against fixture `CheckEvidence[]` /
`CoverageBaseline` objects covering **every branch of the mapping table**:
satisfied → `measured`; grandfathered → `exempted` (**fixture-only** — the
committed baseline's `exempt` array is empty today, §2.3, so a dogfood assertion
would be vacuous); neither → no record; coverage row present/absent; subject
deleted → `currentHashes` returns `null` → `retire`. One bounded dogfood run
asserting the coverage adapter projects exactly `Object.keys(baseline.files).length`
records against this repo's live baseline (1,097 today) and that **every one**
leaves `engineHash` absent — pinning the honesty rule from §4.1 rather than a
number that drifts.

### M3 — Stop-cadence advisory nudge

**Deliverable.** `stop-nudge.ts`, added to `buildStopWarnings`
(`lifecycle-events.ts:440-458`) alongside the four existing producers. Scoped to
records **this session** asserted; never blocks.

**Verification.** Unit test on the formatter directly (pure input → `string |
null`, no daemon), including the null case. One `lifecycle-events.test.ts` case
confirming the dispatcher invokes it and the warning reaches the Stop warning
list, mirroring the existing mocked-producer pattern (`:109`, `:449`).

### M4 — Residue report

**Deliverable.** `residue.ts` + `interlinked evidence residue`: group by kind ×
state × age, with **explicit, separately-shown** denominators for `stale`,
`searched`, and `exempted` — the synthesis's Round 6 "publish a residue ledger
by disposition, age, owner, risk, and next action".

**Verification.** Unit tests on the grouping over fixture ledgers, including the
zero-record case (an honest empty report, not a crash) and the mixed-age case.
One assertion that no bucket is ever folded into another — the report must never
present `searched` inside a `verified` total.

## 6. Evidence obligations

None of these files registers a `CHECK_REGISTRY` detector (§4), so the Check
Evidence Contract's tiered positive/negative case-count obligation does not
apply *by its own scope rule* (§2.3: its resolver is keyed by `detector_fn`
against the check registries). The obligations that do apply, drawn from the
closest in-repo precedents:

- **Labeled positive/negative cases per refusal and per fold rule.** Even though
  the contract's pin cannot see these files, use its convention
  (`describe("— positive (must fire)")` / `it("N3: …")`) so that if a future
  phase widens the contract's scope, the cases are already machine-readable. One
  triggering and one adjacent non-triggering case for each of the five
  `TransitionRefusal` reasons and each of the five fold rules in §3.2.
- **Property tests on the fold**, mirroring `__tests__/reservations.test.ts`'s
  `fast-check` usage: `replay == live`; idempotent re-append; and — the one this
  substrate specifically needs — **monotonic honesty**: no sequence of txns can
  move an entry from `stale` or `disputed` to `verified` without an intervening
  `assert` whose hashes match current state.
- **Bounded dogfood, not a corpus scan.** M2's adapters run against this repo's
  own live `coverage-baseline.json` and `check-evidence-baseline.json` and
  assert *invariants* (§4.1's honesty rules), not counts that drift. A full
  `check-corpus.json`-style adjudicated dogfood is not proposed: that machinery
  exists for check detectors specifically
  (`verification-density-program.md` Phase 2) and this is not one.
- **Adversarial case for the determinism rail.** One test asserting that a
  record with `verifier.name` set to an agent/model identity and
  `strength: "proved"` is refused `verifier_not_trusted`. This is the check that
  the deterministic-only policy is enforced by code and not by comment.
- **Land each milestone through `interlinked verify`.** No new
  `DEFAULT_ADVISORY_SKIPS` entry is anticipated — nothing here is a new inline
  check.

## 7. Risks + anti-goals

1. **A forged verifier name is an inherited risk, not a new one — and this
   design does not claim to close it.** An agent can write a JSONL line claiming
   `verifier.name: "stryker"` without running Stryker, exactly as it can already
   fabricate `[proven]`-tagged text. The backstop is the one
   `certificateHolds` already uses: a forged record's `invalidatedBy` hashes are
   re-checked against **actual current state** at sweep time, so a forgery
   survives only while the subject is untouched. **This substrate is not a
   security trust boundary** — consistent with the standing position that local
   checks are a quality lever and that security-relevant decisions need
   cloud-anchored enforcement. Do not let a `proved` record here stand in for a
   security control.
2. **Anti-goal: the unfalsifiable strong claim.** A record declaring
   `strength: "proved"` with `invalidatedBy: []` would escape revalidation
   forever. Refusals 3 and 4 (§3.3) exist only to close this, and the property
   test in §6 pins it.
3. **Anti-goal: grandfathered debt laundering into approval.** Collapsing
   `exempted` into `attested` would make every future grandfather entry read as
   human-reviewed. They are separate `ClaimStrength` members (§3.1) and the
   check-evidence adapter is specified to never map grandfathering to `attested`
   (§4.1). Note this risk is currently latent, not live: the exempt array is
   empty (§2.3).
4. **Determinism policy enforced structurally.** `trustedVerifiers` must never
   contain an LLM or agent identity. This is the same axis
   `PROVEN_TOOL_CHECKS` (`quality-checks/instructions.ts:28`) already draws;
   applying it to a second envelope rather than inventing a parallel policy is
   deliberate, because two policies that must agree is the drift class this
   repo's own `registry-parity` machinery exists to catch. **If a future Tier 2
   LLM lane wants to record findings here, it records `searched` or `attested`,
   never `measured`/`proved`.**
5. **Scale anti-goal.** The live manifest holds 111,890 mutants (§1.1). This
   design records one entry per **assertion event** — a `recordDisposition`
   call, a sweep run — which is the 698-row scale of the residue ledger, not the
   six-figure scale. A design that recorded one entry per mutant would make the
   ledger larger than the manifest it federates over, and would put a 37 MB-class
   file on a path that must stay cheap.
6. **Goodhart surface: "records asserted" is not a quality metric.** The moment
   any report counts ledger records, writing more records becomes the optimal
   policy. The residue report (M4) is therefore specified to show `stale`,
   `searched`, and `exempted` *separately and never folded into a total*, and no
   milestone here proposes a score. §8 decision 4 keeps the ratchet question
   open precisely because a ratchet over an agent-writable JSONL is the sharpest
   available gaming surface in this design.
7. **N=1 discipline — no registry-wide rework.** No existing check, ratchet, or
   gate is required to rewrite its storage. Federation is opt-in and read-only
   (§4.1). This explicitly does not attempt the registry-wide rework `CLAUDE.md`
   reserves for after second-codebase validation.
8. **FP-bar anti-goal.** No `pre_block` gate is proposed on ledger state (§3.6).
   A future gate would need its own corpus-calibrated FP measurement first, like
   every other `pre_block` check.

## 8. Open decisions for the user

1. **Retention and compaction for `.interlinked/evidence/ledger.jsonl`.** Grow
   unbounded like `activity.jsonl` (which has an `interlinked compact`
   companion), or design compaction into M0? This changes M0's scope if decided
   now. *Recommendation: unbounded at M0 — the append rate is one line per
   disposition/sweep, not per tool call — and revisit at M4 when the residue
   report shows real volume.*
2. **Shared parent directory across the six plans.** Should `evidence-ledger/`,
   the dispositions work, and the test-receipts machinery share one family
   (e.g. `src/harness/verification/`) decided now, or should each plan claim its
   own top-level family and let the integrator reconcile? Deciding now avoids
   directory churn; deciding later avoids a premature abstraction. *This is a
   genuine coordination call across plans, not a technical one.*
3. **Default-on or flagged for M0's write-through.** The append is local, cheap,
   and never blocks — but this repo's convention for new systemic behavior
   (`per_edit_mutation`) is often default-off pending validation. Ship M0
   unconditionally, or behind a config key?
4. **Whether a shrink-only ratchet over ledger contents is ever wanted** (e.g.
   "count of `stale` records may only shrink"), and if so, when. This is the
   §7.6 Goodhart surface and the §4 `baseline_integrity_gate` extension in one
   question. *Recommendation: not before second-codebase data exists* — but it
   is a policy call, and it determines whether M4's residue report is designed
   as a report or as a future gate input.
5. **Does `spec_finding` federate at all, or stay reserved?** The findings
   reconciliation log already has a working, correct state machine
   (`reconciliation.ts`). Projecting it into the ledger buys uniform reporting
   and costs a second representation of the same facts. *Recommendation: leave
   the kind reserved and unimplemented until a report actually needs findings
   and mutants in one table.*

## 9. Effort estimates

Single-session agent-effort equivalents, calibrated against comparable shipped
families (`check-evidence/` Phase 0 shipped types + tiers + case parser +
resolver + sweep + baseline in one tranche; `baseline-integrity-gate.ts` shipped
at ~500 lines with its test suite).

| Milestone | Estimate | Basis |
|---|---|---|
| M0 — substrate + disposition write-through | 1–1.5 days | Four small pure modules + one adapter + a 5-line call-site edit; the property tests and the 10 refusal cases are the bulk of it |
| M1 — CLI + registrar + sweep | 1 day | Registrar follows an existing template closely; `sweepStaleEvidence`'s adapter round-trip is the one genuinely new piece |
| M2 — check-evidence + coverage adapters | 1–1.5 days | Two adapters whose real work is the mapping decisions (§4.1) and resisting the temptation to invent absent fingerprints |
| M3 — Stop nudge | 0.5 day | Small `string \| null` formatter matching four existing producers |
| M4 — residue report | 0.5–1 day | Pure grouping over the fold; the care is in never folding buckets together |
| **Total** | **4–5.5 days** | Consistent with "small, self-contained, independently verifiable units" |

## Depends on / feeds

**Depends on:** nothing blocking.

- M0 needs only `mutation/accept.ts::recordDisposition` to exist and be callable
  — true today (§2.2). It does **not** depend on the dispositions plan
  registering its CLI.
- M2 needs `sweepEvidence` (`check-evidence/extract.ts:178`) and
  `CoverageBaseline` (`coverage-ratchet.ts:61-67`) — both shipped.

**Feeds:**

- **The dispositions plan (`18-mutation-disposition-registration.md`).** Its §0
  already anticipates this: "If the evidence-substrate envelope lands first,
  M1's import should adopt it as the evidence source instead of the
  ledger-derived JSON." Concretely, its M1 migration of the 698-row residue
  classification should assert each row through `admitAssertion` rather than
  writing bare `CounterexampleSearchEvidence` — which forces every migrated row
  to name a verifier and an invalidation input, and makes the "prose is not a
  mechanism" rule mechanical for the import. **Its §3.2 manifest-in-place
  decision is untouched by this plan** (§4.2): the ledger holds the evidence
  envelope, never the consumed state. Its §2.5 carry-forward fix and this
  memo's M0 are complementary — one keeps the state, the other keeps the proof.
- **The test-receipts plan (`19-test-receipt-blinded-review-machine.md`).** It
  consumes the reserved `"test_case"` subject kind (§3.1). Its
  `stabilityEvidence`, `mutationEvidence`, and `coverageEvidence` fields are
  each one `EvidenceRecord` with a distinct verifier and its own
  `invalidatedBy` — which is exactly how a receipt whose `testHash` changed
  becomes stale field-by-field rather than wholesale. Its blinded
  `reviewEvidence` maps to `searched` or `attested`, **never** `measured` or
  `proved` (§3.3 refusal 1), which is the determinism rail applied to a review
  lane. This memo reserves the kind and builds neither its adapter nor its
  writer.
- **The integrator agent.** M0 can land in any order relative to the other five
  plans. Recommended sequencing: land the dispositions plan's M0 (register the
  command, fix carry-forward) and this plan's M0 in either order but in the same
  tranche — together they close both halves of §1.1's "evidence dies twice".
  The test-receipts plan can design against §3.1 concurrently: `EvidenceSubjectKind`
  and `SubjectHashes` grow by adding members, not by restructuring.
