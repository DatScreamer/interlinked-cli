# 21. Verification & evidence program — capstone roadmap for plans 18–20

**Status:** integration memo, 2026-08-14. **Nothing built.** No `src/` file was
written or changed for this document. It sequences six sibling design memos
drafted in parallel; it does not restate their designs and it does not overrule
them. Where two memos contradict each other, §7 records the contradiction
rather than picking a winner in prose.

**Scope of what was read.** All six memos in full, plus
[`session-2026-08-11-synthesis.md`](../design/session-2026-08-11-synthesis.md)
Parts 4–7 and 11. Every current-state number in this document was re-measured
against the working tree this session (Appendix A) rather than inherited from a
memo — three of the memos' figures had already moved.

---

## 0. The six memos, and a renumbering that has to happen first

The six were drafted in parallel and collided on numbers: **two `18`s and three
`20`s**. Three of them already carry a note asking the integrator to fix it.

| Current path | Slug used below | Owns |
|---|---|---|
| `18-verification-evidence-ledger.md` | **EVIDENCE** | The evidence envelope, claim vocabulary, admission gate, append-only fold |
| `18-mutation-disposition-registration.md` | **DISPOSITION** | The mutant adjudication surface: register the CLI, make records durable, guard the ledger |
| `19-test-receipt-blinded-review-machine.md` | **RECEIPTS** | Per-test-case evidence rows + blinded independent review of assertions |
| `20-hermeticity-stability-lane.md` | **STABILITY** | Trial matrix, flake classification, quarantine that withdraws evidence value |
| `20-harness-coverage-report.md` | **COVERAGE** | Applicability / executions / skips / suppressions / adjudications per check |
| `20-recurrence-synthesis-loop.md` | **SYNTHESIS** | Recurrence signature → drafted sensor + feedforward guide, human-gated |

**Proposed renumber** (content does not depend on the number; do it in one
commit before any milestone lands, so cross-references settle once):

```
18-verification-evidence-ledger.md          → 18-verification-evidence-ledger.md   (keep)
18-mutation-disposition-registration.md     → 19-mutation-disposition-registration.md
19-test-receipt-blinded-review-machine.md   → 20-test-receipt-blinded-review-machine.md
20-hermeticity-stability-lane.md            → 21-hermeticity-stability-lane.md
20-harness-coverage-report.md               → 22-harness-coverage-report.md
20-recurrence-synthesis-loop.md             → 23-recurrence-synthesis-loop.md
```

EVIDENCE keeps `18` because every other memo already cites it by that number.
This capstone then becomes `24-…`; it is written as `21-…` only because that is
the next free integer today. **Renumber this file too** — or renumber nothing
and leave the collisions, but do not half-do it.

38 milestones across the six. None of them is built.

---

## 1. The one-paragraph reading of the whole program

All six memos are instances of a single claim the synthesis makes in Part 4
principle 7: *every meaningful result should identify the code state,
observation model, verifier, evidence, and invalidation conditions it rests on.*
EVIDENCE declares that envelope once. DISPOSITION applies it to mutants,
RECEIPTS to test cases, COVERAGE to check detectors, STABILITY to test verdicts,
SYNTHESIS to proposals. Two of the six additionally fix live defects found while
writing them: STABILITY found environment-dependent kill assertions already in
the tree, and SYNTHESIS found a signature-derivation divergence that makes
`recurrence list` print keys `recurrence detail` cannot resolve.

That is the sequencing argument in one line: **EVIDENCE sets the shape, two
memos carry independent bug fixes that should not wait for it, and the three
storage-and-gate milestones must be serialized because they all queue behind one
497-line file.**

---

## 2. Dependency graph

### 2.1 Three kinds of dependency, kept apart

The memos use "depends on" loosely. Separating the kinds is what makes the graph
actionable, because only one kind actually blocks.

| Kind | Meaning | Consequence if violated |
|---|---|---|
| **Blocking** | B cannot compile or run until A lands | Must serialize |
| **Shape-binding** | B declares a type A owns; landing out of order costs a mechanical refactor | Decide the shape early, land in any order |
| **Contention** | A and B edit the same file, and that file is near a cap or has a pinned test | Serialize the *edits*, not the milestones |

### 2.2 Blocking dependencies: there are none between memos

Verified against each memo's stated M0 preconditions:

- **EVIDENCE M0** needs only `mutation/accept.ts::recordDisposition` to be
  callable — true today, and it is callable independent of DISPOSITION
  registering its CLI.
- **DISPOSITION M0** needs nothing from any sibling.
- **RECEIPTS M0** is two behavior-preserving extractions
  (`checks/test-legitimacy.ts`, `check-evidence/case-parser.ts`) plus a pure
  function. No sibling state.
- **STABILITY M0** is a new family plus a new registrar. It states "depends on
  nothing" and that survives checking.
- **COVERAGE M0** is read-only over files that exist, plus one additive export
  from `check-inventory.ts`.
- **SYNTHESIS M0** needs `aggregateRecurrences` + `deriveSignature`, both
  shipped.

**So the six M0s are genuinely parallel-safe**, and that is the strongest fact in
this whole analysis. Nothing about the sequencing below is forced by
compilation order; it is forced by schema commitments and by three files.

### 2.3 Shape-binding dependencies — EVIDENCE as the shared envelope

```
                         ┌───────────────────────────┐
                         │  EVIDENCE                 │
                         │  EvidenceRecord           │
                         │  SubjectHashes            │
                         │  ClaimStrength            │
                         │  EvidenceSubjectKind      │
                         │  admitAssertion / fold    │
                         └───────────┬───────────────┘
        kind:"mutant"  ┌─────────────┼──────────────┬─────────────┐ kind:"check"
                       │             │              │             │
                 ┌─────▼─────┐ ┌─────▼──────┐ ┌─────▼──────┐ ┌────▼──────┐
                 │DISPOSITION│ │  RECEIPTS  │ │ STABILITY  │ │ COVERAGE  │
                 │Disposition│ │TestReceipt │ │FlakeSig /  │ │CheckAdjud-│
                 │Record     │ │            │ │StabilityEv │ │ication    │
                 └─────┬─────┘ └─────▲──────┘ └─────┬──────┘ └───────────┘
                       │             │              │
                       │             │ stabilityEvidence (SCHEMA COLLISION §3.1)
                       │             └──────────────┘
                       │
                 ┌─────▼───────────────────────────────┐
                 │ SYNTHESIS — AcceptDecision           │
                 │ requests EvidenceSubjectKind:"proposal"│
                 └──────────────────────────────────────┘
```

Read the arrows as *"declares a type whose canonical home is"*, not as *"cannot
build without"*. Every one of these is a mechanical refactor if landed out of
order — **except** the RECEIPTS↔STABILITY edge, which is a live collision
because both memos declare a type called `StabilityEvidence` with disjoint
fields (§3.1, §7 conflict 3).

Per-memo shape claims on EVIDENCE:

| Memo | Claims | EVIDENCE's own position |
|---|---|---|
| DISPOSITION | `DispositionRecord` provenance fields are an instance of the envelope; embeds it if it lands first | Agrees; §4.2 explicitly does not reopen the storage fork (but see §7 conflict 1) |
| RECEIPTS | `subjectId = testId`, `testsHash = testHash`, `invalidatedBy = ["sourceHash","testsHash"]` | Reserves `"test_case"`, builds neither adapter nor writer |
| STABILITY | `FlakeSignature` → `kind:"test_case"`, `strength:"measured"`, `verifier:"interlinked-stability"` | Not anticipated by EVIDENCE; collides with RECEIPTS on the same kind (§7 conflict 4) |
| COVERAGE | adjudication → `kind:"check"`, `strength:"attested"`, `invalidatedBy:["sourceHash"]` | Reserves `"check"`; COVERAGE keeps its own ledger and exposes a projection |
| SYNTHESIS | `AcceptDecision` → `strength:"attested"`; asks for a 7th kind `"proposal"` | Not present in EVIDENCE's 6-member union; additive |

### 2.4 Consumption dependencies — where behavior actually couples

Four milestones change what downstream systems believe, and three of them
converge on the same two functions in `mutation/manifest.ts`.

| Milestone | Call site | Effect on a mutation verdict |
|---|---|---|
| DISPOSITION M0 | `src/commands/mutation-survivors.ts` wraps the manifest in `withDispositions` | A level-1 disposition removes a survivor from the default work-list |
| STABILITY M5 | `manifest.ts:432` `applyMeasuredRun` gains `unstableTests` | A kill whose covering tests are quarantined folds as `indeterminate` |
| RECEIPTS M6 | `manifest.ts:347` `computeNewSurvivors`, via `evaluate.ts:123` | A kill credited only to a `reward_hack` receipt is re-added to `newSurvivors` |
| RECEIPTS M7 | same | the re-added mutant blocks at the per-edit gate |

**No memo states the composition rule** for a mutant that is simultaneously
quarantine-tainted and reward-hack-disputed, or one that is both dispositioned
`dead_code` and quarantine-tainted (§7 conflict 8). Whoever lands the second of
these three owes that rule.

### 2.5 Contention: the graph that actually forces serialization

This is the part no individual memo could see, because each was written against
the tree alone.

| Shared file | Lines today | Cap | Wants to edit it | Verdict |
|---|---:|---:|---|---|
| `src/harness/evaluator/baseline-integrity-gate.ts` | **497** | 500 | DISPOSITION §4.2 (+kind +`detectDispositionLedger`, ~60 lines), STABILITY §4 (+kind +case), COVERAGE §4.5 (+append-only kind) | **BLOCKED.** Three memos, 3 lines of headroom, no grandfather entry. An extraction must precede all three. None of the three noticed. |
| `src/harness/mutation/survivors.ts` | **503** | 500 | STABILITY M5 (`unqualified: unstable_tests` marker), RECEIPTS M6 (disputed kills change worklist contents) | **ALREADY OVER CAP**, ungrandfathered. Any net-line edit is refused. DISPOSITION is the only memo that noticed and routed around it. |
| `src/harness/mutation/manifest.ts` | **477** | 500 | STABILITY M5 (`unstableTests` param), RECEIPTS M2/M6 (`killedByTests?`, disputed input) | 23 lines for two memos. Tight; sequence and measure. |
| `src/registrars/quality.ts` | **452** | 500 | DISPOSITION M0 (~25 → ~477) and M2 (`dispositions` verb) | DISPOSITION consumes essentially all headroom. Others correctly route elsewhere. |
| `src/harness/mutation/gate.ts` | **455** | 500 | Nobody, by three explicit decisions | Good — all three memos that could have touched it declined |
| `src/harness/evaluator/commit-baseline-gate.ts` | 120 | 500 | DISPOSITION +1 entry, STABILITY +1 entry | Fine |
| `src/index.ts` registrar block | — | — | EVIDENCE, RECEIPTS, STABILITY (3 new registrars) | Textual rebase only |
| `.gitignore` carve-out block (`:172–201`) | — | — | DISPOSITION ×1, COVERAGE ×2, STABILITY ×1, SYNTHESIS ×1 (conditional) | Textual rebase; but the *policy* behind it is contested (§7 conflict 7) |
| `check-inventory.ts` + gen markers | — | — | STABILITY M1 (+1 check), RECEIPTS M3 (+1 check), COVERAGE M0 (id export + pin growth) | Both check-adders move the same generated counts. Regenerate counts **first**, per `reference_docfreshness_count_gate_ordering` |

**The single highest-value pre-work item in this whole program is decomposing
`baseline-integrity-gate.ts`**, because three otherwise-independent milestones
queue behind it and each would discover the block at write time.

---

## 3. Shared-schema reconciliation

Eight overlapping shapes. For each: the canonical owner, and the divergences
that must be resolved rather than merged silently.

### 3.1 `StabilityEvidence` — declared twice, disjointly

| Field set | RECEIPTS §3.1 | STABILITY §3.1 |
|---|---|---|
| — | `boots`, `orderings`, `seeds[]`, `leaksFound`, `failures`, `producer` | `trialIds[]`, `axesCovered[]`, `trialsPerAxis`, `class`, `quarantined`, `leaks[]`, `matrixHash`, `measuredAt` |

Not one field name is shared. STABILITY's "Depends on / feeds" asserts that
RECEIPTS' field is "satisfied member-for-member" — but it is satisfying the
*synthesis's prose* (`:266`), not RECEIPTS' declared interface.

**Canonical owner: STABILITY.** It owns the producer; RECEIPTS owns only an
attach point. Required reconciliation before either lands:

1. STABILITY's type gains `producer: string`. RECEIPTS needs to tell a 2-boot
   `flake_check` sample from a real matrix, and `axesCovered` does not carry the
   producing tool's identity.
2. RECEIPTS deletes its declaration and imports STABILITY's.
3. The `flake_check` adapter (RECEIPTS M2) emits
   `axesCovered: ["repetition"]`, `trialsPerAxis: {repetition: 2}`,
   `class: "unmeasured"`, `producer: "flake_check"` — honestly partial, and
   never rendered as "stable". Both memos already require exactly this posture;
   only the type is in dispute.
4. `quarantined: boolean` is load-bearing for RECEIPTS: it is how a receipt
   fails to discharge a mutation obligation. RECEIPTS' own shape cannot express
   it, which is independent evidence that STABILITY's is the right one.

### 3.2 `ClaimStrength` vs `ReviewClassification` — different axes, one open question

- **EVIDENCE owns `ClaimStrength`** (`measured|proved|searched|attested|exempted`).
- **RECEIPTS owns `ReviewClassification`**
  (`contract|useful_characterization|brittle_characterization|reward_hack`).

These are not competing vocabularies — one grades evidence strength, the other
classifies a test. Keep both. RECEIPTS' own anti-goal says so ("do not merge the
two typed judgments").

The open question is RECEIPTS decision 6: may a model verdict enter the ledger
at all? EVIDENCE refusal 1 bars a non-deterministic verifier from `measured` or
`proved`, and names LLM identities explicitly.

**Recommended resolution: option (b), and it needs one amendment.** A verdict
never becomes an `EvidenceRecord` claim; it enters only as an `EvidenceTxn` of
`kind: "dispute"` against a `measured` mutant kill. That needs no new
`ClaimStrength` member and keeps the determinism rail absolute. **The
amendment:** EVIDENCE's `dispute` txn carries `against: string`, designed for
record-vs-record contradiction; it must be widened to admit a non-record source
(a verdict id), or the mapping does not typecheck. That is a two-line change to
EVIDENCE §3.2 and it belongs in EVIDENCE M0, not discovered at RECEIPTS M6.

### 3.3 Human-approval shape — modelled four times

| Memo | Its shape | Note |
|---|---|---|
| shipped | `HumanApproval` (`disposition.ts:99-103`) | The only one that exists |
| DISPOSITION | M4 `ApprovalResolver` over `artifactRef` kinds (D3) | Strongest — requires an artifact the agent cannot manufacture |
| COVERAGE | `CheckAdjudication.by: string` | Self-rated "**weak, and it must be labelled weak**" |
| SYNTHESIS | `AcceptDecision.approved_by` + refusal ladder | Claims deterrence and visibility, explicitly not a boundary |
| RECEIPTS | `test-receipts dispute` writes "a `HumanApproval`-shaped record" | Defers to the shipped shape |

**Canonical owner: the shipped `HumanApproval` in `disposition.ts`.** Each memo
keeps its own domain row but embeds that shape for the signature portion instead
of minting a bare `by` / `approved_by` / `owner` string. COVERAGE's honesty
about the weakness is the correct posture for all four and should be copied into
the other three, not just tolerated in one.

### 3.4 Invalidation-by-hash — the same predicate five times

Every memo re-derives `certificateHolds` (`disposition.ts:160-166`):

| Memo | Field | Dimensions compared |
|---|---|---|
| EVIDENCE | `SubjectHashes` + `invalidatedBy[]` | every dimension the record names |
| DISPOSITION | `DispositionRecord.symbolHash`, `isLive()` | one (`symbolHash`) |
| COVERAGE | `detector_hash`, `adjudicationHolds()` | one (detector source) |
| STABILITY | `FlakeSignature.testFileHash`, `StabilityEvidence.matrixHash` | one each |
| RECEIPTS | `reviewedTestHash`, plus `sourceHash`/`testHash` | two |

**Canonical owner: EVIDENCE** for the *vocabulary* (`SubjectHashes`,
`InvalidationInput`) and for the *predicate* (one comparison function). The
subject-specific field names stay where they are. Recorded divergence:
DISPOSITION's `isLive` is strictly weaker than EVIDENCE's admission check — one
dimension versus N — and DISPOSITION says so. That is acceptable so long as a
`DispositionRecord` is never reported as satisfying the envelope's
`invalidatedBy` contract.

### 3.5 Append-only JSONL store — five implementations, three different precedents

| Memo | Store | Copies |
|---|---|---|
| EVIDENCE | `evidence/ledger.jsonl` | `spec/reconciliation.ts` — torn-tail prefix (`:36-44`), parse-tolerant fold (`:110-116`) |
| RECEIPTS | `test-receipts.jsonl`, `test-review-verdicts.jsonl` | `coverage-obligation-ledger.ts` — best-effort, never throws |
| COVERAGE | `check-adjudications.jsonl` | `recurrence.ts` storage discipline |
| SYNTHESIS | `proposals/decisions.jsonl` | its own |
| STABILITY | `stability-trials.jsonl` | its own; registers an `interlinked query` source |

**Canonical owner: EVIDENCE's `store.ts`.** It is the only one that specifies
the torn-write discipline explicitly, and a torn tail is the failure this repo
has already had to handle once. Extract it as the shared primitive at EVIDENCE
M0 and have the other four import it. STABILITY's extra move — registering the
file as an `interlinked query` source so it inherits bounded scans — should be
adopted by all five, not just one.

### 3.6 `EvidenceSubjectKind` — one kind, two identity schemes

EVIDENCE declares six members and states that the substrate "never mints
identities: it takes the owning ledger's own scheme". But `"test_case"` now has
**two owning ledgers with two schemes**:

- RECEIPTS: `testId = sha256(file + describe-path + case title)`
- STABILITY: `TestCaseId = "${file}::${fullName}"`

**Resolution required, not deferrable** (a subject key that means two things
breaks the fold's `${kind}:${subjectId}` map). Two options: (a) one canonical
`TestCaseId`, owned by whichever of the two walkers lands first — RECEIPTS M0
already extracts `walkTestCases` from `case-parser.ts`, which makes it the
natural home; or (b) split into `test_case` (RECEIPTS) and `test_stability`
(STABILITY). Option (a) is better: the two ledgers describe the same subject and
should join.

Additive and uncontroversial: SYNTHESIS's request for a 7th member,
`"proposal"`.

### 3.7 Skip / applicability taxonomies — no overlap, verify it stays that way

COVERAGE's `CheckSkipReason` names branches that already ship in
`check-registry/builders.ts:68-72`. STABILITY's `StabilityAxis` names test-run
knobs. No collision today. Worth a note only because both are "unions that must
stay exhaustive over an existing filter chain", and both propose an
exhaustiveness pin. Two pins, two subjects, correct.

### 3.8 The protection mechanism — an unresolved fork, not a schema

See §7 conflict 5. RECEIPTS argues `protected_files` is *strictly stronger* than
`baseline_integrity_gate` for append-only JSONL and declines to extend
`BaselineKind`. COVERAGE proposes extending `BaselineKind` with an append-only
(byte-prefix) kind for exactly that file class. DISPOSITION and STABILITY extend
`BaselineKind` for JSON files, where the direction-diff mechanism does fit.

This is a genuine design fork with a good argument on each side and it must be
settled before three memos ship three mechanisms.

---

## 4. Single sequenced build order

Five phases. Phase 0 is the only one that is not a milestone from any memo, and
it is the one that unblocks everything else.

### Phase 0 — unblockers (nothing downstream is safe without these)

| # | Work | Why it is phase 0 | From |
|---|---|---|---|
| 0a | Fix `src/commands/activity.test.ts:28` — wrap the `process.env.NO_COLOR` assignment in `vi.hoisted`, mirroring `status.test.ts:15-20` | The file is **uncommitted** and carries campaign-added kill assertions that are environment-dependent. Committing as-is lands an env-dependent test that the `CI=1` pre-push gate waves through. Verified live this session. | STABILITY D1 (recommends fix now) |
| 0b | Renumber the six memos; update cross-references | Two `18`s and three `20`s; three memos ask for it | §0 |
| 0c | **Decompose `baseline-integrity-gate.ts`** (497/500) into a dispatcher + per-kind detector modules | Three memos add a kind and each would be refused at the write gate | §2.5 — named by no memo |
| 0d | Settle the six cross-plan decisions in §8 | Each is cheap now and expensive to retrofit; two of them change a milestone's shape | §8 |

Phase 0 is roughly **1.0–1.5 sessions** and is not in any memo's estimate.

### Phase 1 — the six M0s (parallel-safe; schema-setting first)

Order within the phase matters only for 1 and 2; the rest are independent.

| # | Milestone | Rationale for position |
|---|---|---|
| 1 | **EVIDENCE M0** — substrate + disposition write-through | Sets the envelope five memos project onto. Landing it first turns four later refactors into zero. Include the §3.2 `dispute` amendment and the §3.5 shared `store.ts`. |
| 2 | **RECEIPTS M0** — extract `contract-marker.ts` + `walkTestCases`; pure `emit.ts` | Two behavior-preserving extractions; existing tests are the proof. Also fixes §3.6 by making one walker canonical. |
| 3 | **STABILITY M0** — `stability bisect`, env axis | New family, new registrar, zero shared state. Verification 2 is a real bug fix. |
| 4 | **SYNTHESIS M0** — candidates + delete the divergent `signatureOf` copy | Fixes a live correctness bug (`list` prints a key `detail` cannot resolve). Touches only recurrence. |
| 5 | **COVERAGE M0** — offline derivation + `harness coverage` | Read-only. Separates the four quiet-check states for all 384 checks and surfaces `never_executed` / `broken` bugs. |
| 6 | **DISPOSITION M0** — register, sidecar store, two gate detectors | **Must follow 0c.** Its own memo says M0 cannot be cut further; the line cap says otherwise unless 0c lands first. |

After phase 1: every schema is fixed, three real defects are fixed, and no
storage decision has been made twice.

### Phase 2 — storage and gates (serialized on `baseline-integrity-gate.ts`)

Each of these adds a guarded artifact. Serialize them; they touch the same
dispatcher even after 0c.

| # | Milestone | Note |
|---|---|---|
| 7 | **DISPOSITION M1** — migrate the 698-row campaign ledger | **Time-critical.** Its input lives in gitignored `scratch/ledger-analysis/` (verified present today, `disposition-routing.json` among others) and does not travel. The 42 removal candidates are recoverable from the residue ledger's committed table; the 508+ fuzz-evidence rows are not. |
| 8 | **COVERAGE M2** — adjudication verb + ledger + gate | Gives the 236 stalled corpus hits their first verdict path |
| 9 | **STABILITY M4** — quarantine ledger + gate + commit-gate backstop | Includes the orthogonality pin: a quarantine entry must never change `countSkippedTests` |

### Phase 3 — evidence production and attachment

| # | Milestone | Note |
|---|---|---|
| 10 | **STABILITY M1** — `test_env_write_after_import` detector | Regenerate gen-marker counts **before** the registry edit |
| 11 | **STABILITY M2** — matrix runner + classifier | Produces the real `StabilityEvidence` that item 13 consumes |
| 12 | **RECEIPTS M1** — store, PostToolUse emission, tamper protection | Includes the bash-redirect hole, which the memo correctly refuses to defer |
| 13 | **RECEIPTS M2** — attach mutation / coverage / stability | Per-test kill attribution is the genuinely new surface. Consumes 11. |
| 14 | **EVIDENCE M1** — CLI, registrar, real invalidation sweep | |
| 15 | **EVIDENCE M2** — check-evidence + coverage federation adapters | |
| 16 | **COVERAGE M1** — hook-path execution + skip counters | The only hook-path change in COVERAGE; ships opt-in unless the latency log is clean |

### Phase 4 — deep milestones (model-involving, gate-flipping, or blocked)

| # | Milestone | Gate |
|---|---|---|
| 17 | RECEIPTS M3 — two static checks | Count-gate ordering with item 10 |
| 18 | SYNTHESIS M1–M2 — sensor + case + guide scaffolding | |
| 19 | STABILITY M3 — leak detection | Risk-heavy (attribution) |
| 20 | STABILITY M5 — consumption (`indeterminate` fold) | Owes the §2.4 composition rule if it lands before item 23 |
| 21 | DISPOSITION M2 — `mutation dispositions` read verb + `--buckets` | Regenerates residue-ledger §5 from committed records |
| 22 | RECEIPTS M4 — blinded payload + shadow dispatch | First model spend. Adversarial calibration set is most of the cost. |
| 23 | RECEIPTS M5–M6 — CLI, pre-push, `disputedKills` at warn | Owes the §2.4 composition rule if it lands after item 20 |
| 24 | SYNTHESIS M3–M4 — review verbs, refusal ladder, Stop cursor | |
| 25 | EVIDENCE M3–M4 — Stop nudge, residue report | |
| 26 | COVERAGE M3–M4 — suppression counters, portability column | M4 needs foreign-repo fleet time |
| 27 | STABILITY M6 — cadence placement | |
| 28 | DISPOSITION M3 — `duplicate`, self-certified | Corpus-calibrate against 17,014 live survivors, never fixtures |

### Phase 5 — blocked or decision-gated (do not schedule)

| Milestone | Blocked on |
|---|---|
| COVERAGE M5 — recall qualification | `.interlinked/mutation-baseline.json` **does not exist** (verified). Land the `null` path in M0; the join waits. |
| DISPOSITION M4 — `outside_contract` / `accepted_risk` | D3: which artifacts count as human approval |
| DISPOSITION M5 — durable `proved_equivalent` | No certificate issuer exists; touches the hot path; needs a latency measurement, not a correctness test |
| RECEIPTS M7 — gate mode | Requires a measured shadow FP rate from M4 |
| SYNTHESIS M5 — cloud draft lane | Decision 4; the deterministic path is fully usable without it |

---

## 5. Effort roll-up

**Unit caveat first.** EVIDENCE and SYNTHESIS estimate in *days*; DISPOSITION,
RECEIPTS, STABILITY and COVERAGE estimate in *focused agent sessions*. EVIDENCE
defines its day as a "single-session agent-effort equivalent", so the two are
comparable. Everything below is normalized to **sessions** and the mismatch is
noted rather than hidden.

| Memo | Milestones | M0 only | Full program |
|---|---:|---:|---:|
| EVIDENCE | M0–M4 (5) | 1.0–1.5 | 4.0–5.5 |
| DISPOSITION | M0–M5 (6) | 1.0–1.5 | 5.5–7.0 (M0–M2 = 2.0–3.0) |
| RECEIPTS | M0–M7 (8) | 0.5–1.0 | 9.0–11.0 (M0–M3 = 3.5–5.0) |
| STABILITY | M0–M6 (7) | 1.0–1.5 | 6.5–9.0 |
| COVERAGE | M0–M5 (6) | 1.0–1.5 | 6.0–8.0 (M0+M2 = ~3.0) |
| SYNTHESIS | M0–M5 (6) | 0.5 | 3.5–5.0 (4.0–5.5 with M5) |
| **Sum of the six** | **38** | **5.0–7.0** | **34.5–45.5** |

Add the work no memo estimated:

| Item | Estimate | Source |
|---|---:|---|
| Phase 0 (renumber, `activity.test.ts` fix, gate decomposition, decisions) | 1.0–1.5 | this memo, §4 |
| Fixing the bugs COVERAGE M0 surfaces (`never_executed` / `broken` checks) | unknown | COVERAGE §7.8 excludes it explicitly, and calls surfacing them a success condition |
| Cross-memo schema reconciliation (§3) if not done in phase 0 | 0.5–1.0 | this memo |

**Program total: ~36–48 sessions**, excluding the unbounded item.

Useful sub-totals for scoping a commitment:

- **Phase 0 + six M0s: ~6–8.5 sessions.** Locks every schema, fixes three live
  defects (env-dependent kill assertions, recurrence signature drift, and
  whatever COVERAGE M0's first run names), and registers the disposition
  surface. This is the tranche worth committing to.
- **Deterministic half — everything except RECEIPTS M4–M7 and SYNTHESIS M5:**
  ~30–39 sessions. Produces a queryable evidence ledger, a per-test receipt
  ledger, a stability matrix, a harness-coverage report, and an adjudication
  path, with no model spend and no cloud commitment.
- **Model-involving remainder:** ~5.5–7 sessions plus recurring inference cost,
  and it is gated on open decisions in two memos.

---

## 6. First two weeks — concrete numbered work

Ten working sessions. Items 1–4 are unblockers and should not slip; items 5–14
are the six M0s plus the two most time-critical follow-ons. Every item names its
verification, because none of this is verified until it runs.

1. **Renumber the six memos** and fix cross-references (`18-…` ×2, `20-…` ×3).
   Verify: `rg -n '18-mutation-disposition|19-test-receipt|20-hermeticity|20-harness-coverage|20-recurrence'`
   returns only the renamed paths.
2. **Fix `src/commands/activity.test.ts:28`** — move the `NO_COLOR` assignment
   into `vi.hoisted`, matching `src/commands/status.test.ts:15-20`.
   Verify: `npx vitest run src/commands/activity.test.ts` passes with **no**
   ambient `CI` / `NO_COLOR`, and
   `npx vitest run --no-file-parallelism --no-isolate src/commands/status.test.ts src/commands/activity.test.ts`
   passes — trial E from STABILITY §1.2, which currently produces 8 failures.
3. **Answer the six cross-plan decisions in §8.** Write the answers into this
   file. Two of them (D-A dispositions storage, D-C `StabilityEvidence` owner)
   change a milestone's shape, so they cannot be deferred past item 5.
4. **Decompose `src/harness/evaluator/baseline-integrity-gate.ts`** (497/500)
   into a dispatcher plus per-kind detector modules, behavior-preserving.
   Verify: `npx vitest run src/harness/evaluator/baseline-integrity-gate.test.ts`
   green **unmodified**; every new file under the cap; `npm run typecheck` clean.
   This is the item that unblocks three memos.
5. **EVIDENCE M0** — `types.ts`, `state-machine.ts`, `transition.ts`,
   `store.ts`, `adapters/mutation.ts`, plus the write-through inside
   `recordDisposition`. Include two amendments this capstone adds: widen the
   `dispute` txn's `against` to admit a non-record source (§3.2), and export
   `store.ts` as the shared append-only primitive (§3.5).
   Verify: the memo's own list — 10 refusal cases, the `fast-check` replay
   property, the `mkdtempSync` integration round trip, plus
   `mutation/accept.test.ts` and `mutation-disposition.test.ts` green unmodified.
6. **Resolve the `dead_code → measured` mapping before EVIDENCE M0 lands its
   adapter.** As written, EVIDENCE §4.1 maps `dead_code` to `measured`, and
   §3.3 requires `engineHash` + `environmentHash` for `(mutant, measured)` —
   dimensions the manifest does not carry (verified: 738/738 files have
   provenance, **0** carry `engine`; `environmentHash` is the literal
   `"cli-measure"`). Either remap, or land per-file engine provenance first.
   Verify: the M0 integration test asserts an **admitted** record, so this fails
   loudly if unresolved.
7. **RECEIPTS M0** — extract `contract-marker.ts` from
   `checks/test-legitimacy.ts:16-70`; refactor `check-evidence/case-parser.ts`
   onto an exported `walkTestCases`; write pure `emit.ts`.
   Verify: `test-legitimacy.test.ts` **and** `case-parser.test.ts` green
   unmodified — that is the regression proof both extractions changed nothing.
8. **Declare the canonical `TestCaseId` in the same change as item 7** (§3.6).
   One scheme for `EvidenceSubjectKind: "test_case"`, consumed by both RECEIPTS
   and STABILITY. Verify: a unit test asserting the two producers derive an
   identical id for the same case.
9. **STABILITY M0** — `stability bisect --axis env`, the vitest runner adapter,
   the delta-debugging bisector, the registrar.
   Verify: the command reproduces STABILITY §1.2's trial table and minimizes to
   the single variable `NO_COLOR`; after item 2's fix it reports `stable` for all
   33 cases across both env points; the synthetic 8-variable fixture minimizes in
   ≤4 trials.
10. **SYNTHESIS M0** — `triggers.ts`, `evaluateCandidate`,
    `recurrence synthesize --list`; **delete** the divergent `signatureOf` copy
    at `commands/recurrence.ts:150-161` in favor of `deriveSignature`; add
    `outcome_marker` to `KNOWN_KINDS`.
    Verify: a regression test that `list` → `detail` round-trips a
    `tool_failure` signature (reproducibly broken today); boundary cases at
    `min_count` and `min_count - 1`; a live run over the 193k-row log with the
    candidate table pasted into the PR description.
11. **COVERAGE M0** — `getCheckInventoryIds()`, the `sources/` streaming
    readers, `verdict.ts`, `interlinked harness coverage`.
    Verify: `rows.length + unobserved.length === 384`; all eight verdicts covered
    by unit tests over fabricated counters; `window.truncated` honest against the
    53 MB recurrence log; the 19 sweep-only ids show
    `by_surface.sweep.fired > 0` with `post_tool.fired === 0`.
12. **Triage COVERAGE M0's first output before declaring it done.** Read the
    `never_executed` and `broken` lists and fix what they name — these are
    harness bugs that currently look identical to clean checks. If the first run
    reports zero bugs across 384 checks, treat that as suspect and hand-verify
    three checks before believing it. **Not estimated by any memo; budget for it.**
13. **DISPOSITION M0** — `disposition-store.ts`, repoint
    `mutation-disposition.ts`'s write to the sidecar, wrap
    `mutation-survivors.ts` in `withDispositions`, register the command, re-pin
    the registrar test at seven names, `.gitignore` carve-out,
    `commit-baseline-gate.ts` entry, `detectDispositionLedger` (into the
    structure item 4 created). **No edit to `survivors.ts`** — it is 503/500 and
    ungrandfathered.
    Verify: the two probes promoted to real tests — the durability regression
    (`applyMeasuredRun` over the same symbol leaves the record applied) and the
    gaming regression (hand-adding a record blocks; removing one allows).
14. **DISPOSITION M1** — migrate the campaign ledger through the store API.
    Do this inside the two weeks, not later: the input is in gitignored
    `scratch/ledger-analysis/` (verified present today) and the 508+ fuzz-evidence
    rows are not recoverable from any committed source.
    Verify: record counts match the bucket table exactly;
    `mutation survivors --json` open-count drops by exactly **42**, not 698;
    the committed ledger diff is reviewable in one PR.

Items 1–4 are roughly two sessions; 5–11 are roughly five; 12–14 are roughly
three. The two weeks end with every schema locked, three live defects fixed, the
disposition surface registered and durable, and 14.5M tokens of adjudication
moved out of a gitignored directory.

---

## 7. Conflicts and unresolved seams

Fourteen. None is smoothed. Each names the memos that disagree and what the
disagreement costs.

### 7.1 EVIDENCE cites a superseded draft of DISPOSITION and settles its open decision by prose

EVIDENCE §4.2 states: *"`18-mutation-disposition-registration.md` §3.2
recommends keeping dispositions on `MutantRecord.disposition` in the manifest and
**explicitly rejects a sidecar**"*, and builds a two-column table on it.

The DISPOSITION memo as it stands recommends **the opposite** — a committed
sidecar ledger at `.interlinked/mutation-dispositions.json` — and opens with
"**Supersedes** the earlier draft at this path wholesale. The material
disagreement is storage (§3.2)". It raises the fork as open decision **D1**
specifically so it is "decided rather than silently resolved by landing order".

EVIDENCE's design survives either answer (the ledger holds the evidence
envelope, not the consumed state). Its *prose* does not. Cost if unfixed: a
reader takes EVIDENCE §4.2 as evidence that D1 is settled, which is exactly the
failure D1 exists to prevent.

### 7.2 Three memos add a `BaselineKind` to a file with three lines of headroom

`src/harness/evaluator/baseline-integrity-gate.ts` is **497 lines** against
`DEFAULT_MAX_LINES = 500`, and is **not** in `.interlinked/large-files-baseline.json`
(both verified). `checkLargeFileLineCountWrite` is a before/after delta, so any
net-line addition is refused at PreToolUse.

- DISPOSITION §4.2 adds a kind, `BASELINE_RE`/`KIND_MAP` entries, and a
  `detectDispositionLedger` case — self-estimated at ~60 lines of detector.
- STABILITY §4 adds `"stability-quarantine"` plus a two-direction case.
- COVERAGE §4.5 adds an append-only kind.

**No memo mentions the constraint.** Each would discover it as a block at write
time. Resolution: decompose first (phase 0c). Cost if unfixed: three separate
sessions each spend their first hour on the same unplanned refactor, or worse,
one of them grandfathers the file to get past the gate.

### 7.3 `StabilityEvidence` is declared twice with zero shared field names

RECEIPTS §3.1 and STABILITY §3.1 both declare it; the field sets are disjoint
(§3.1 above). STABILITY's "Depends on / feeds" claims the two are satisfied
"member-for-member", which is true against the synthesis's prose and false
against RECEIPTS' declared interface. Cost if unfixed: RECEIPTS M2 builds
`attach-stability.ts` against a shape STABILITY M2 does not produce, and the
discovery happens at integration, not design.

### 7.4 Two memos claim `EvidenceSubjectKind: "test_case"` with different identity schemes

RECEIPTS mints `sha256(file + describe-path + case title)`; STABILITY mints
`"${file}::${fullName}"`. EVIDENCE's fold is keyed `${kind}:${subjectId}`, so two
schemes under one kind produce a map where the same test appears twice and
neither entry can invalidate the other. EVIDENCE cannot arbitrate — it declares
that it "never mints identities" and defers to the owning ledger, and there are
now two owning ledgers.

### 7.5 The protection mechanism for agent-writable evidence is answered two incompatible ways

RECEIPTS §3.7 states the case *against* extending `baseline_integrity_gate` for
append-only JSONL — "an append-only JSONL has no numeric direction to protect" —
and argues `protected_files` is "**strictly stronger** here", because there is no
legitimate agent-authored edit at all.

COVERAGE §4.5 proposes precisely the rejected thing: a new `baseline_integrity_gate`
kind whose rule is byte-prefix extension, on the argument that it is
"mechanically checkable".

Both are defensible. Both cite the same gate. DISPOSITION and STABILITY sit in
the middle: their artifacts are JSON, where the direction-diff mechanism does
fit. Unresolved, and it decides how many mechanisms this program ships.

### 7.6 EVIDENCE's M0 cannot admit its own headline record under its own rules

§4.1 maps a `dead_code` disposition to `strength: "measured"`. §3.3's
`requiredDimensions` for `(mutant, measured)` requires `sourceHash`, `testsHash`,
`engineHash`, `environmentHash`. §1.1 measures that **no writer populates
per-file engine identity** — re-verified this session at generation 1325:
738/738 files carry `fileProvenance`, **0** carry `engine`; the manifest-level
`environmentHash` is the literal string `"cli-measure"`.

So M0's write-through — the change that makes M0 "independently verifiable
rather than only type-checked" — would be refused `missing_required_dimension`
on every real record. A second reading of refusal 1 sharpens it: `dead_code` is
an agent's judgment recorded through a CLI, and the trusted-verifier set is
specified to hold "**only deterministic tool names** … **never** an LLM or agent
identity". Either `dead_code` is not `measured`, or the manifest must first
learn to record its engine.

### 7.7 "Reviewed judgments belong in PR diffs" is invoked by three memos and rejected by a fourth

The `.gitignore` carve-out comment on `check-corpus.json` is quoted as
governing precedent by DISPOSITION (§2.1), COVERAGE (§2.8) and STABILITY (§3.6),
each concluding **commit it**.

RECEIPTS §3.7 reaches the opposite conclusion for its verdicts — which cost a
model call and are therefore the most expensive derived state in the program —
on the argument that "the durability answer for expensive derived state in this
repo is content-addressed caching, not a git diff".

SYNTHESIS leaves it open (decision 1). So: five new artifacts, four positions,
one shared rationale being both applied and rejected. Worse, COVERAGE's own open
decision 2 names the counter-argument the other two do not: an append-only
committed JSONL in a multi-agent tree produces merge conflicts, "which is exactly
the friction that left `check-corpus.json` with zero verdicts" — a committed file
with 236 hits and **0** adjudications, verified.

### 7.8 Two memos change what "killed" means at adjacent call sites, with no composition rule

STABILITY M5 folds a kill as `indeterminate` when its covering tests are
quarantined (`manifest.ts:432`). RECEIPTS M6 re-adds a kill to `newSurvivors`
when its only crediting receipt is `reward_hack` (`manifest.ts:347`, via
`evaluate.ts:123`). Neither memo says what happens when both apply, nor what
happens when a mutant is also dispositioned `dead_code` by DISPOSITION.

Both also land optional parameters on `manifest.ts`, which is **477/500 lines**.

### 7.9 Three memos want to change the survivor worklist; `survivors.ts` is already over cap

`src/harness/mutation/survivors.ts` is **503 lines** against a 500 cap and is
**not grandfathered** (both verified). DISPOSITION noticed, and designed
`withDispositions` specifically to need zero edits there. STABILITY M5 wants an
`unqualified: unstable_tests` marker on the worklist; RECEIPTS M6 changes what
the worklist contains. Neither says how it gets past the cap.

### 7.10 The synthesis's recommended ordering is contradicted by two memos' check-adding milestones

Synthesis recommended decision 6 reads: *"Build approved behavior scenarios and
recurrence/harness-coverage reporting **before adding many more detectors**."*
COVERAGE cites this as its backlog position.

STABILITY M1 adds a registry check (`test_env_write_after_import`, default gate)
and RECEIPTS M3 adds another (`test_contract_surface_mismatch`, advisory).
Neither treats COVERAGE M0 as a precondition, and COVERAGE does not claim to be
one. If decision 6 is binding, COVERAGE M0 gates two sibling milestones and
nobody has said so. The sequencing in §4 puts COVERAGE M0 at item 5 and both
check-adders in phase 3, which satisfies decision 6 by accident — it should be
satisfied on purpose or explicitly waived.

### 7.11 Two memos count the same thing and get different answers

EVIDENCE §2.4: "There are 18 registrar calls in `src/index.ts:84-106`."
STABILITY §3.3: "wired in `src/index.ts` alongside the existing 23 registrars".

Verified: **18** `register*Commands(` call sites and **23** `import { register…`
lines. Both numbers are real; the memos counted different things and neither
said which. Trivial in itself, and useful as a signal — six memos independently
measured an overlapping tree, and at least one pair of numbers disagrees.

### 7.12 Every count in every memo is against a moving manifest

DISPOSITION's ledger analysis is anchored to manifest generation **1090**;
EVIDENCE measured generation **1292**; this session measured **1325**, with the
provenance surface split moved from 469 sweep / 269 measure to **501 / 237**.
The mutant total is now 111,890 with 17,014 survived and **0** typed
dispositions.

DISPOSITION §7.5 flags this for its own M1 and mitigates it correctly
(re-resolve `symbolId`/`symbolHash` from the current manifest at write time).
The other five memos quote manifest-derived numbers without that caveat.

### 7.13 Three memos depend on gitignored `scratch/` inputs, and one of those inputs is already gone

- DISPOSITION M1 reads `scratch/ledger-analysis/{disposition-routing,removal-candidates}.json` — **verified present today**.
- COVERAGE §1.2's census script `scratch/harness-coverage-census.mts` is
  described as gitignored, and the memo inlines a reproduction recipe instead —
  the correct response.
- RECEIPTS §2.2 notes that `scratch/evidence-tier-census.mts`, cited by
  `CLAUDE.md` as the way to re-derive the evidence-tier numbers, is **already
  absent from the working tree**.

The third case is what the first will become. It is the concrete argument for
scheduling DISPOSITION M1 inside the first two weeks.

### 7.14 `mutation-baseline.json` is a protected baseline kind with no file

`BASELINE_RE` covers `mutation-baseline`, and `KIND_MAP` maps it to
`"mutation"`. The file **does not exist** in this repo (verified). COVERAGE M5
is honestly blocked on exactly this (`recall.ts:31`) and says so. EVIDENCE and
DISPOSITION both describe the nine protected baselines without noting that at
least one has no local instance. Minor, but it means "nine guarded water-lines"
overstates what is guarded here.

---

## 8. Decisions needed before week 1 ends

Each of these is cross-plan: no single memo can settle it, and each one changes a
milestone's shape if answered late.

| # | Decision | Memos affected | Recommendation |
|---|---|---|---|
| **D-A** | **Dispositions: committed sidecar, or manifest in place?** (DISPOSITION D1) | DISPOSITION M0 shape; EVIDENCE §4.2's prose | **Sidecar.** Its four arguments hold: the manifest is gitignored, a re-measure destroys dispositions today (probe-verified), single-writer ownership, and `survivors.ts` cannot grow. Then correct EVIDENCE §4.2. |
| **D-B** | **One protection mechanism for append-only evidence files, or two?** (§7.5) | RECEIPTS, COVERAGE, DISPOSITION, STABILITY | Pick one. `protected_files` + bash-redirect resolution for JSONL; `baseline_integrity_gate` for JSON with a direction. That splits by data shape rather than by memo, and both mechanisms already exist. |
| **D-C** | **Who owns `StabilityEvidence`?** (§3.1) | RECEIPTS M2, STABILITY M2 | **STABILITY**, plus a `producer` field. RECEIPTS imports it. |
| **D-D** | **One `TestCaseId` or two subject kinds?** (§3.6) | RECEIPTS M0, STABILITY M0, EVIDENCE | One id, derived by RECEIPTS' extracted `walkTestCases`. The two ledgers describe the same subject and should join. |
| **D-E** | **May a model verdict enter the evidence ledger?** (RECEIPTS decision 6) | RECEIPTS M4+, EVIDENCE M0 | **No** — enter as a `dispute` txn only. Requires widening EVIDENCE's `dispute.against` in M0. |
| **D-F** | **Shared parent directory?** (EVIDENCE decision 2) | all six | Decide now. Four new `src/harness/` families are proposed (`evidence-ledger/`, `test-receipts/`, `stability/`, `coverage-report/`) plus `recurrence-synthesis/`. Either group them under one family or keep five top-level ones — but not "decide later", which guarantees churn. |

Each memo additionally carries its own open decisions that do **not** need to be
settled before week 1: DISPOSITION D2–D5, RECEIPTS 1–5, STABILITY 2–6,
COVERAGE 1–5, SYNTHESIS 1–6, EVIDENCE 1, 3–5. They are listed here only so the
integrator does not mistake §8 for the complete decision set.

---

## Appendix A — Facts re-measured this session (2026-08-14)

Every number below was produced against the working tree while writing this
memo, not inherited. Where it disagrees with a memo, the memo is stale.

| Fact | Value | Notes |
|---|---:|---|
| `baseline-integrity-gate.ts` | **497** lines | cap 500; not grandfathered — §7.2 |
| `mutation/survivors.ts` | **503** lines | over cap, not grandfathered — §7.9 |
| `mutation/manifest.ts` | **477** lines | §7.8 |
| `registrars/quality.ts` | **452** lines | DISPOSITION M0 → ~477 |
| `mutation/gate.ts` | **455** lines | untouched by all six, correctly |
| `mutation/disposition.ts` | 447 lines | |
| `commit-baseline-gate.ts` | 120 lines | headroom fine |
| `DEFAULT_MAX_LINES` / baseline `max_lines` | 500 / 500 | in agreement |
| Manifest generation | **1325** | memos cite 1090 and 1292 — §7.12 |
| Manifest files / symbols / mutants | 738 / 7,145 / **111,890** | |
| Survived mutants | **17,014** | |
| Mutants with a typed disposition | **0** | |
| Mutants with `accepted_reason` | **0** | |
| `fileProvenance` entries / with `engine` | 738 / **0** | confirms EVIDENCE Finding 1 — §7.6 |
| Provenance surface split | sweep 501 / measure 237 | was 469 / 269 at gen 1292 |
| `check-evidence-baseline.json` | `enforced: ["cases"]`, `exempt: []` (**0** entries) | `CLAUDE.md`'s "101 grandfathered" is stale, as EVIDENCE §2.3 says |
| `check-corpus.json` | 155 records / 236 hits / **0** adjudications | §7.7 |
| `.interlinked/mutation-baseline.json` | **absent** | §7.14 |
| `BaselineKind` members | 9 | unchanged |
| `register*Commands(` call sites in `src/index.ts` | **18** | §7.11 |
| `import { register…` lines in `src/index.ts` | **23** | §7.11 |
| `src/commands/activity.test.ts` | modified, uncommitted; `:28` sets `process.env.NO_COLOR` at top level after static imports | `status.test.ts:15-20` does the same thing correctly via `vi.hoisted` — §4 item 2 |
| `scratch/ledger-analysis/disposition-routing.json` | **present** | DISPOSITION M1's input still exists — §7.13 |

**Reproduce before trusting.** The manifest and the recurrence log are both live
and growing; three of these numbers moved between the memos being written and
this file being written.
