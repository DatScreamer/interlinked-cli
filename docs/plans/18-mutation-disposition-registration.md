# 18 — Register the mutation-disposition surface

> **Status:** design memo, nothing built. Every current-state claim below carries
> a `file:line` citation or an executed-probe transcript. Two load-bearing
> findings (§1.3, §1.4) were produced by running code this session, not by
> reading it — the probe is `scratch/disposition-durability-probe.mts` and its
> output is pasted verbatim.
>
> **Supersedes** the earlier draft at this path wholesale. The material
> disagreement is storage (§3.2): that draft recommended keeping dispositions on
> `MutantRecord` in the manifest; this memo recommends a committed sidecar
> ledger, on evidence the draft did not weigh (the manifest is gitignored, and
> the repo has already made this exact call twice for analogous data). The fork
> is surfaced as open decision **D1** so the integrator can have it settled
> rather than silently resolved by landing order.

---

## 0. Depends on / feeds

| Relation | Sibling | What crosses the boundary |
|---|---|---|
| **Depends on (soft)** | `18-verification-evidence-ledger.md` — evidence-substrate envelope | `DispositionRecord` (§3.1) carries provenance + invalidation fields that are an *instance* of that envelope. If the envelope lands first, `DispositionRecord` embeds its type instead of declaring `recordedAt` / `recordedBy` / `symbolHash` itself. **M0 must not block on it** — the fields are identical either way, and a later refactor to the shared envelope is mechanical. |
| **Feeds** | `19-test-receipt-blinded-review-machine.md` | An `unresolved` record carrying `CounterexampleSearchEvidence` (`disposition.ts:106-113`) is receipt-shaped: strategy, runs, seed, budget, timestamp. The receipt machine's `propertyEvidence` / `stabilityEvidence` fields and this record's evidence block should share one type rather than two near-duplicates. |
| **Feeds** | `docs/design/mutation-residue-ledger.md` | §5 (four-bucket routing) and §6 (removal-candidate appendix) are today computed by eight throwaway scripts under gitignored `scratch/ledger-analysis/`. After M1 they regenerate from committed records. That is the whole point of M1. |
| **Feeds** | Task #10 (affected-test-selection parser gaps) | The 45 *overclaims* in ledger §5 are **not** dispositions — they are measurement bugs. This memo deliberately refuses to give them a disposition kind (§7.4), which keeps the pressure on task #10 instead of laundering a harness defect into an adjudication. |
| **Sequencing note for the integrator** | — | M0 touches `src/registrars/quality.ts` and `.gitignore`. Both are single-writer contention points across the six memos. M0 is small (~25 lines in the registrar) and should land early to avoid a rebase pileup. |

---

## 1. Problem + evidence

### 1.1 The typed states exist, are correct, and are unreachable

`src/harness/mutation/disposition.ts` (447 lines) defines a discriminated union
of eight members (`disposition.ts:115-128`) with a genuinely careful design: a
`Record<SurvivorDispositionKind, string | null>` refusal table keyed by kind so
that adding a member without deciding its answer fails to compile
(`disposition.ts:175-190`); certificates that carry their own invalidation
inputs (`disposition.ts:76-85`); and `methodProves` (`disposition.ts:139-149`)
refusing a `rewrite_lemma` whose two normalized hashes differ, which is the
difference between a proof and a claim.

`src/commands/mutation-disposition.ts` (183 lines) is its CLI. It builds
`dead_code` and `unresolved` and nothing else (`mutation-disposition.ts:116-123`),
deliberately: "a command an agent can call is not a human approving anything"
(`mutation-disposition.ts:31`). It has a 299-line test file using labeled
P1–P3 / N1–N3 cases (`mutation-disposition.test.ts:12-98`).

**None of it is reachable.** `src/registrars/quality.ts:316-433` registers six
mutation subcommands — `check`, `baseline`, `measure`, `survivors`, `sweep`,
`accept` — and no `disposition`. The pin test at
`src/registrars/quality.test.ts:151-165` asserts exactly that six-name list, so
the omission is currently *enforced*. The only non-test reference to
`mutationDispositionCommand` anywhere in `src/` is its own export line.

Synthesis Part 11 recommendation #3 names this directly: *"Register the honest
`dead_code`/`unresolved` disposition surface, then separately design the trusted
verifier/certificate issuer; do not make prose `accept` the escape hatch."*

### 1.2 The demand is measured, large, and currently stored in gitignored scratch

From `docs/design/mutation-residue-ledger.md` (canonical read, manifest
generation 1090):

| Quantity | Value | Source |
|---|---:|---|
| Total mutants in the manifest | 111,749 | §1 |
| Survived | 17,378 | §1 |
| **Mutants carrying a typed disposition** | **0** | §1 |
| Current survivors on the 29 campaign files | 698 | §4 |
| Deduped equivalence-candidate pool | 581 | §3.2 |
| — confirmed by a sound prover (TCE) | **1** (0.17%) | §3.2 |
| — resting on fuzz-found-no-counterexample | 508 (87.4%) | §3.2 |
| — tagged `exhaustive`, containing zero enumeration language | 72 (0/72 matched) | §3.4 |
| Removal candidates recorded (arguments / mutants) | 31 / 42 | §6 |
| — flagged defense-in-depth-keep, **not** removal | 8 groups / 15 mutants | §6 |
| Campaign token spend | 14,523,000 across 35 agent-runs | §7 |

The 698-survivor routing and the 42 removal candidates exist **only** as JSON
under `scratch/ledger-analysis/`, which is gitignored and does not travel
between machines. ~14.5M tokens of adjudication is one `rm -rf scratch/` from
gone. That is the concrete cost of the missing surface, and it is why M1 is
migration rather than more classification.

### 1.3 VERIFIED: a re-measure destroys every disposition, including accepted equivalences

`manifest.ts:316-327` builds a fresh `MutantRecord` from identity + status +
`firstSeen` and **copies neither `disposition` nor `accepted_reason`**.
`refreshSymbol` calls it for every symbol that has fresh measurements; the only
carry-forward path is its early return, which fires solely when a symbol has
*no* fresh measurements **and** an unchanged hash (the differential-skip path).

Probe output, executed this session (`scratch/disposition-durability-probe.mts`):

```
C1  symbolHash unchanged: true
C1  disposition BEFORE  : {"kind":"dead_code","resolution":"delete"}
C1  disposition AFTER   : undefined
C1  status AFTER        : survived
C1  VERDICT             : DESTROYED by re-measure
C1b differential-skip preserves: true
```

And the same for a full acceptance (`scratch/eqprobe.mts`):

```
status BEFORE=equivalent  AFTER = survived
accepted_reason AFTER     = undefined
disposition AFTER         = undefined
```

Read that second block carefully. **`interlinked mutation accept` — which is
registered and shipping today — writes an acceptance that the next measured run
of that symbol silently reverts.** The symbol hash was *unchanged*; this is not
correct invalidation, it is data loss. The manifest was at generation 1090 with
a sweep actively rewriting it (residue ledger, census-cutoff caveat), so the
half-life of a disposition written into the manifest today is measured in
minutes to hours.

**Consequence for this memo's scope:** registering the command without solving
durability would ship a write path whose writes evaporate. Registration and
storage cannot be separated into different milestones.

### 1.4 VERIFIED: the disposition field is an open gaming surface

`baseline_integrity_gate` already covers `mutation-manifest.json`
(`baseline-integrity-gate.ts:47`, `:56`, `:428`). But `detectMutationManifest`
(`baseline-integrity-gate.ts:378-395`) compares only the *accepted-survivor
set* — mutantIds whose status is `survived` or `equivalent`
(`baseline-integrity-gate.ts:365-376`) — and flags only additions. A hand-added
`disposition` on an existing survivor leaves that set byte-identical.

```
C2  findings for hand-added disposition: 0 []
C2  VERDICT : ALLOWED (gaming surface open)
C2b control (new survivor added) findings: 1
```

The control proves the probe is not vacuous. So an agent can today hand-edit
`.interlinked/mutation-manifest.json`, attach `{"kind":"dead_code",
"resolution":"delete"}` to any survivor, and that survivor **disappears from
`interlinked mutation survivors`** — because `isOpenSurvivor`
(`survivors.ts:223-225`) treats any non-`none` disposition source as judged and
`scanSymbol` filters it out by default (`survivors.ts:275`). Zero blocks, zero
warnings, work-list shrinks. This is the canonical gate-gaming move against the
one surface that reports mutation debt.

### 1.5 Three smaller defects the same investigation surfaced

1. **A bare `unresolved` silences the work-list, contradicting its own spec.**
   `disposition.ts:188-189` states the invariant: *"unresolved is the honest
   resting state for a survivor — recording it must not silence the gate."* But
   `dispositionKindOf` (`survivors.ts:211-215`) returns `"unresolved"` for it,
   `isOpenSurvivor` returns false, and the survivor is filtered out of the
   default work-list. `mutation-disposition.ts:92-94` explicitly permits bare
   `unresolved`. So the cheapest possible CLI call hides a survivor.

2. **Legacy prose is treated as a judgment by the same path.** `dispositionOf`
   (`disposition.ts:438-447`) maps a pre-typed `accepted_reason` to
   `{kind:"unresolved"}` with `source:"legacy_prose"` — correct and careful —
   but `survivors.ts:213` keys only on `source !== "none"`, so prose the type
   system was built to distrust silences the work-list exactly as a typed record
   would.

3. **The conceptual model has ten states; the type has eight.** Synthesis Part 5's
   table lists ten, including *Test gap* and *Observation-model gap*. Neither is
   a member of `SurvivorDisposition` (`disposition.ts:115-128`); both collapse
   into `unresolved`. The residue ledger's bucket 1 (117 mutants, §5) is exactly
   "test/observation gap", and it currently has no way to be recorded as itself.
   §3.1 takes a position on this rather than quietly inheriting the mismatch.

---

## 2. Current state (verified, file:line)

| Component | Path | Lines | State |
|---|---|---:|---|
| Typed union + parsers + certificate validity | `src/harness/mutation/disposition.ts` | 447 | Complete, tested, correct |
| Two-door write split | `src/harness/mutation/accept.ts` | 186 | Complete |
| Non-accepting CLI | `src/commands/mutation-disposition.ts` | 183 | Complete, **unregistered** |
| Registrar | `src/registrars/quality.ts` | 452 | 6 mutation subcommands, no `disposition` (`:316-433`) |
| Registration pin | `src/registrars/quality.test.ts` | — | Asserts the 6-name list (`:151-165`) |
| Read verb | `src/harness/mutation/survivors.ts` | **503** | **Over the 500-line cap, not grandfathered** |
| Read verb (command) | `src/commands/mutation-survivors.ts` | 334 | Has headroom |
| Manifest persistence | `src/harness/mutation/manifest.ts` | 477 | Drops dispositions (`:316-327`) |
| Per-edit gate | `src/harness/mutation/gate.ts` | — | **Reads no dispositions at all** (`rg "disposition" → 0 hits`) |
| Ratchet guard | `src/harness/evaluator/baseline-integrity-gate.ts` | 497 | Manifest covered; disposition field not (`:378-395`) |
| Commit-gate backstop | `src/harness/evaluator/commit-baseline-gate.ts` | — | Covers 3 stageable baselines (`:28-30`) |

### 2.1 Facts that constrain the design

- **`.interlinked/mutation-manifest.json` is gitignored.** `.gitignore:171` is
  `.interlinked/*`; the carve-outs at `:172-201` list nine files and the manifest
  is not among them. `git check-ignore -v` confirms. It is **37,349,673 bytes**.
- **The repo has already made the "reviewed adjudication belongs in git" call
  twice**, in this exact directory, with reasoning that transfers verbatim.
  `.gitignore` on `check-corpus.json`: *"the adjudication verdicts inside it are
  reviewed judgments and belong in PR diffs like any other policy record."* On
  `check-evidence-baseline.json`: *"an added exemption means a check shipped
  without MUST-FIRE / MUST-NOT-FIRE cases — that MUST surface in PR diffs."*
- **`survivors.ts` is 503 lines against a 500 cap and is not in
  `.interlinked/large-files-baseline.json`.** `checkLargeFileLineCountWrite` is a
  before/after delta, so holding or shrinking is allowed but **any edit that adds
  a net line is blocked** — including an added `import`. Any design requiring a
  change to `survivors.ts` must first extract from it. §3.3 avoids this entirely.
- **`registrars/quality.ts` is 452 lines.** A `disposition` block costs ~25
  lines → ~477. Under cap, with ~23 lines of headroom left. Anything larger
  than one subcommand must be extracted.
- **`recordDisposition` (`accept.ts:180-186`) already accepts six of the eight
  kinds.** It rejects only `proved_equivalent` (which must go through
  `acceptMutant`'s certificate check) and is a no-op for an unknown mutant. So
  `duplicate`, `outside_contract`, and `accepted_risk` are *already recordable at
  the library level* — only the CLI's `buildDisposition` withholds them.

---

## 3. Design

### 3.1 Which states are recordable without a verifier

The brief's split, resolved against what the types actually demand:

| Kind | Type demands | Recordable without a verifier? | Ruling |
|---|---|---|---|
| `dead_code` | `resolution`, optional `issueRef` (`disposition.ts:117`) | **Yes** | Already built. The resolution is a source change; recording it must never suppress the per-edit gate (§3.4). |
| `unresolved` | optional `CounterexampleSearchEvidence` (`:128`) | **Yes** | Already built. **Never suppressing** — see §3.3. Bare (evidence-free) records are refused by the store (§3.3), since the absence of a judgment is not a record. |
| `duplicate` | `representativeMutantId` + full `ProofCertificate` (`:120`) | **Yes — the CLI can be its own verifier** | Duplication is a *structural* predicate over content-addressed identities already in the manifest: same `symbolId`, same `siteId`, identical `(mutator, originalLexeme, replacement)`. That is deterministic, zero-LLM, and locally computable, so the CLI may legitimately mint a certificate with `producedBy: "interlinked-duplicate-check"`. It is not a semantic claim about behaviour. Deferred to **M3** only because it needs its own detector + evidence, not because it needs a prover. |
| `accepted_risk` | `owner`, `issue`, `expiresAt`, `HumanApproval` (`:127`) | **Yes, given a *resolvable* artifact ref** | The CLI can accept a ref; it cannot manufacture what the ref points to. Gated on an approval resolver — **M4**, open decision **D3**. |
| `outside_contract` | `contractHash`, `observationModelHash`, `HumanApproval` (`:122-126`) | **Yes, same condition** | Same as above, plus an observation model that does not exist yet. **M4**. |
| `proved_unreachable` | `invariantRef` + `ProofCertificate` (`:119`) | **No** | Needs a certificate issuer. `EQUIVALENCE_REFUSALS` already routes it away from `accept` (`:180-181`). Out of scope. |
| `proved_equivalent` | `ProofMethod` + `ProofCertificate`, both mechanically checked (`:118`, `:139-149`, `:160-166`) | **No, by design** | The escape hatch is meant to be hard to reach. Out of scope. Its **durability** bug (§1.3) is M5. |
| `killed` | — | n/a | Not a judgment; `EQUIVALENCE_REFUSALS.killed` says so (`:176`). |

**On the ten-vs-eight mismatch (§1.5.3): do not add `test_gap` /
`observation_gap` members.** They are the *default* reading of an unadjudicated
survivor, and the residue ledger already derives bucket 1 mechanically (72
untouched + 45 overclaimed, §5). Adding a recordable kind for "the normal state"
creates a Goodhart surface — an agent could mark 17,378 survivors `test_gap` and
call the residue classified. The four routing buckets stay a *derived view*
(§3.5's `mutation dispositions --buckets`), never a stored state. This is the
memo's position; **D4** puts it to the user.

### 3.2 Where records live: a committed sidecar ledger

**Recommendation: `.interlinked/mutation-dispositions.json`, git-tracked via a
`.gitignore` carve-out, as the system of record. The manifest's
`MutantRecord.disposition` field stays, demoted to a hydration cache that
`applyMeasuredRun` is free to destroy.**

Four reasons, in descending weight:

1. **Durability and portability.** The manifest is gitignored (§2.1). Records
   written there do not survive a fresh clone, do not travel between machines
   (MEMORY.md carries a standing warning that nothing travels until commit and
   push), and — per §1.3 — do not even survive the next sweep on the same
   machine. A ledger the measurement pipeline does not own is immune to §1.3 by
   construction, not by a fix that a future refactor of `refreshSymbol` can
   silently undo. The §1.3 bug is proof that this drift already happened once.
2. **Reviewability.** Adjudication is reviewed policy. 698 records at ~300 bytes
   is ~200 KB and diffs legibly; the same records inside a 37 MB
   machine-generated blob are unreviewable and unmergeable. The repo made this
   exact call for `check-corpus.json` and `check-evidence-baseline.json`, in this
   directory, with the reasoning quoted in §2.1.
3. **Single-writer ownership.** The measurement pipeline owns the manifest; the
   disposition CLI owns the ledger. Merging them makes `applyMeasuredRun` a
   permanent co-writer of adjudication data — the coupling that produced §1.3.
4. **The line cap forces a new module anyway.** `survivors.ts` cannot grow
   (§2.1), so "the consumption side already reads one record" is true but
   frozen: any change there requires extraction first. §3.3 shows the sidecar
   join needs **zero** edits to `survivors.ts`, while the in-manifest option
   needs at least the `isOpenSurvivor` fix (§1.5.1) and therefore an extraction.

**Cost, stated honestly:** two files that must agree on invalidation is more
drift surface than one. §3.4's invalidation rule is a single predicate
(`record.symbolHash === manifest symbolHash`) evaluated in one function, pinned
by tests, which is the mitigation. And the hot path is unaffected: the per-edit
gate reads no dispositions at all (§2), so no gate latency is added by M0–M4.

### 3.3 Data shapes

New module `src/harness/mutation/disposition-store.ts` (~180 lines projected).

```ts
import type { SurvivorDisposition } from "./disposition.js";
import type { MutationManifest, StableId } from "./types.js";

/** One adjudication, bound to the exact code state it was made against. */
export interface DispositionRecord {
	/** Canonical manifest key — always via `normalizeManifestKey`. */
	file: string;
	symbolId: StableId;
	mutantId: StableId;
	/**
	 * THE invalidation key: the enclosing symbol's normalized-source hash when
	 * the judgment was made. A record whose hash no longer matches the manifest
	 * is STALE — retained as history, never applied.
	 */
	symbolHash: string;
	/** Denormalized for human review only. Never an identity input. */
	qualifiedName: string;
	mutator: string;
	disposition: SurvivorDisposition;
	/** ISO timestamp. */
	recordedAt: string;
	/** Who wrote it: agent name, session id, or `cli:<command>`. Provenance, not authority. */
	recordedBy: string;
}

export interface DispositionLedger {
	version: 1;
	/** Human-facing policy note, mirroring check-evidence-baseline.json's. */
	note: string;
	/** Fingerprint of the manifest these records were adjudicated against. */
	environmentHash: string;
	dependencyGraphVersion: string;
	/** Sorted by (file, symbolId, mutantId) so the diff is stable. */
	records: DispositionRecord[];
}

/** How much nagging a kind removes. THE gaming-relevant axis — not epistemics. */
export type SuppressionLevel = 0 | 1 | 2;

/**
 * 0 — `unresolved`: records evidence, suppresses nothing. Honours
 *     `disposition.ts:188-189` ("recording must not silence the gate").
 * 1 — `dead_code` / `duplicate` / `accepted_risk` / `outside_contract` /
 *     `proved_unreachable`: removed from the default work-list; status untouched;
 *     the per-edit gate still blocks.
 * 2 — `proved_equivalent`: reaches `status: "equivalent"` and the gate's
 *     accepted floor. Unreachable until a certificate issuer exists.
 */
export function suppressionLevel(d: SurvivorDisposition): SuppressionLevel;

/** Is this record still bound to the manifest's current state? */
export function isLive(record: DispositionRecord, manifest: MutationManifest): boolean;

export function loadLedger(configDir: string): DispositionLedger;
export function saveLedger(configDir: string, ledger: DispositionLedger): void;

/** Refusal text for a record the store will not accept, or null. */
export function refuseRecord(record: DispositionRecord): string | null;

export interface UpsertArgs {
	ledger: DispositionLedger;
	record: DispositionRecord;
}
/** Insert or replace by (file, symbolId, mutantId). Pure. Null on refusal. */
export function upsertRecord(args: UpsertArgs): DispositionLedger | null;

/**
 * A COPY of `manifest` with every LIVE, SUPPRESSING (level >= 1) record's
 * disposition written onto its `MutantRecord`. Level-0 records are deliberately
 * NOT applied, which is what keeps an `unresolved` survivor in the work-list.
 * Pure; the manifest on disk is never rewritten.
 */
export function withDispositions(
	manifest: MutationManifest,
	ledger: DispositionLedger,
): MutationManifest;
```

`refuseRecord` enforces three store-level rules, each of which exists because
§1 found the corresponding hole:

| Rule | Why |
|---|---|
| A bare `unresolved` (no `evidence`) is refused. | The absence of a judgment is not a record. Keeps the ledger proportional to real work and closes §1.5.1 without touching `survivors.ts`. |
| `killed` is refused. | Not a judgment (`disposition.ts:176`). |
| `proved_equivalent` is refused until M5. | It must go through `acceptMutant`'s certificate check (`accept.ts:142-154`), and its status side is not durable yet (§1.3). |

**Why `withDispositions` needs zero edits to `survivors.ts`:** it returns a
manifest-shaped copy, so the existing `dispositionOf` → `dispositionKindOf` →
`isOpenSurvivor` chain (`survivors.ts:210-225`, `:275`) works unchanged. The
caller in `src/commands/mutation-survivors.ts` (334 lines, has headroom) does
`withDispositions(loadManifest(dir), loadLedger(dir))` before `scanSurvivors`.
The 503-line cap on `survivors.ts` is respected without an extraction.

### 3.4 Invalidation contract

One predicate, one place:

> A `DispositionRecord` is **live** iff the manifest's current
> `files[file][symbolId].symbolHash` equals `record.symbolHash`. Otherwise it is
> **stale**.

- A stale record is **retained**, never auto-deleted: it is evidence that a
  symbol changed under an adjudication, which is exactly what a reviewer wants
  to see. `mutation dispositions --stale` reports them; `--prune-stale` removes
  them on explicit human command (removal is always safe under §3.6).
- A record for a `(file, symbolId)` the manifest no longer contains is also
  stale — the symbol was deleted or renamed.
- `proved_equivalent` additionally re-checks `certificateHolds`
  (`disposition.ts:160-166`), which binds `environmentHash` and
  `dependencyGraphVersion` on top of the symbol hash. That is strictly stronger
  and is the reason the ledger carries both fields at the top level.
- **Deliberate asymmetry:** this is a *stricter* invalidation than the manifest
  gives today. §1.3 showed the manifest drops dispositions when the hash is
  *unchanged* (data loss) and would equally keep one when the mutant is
  re-measured `killed`. The ledger inverts both: unchanged hash preserves,
  changed hash invalidates.

### 3.5 CLI surface

**M0 — register the existing command, unchanged.** `buildDisposition` and
`mutationDispositionCommand` already implement precisely this; the only edit to
`mutation-disposition.ts` is repointing the write from `saveManifest` to
`saveLedger` (`mutation-disposition.ts:148-170`).

```ts
mutationCmd
  .command("disposition")
  .description(
    "Record a non-accepting judgment on a surviving mutant: dead_code (delete|implement) or " +
    "unresolved (with counterexample-search evidence). Never touches status, never grants " +
    "equivalence, and never suppresses the per-edit gate — an equivalence claim goes through " +
    "`mutation accept`, which requires a verifier-issued certificate.",
  )
  .requiredOption("--file <path>", "Repo-relative path holding the mutant")
  .requiredOption("--id <mutantId>", "Mutant id from `mutation survivors` or the gate's block message")
  .requiredOption("--kind <kind>", "dead_code | unresolved")
  .option("--resolution <resolution>", "dead_code only: delete | implement")
  .option("--issue <ref>", "dead_code only: an issue/ticket reference")
  .option("--strategy <strategy>", "unresolved only: property | fuzz | differential | bounded_exhaustive | test_suite")
  .option("--runs <n>", "unresolved only: cases the search actually ran (required with --strategy)")
  .option("--seed <seed>", "unresolved only: the search seed")
  .option("--budget-ms <ms>", "unresolved only: the search time budget")
  .option("--cwd <path>", "Project root (default: current directory)")
  .option("--json", "Machine-readable output")
  .action(async (opts: OptionValues) => {
    const { mutationDispositionCommand } = await import("../commands/mutation-disposition.js");
    await mutationDispositionCommand(opts);
  });
```

**M2 — the read verb** (`src/commands/mutation-dispositions.ts`, new):

```
interlinked mutation dispositions                 # summary: counts by kind, live vs stale
interlinked mutation dispositions --file <substr> # per-record view
interlinked mutation dispositions --kind dead_code
interlinked mutation dispositions --stale         # records whose symbolHash moved
interlinked mutation dispositions --buckets       # the four Part-5 routing buckets, DERIVED
interlinked mutation dispositions --prune-stale   # explicit human removal
interlinked mutation dispositions --json
```

`--buckets` is the regeneration path for residue-ledger §5, replacing
`scratch/ledger-analysis/disposition-routing.mjs`.

### 3.6 Hook phases

**None. This surface adds no PreToolUse or PostToolUse check, and no entry to
`CHECK_REGISTRY`.**

That is a deliberate answer to "more checks are a cost, not a win." Dispositions
are cold-path: a CLI write verb and a CLI read verb. The one enforcement point
rides the **existing** `baseline_integrity_gate` PreToolUse block — a new
detector function inside the existing switch (`baseline-integrity-gate.ts:415-434`),
under the existing `rule_id`, with no new rule, no new registry entry, and no
new per-edit latency.

The per-edit mutation gate stays disposition-blind. This is load-bearing, not an
omission: a `dead_code` survivor in a changed region **must still block**,
because the resolution is to delete the code, not to annotate it. If
dispositioning made blocks go away, the optimal agent policy would be to
disposition rather than to fix — the exact Goodhart failure the whole design is
built against. The gate's block message must therefore **not** advertise
`mutation disposition` as an escape (§7.1).

---

## 4. Integration points

### 4.1 `.gitignore`

One carve-out, in the block at `.gitignore:185-201`, following the
`check-corpus.json` precedent verbatim:

```gitignore
# Mutation adjudication ledger — the durable record of WHY a survivor is not
# a defect. Committed policy: the judgments inside it are reviewed decisions
# and belong in PR diffs, and the manifest they annotate is gitignored local
# state that does not survive a fresh clone. Monotonic under
# baseline_integrity_gate: records may be removed or weakened by hand, never
# added or strengthened. Spec: docs/plans/18-mutation-disposition-registration.md
!.interlinked/mutation-dispositions.json
```

### 4.2 Baseline-integrity gate

Add `"mutation-dispositions"` to `BaselineKind`, to `BASELINE_RE` and `KIND_MAP`
(`baseline-integrity-gate.ts:35-57`), and a `detectDispositionLedger` case
(`:415-434`). The monotonic rule, mirroring `detectMutationManifest`'s
"the accepted set may only shrink":

| Hand-edit | Verdict | Rationale |
|---|---|---|
| Record removed | **allow** | Re-opens work. Always safe. |
| `suppressionLevel` lowered (e.g. `dead_code` → `unresolved`) | **allow** | Weakening a claim is safe. |
| Record **added** | **block** | New records enter only via the CLI's internal write. |
| `suppressionLevel` **raised** | **block** | The upgrade move. |
| `symbolHash` changed on an existing record | **block** | Resurrects a stale record — a rebind, not an edit. |
| `certificate` / `approval` sub-object added or altered | **block** | Manufacturing evidence. |

**Watch the direction carefully.** Unlike a numeric water-line, "tightening"
here means *fewer or weaker* records. The block message must say so, or an agent
reading "water-lines only tighten" will guess wrong.

The harness's own writes go through `saveLedger`'s internal `fs` call and never
touch the Write/Edit tools, so they never reach this gate — the same exemption
every other ratchet raise already relies on
(`baseline-integrity-gate.ts:6-11`). `INTERLINKED_DISABLE_BASELINE_GUARD=1`
remains the documented reset bypass.

### 4.3 Commit-gate backstop

`commit-baseline-gate.ts:28-30` lists exactly three git-tracked, stageable
baselines. A committed ledger is a fourth, and it inherits the same
`apply_patch` / sub-agent hole the backstop exists to close. **Add
`.interlinked/mutation-dispositions.json` to that array in M0** — it is a
one-line change and the same `detectBaselineGaming` detector serves both
surfaces.

### 4.4 Registrar and its pin

`src/registrars/quality.ts` (452 → ~477 lines) gains the block in §3.5.
`src/registrars/quality.test.ts:151-165` must move from six names to seven:
`["accept", "baseline", "check", "disposition", "measure", "survivors", "sweep"]`,
with a comment in the existing house style recording why. M2 makes it eight
(`dispositions`). The neighbouring option-pin test (`:221-238`) does not pin
`disposition`'s options today; adding it there is optional and cheap.

### 4.5 Docs and generated counts

No `gen:` marker moves: the ledger adds no guard rule, no quality check, no
structural check, and no registry check. `docs/design/mutation-residue-ledger.md`
gains a pointer that §5/§6 regenerate from records after M1. The
`interlinked-quality-gates` skill gains the new verbs.

### 4.6 What is explicitly NOT touched

`gate.ts`, `evaluate.ts`, `measure.ts`, `manifest.ts`, `survivors.ts`,
`disposition.ts`, `accept.ts`. The whole design is additive except for the
registrar, the two pins, `.gitignore`, the two gate files, and the write-target
line in `mutation-disposition.ts`. That is what makes M0 landable in one pass
and keeps `survivors.ts`'s over-cap state from becoming this memo's problem.

---

## 5. Milestones

### M0 — A registered, durable, guarded surface (with zero records in it)

The smallest slice that is independently landable **and** independently
verifiable **and** not a lie. It cannot be cut further: registering without
storage ships a command whose writes evaporate (§1.3); storing without the guard
ships an agent-writable committed policy file with no ratchet (§1.4); and a
store module with no caller is dead code that trips `dead_exports`.

Scope:
1. New `src/harness/mutation/disposition-store.ts` — §3.3's shapes and functions.
2. `src/commands/mutation-disposition.ts` — repoint the write from
   `loadManifest`/`saveManifest` to `loadLedger`/`upsertRecord`/`saveLedger`
   (`:148-170`). Keep the `findMutantRecord` existence check against the manifest
   — a disposition for a mutant nobody measured is a typo. Resolve `symbolId` +
   `symbolHash` + `qualifiedName` from the manifest at write time; that is the
   invalidation key and the CLI must not accept it from a flag.
3. `src/commands/mutation-survivors.ts` — wrap the manifest in
   `withDispositions` before `scanSurvivors`. **No edit to `survivors.ts`.**
4. `src/registrars/quality.ts` + `quality.test.ts` — register and re-pin.
5. `.gitignore` carve-out; `commit-baseline-gate.ts` array entry.
6. `baseline-integrity-gate.ts` — `detectDispositionLedger` + wiring.

**Verification (all runnable, none assumed):**
- `npm run typecheck`.
- `npx vitest run src/harness/mutation/disposition-store.test.ts src/harness/evaluator/baseline-integrity-gate.test.ts src/registrars/quality.test.ts src/commands/mutation-disposition.test.ts src/commands/mutation-survivors.test.ts`.
- `interlinked mutation disposition --help` prints the surface (the whole point).
- **End-to-end round trip in a temp repo**: measure-seed a fixture file, record a
  `dead_code` disposition, confirm the record appears in
  `.interlinked/mutation-dispositions.json`, confirm the mutant leaves
  `mutation survivors --json` and returns under `--include-dispositioned`.
- **Durability regression, the M0 headline**: re-run `applyMeasuredRun` over the
  same symbol and confirm the record is still applied. This is
  `scratch/disposition-durability-probe.mts` promoted into a real test, and it
  is the assertion that §1.3 cannot silently return.
- **Gaming regression**: hand-edit the ledger to add a `dead_code` record →
  `evaluateBaselineIntegrityForEvent` blocks. Hand-edit to remove one → allows.
  This is the C2 probe promoted into a test.

### M1 — Migrate the campaign ledger into records

Reads `scratch/ledger-analysis/{disposition-routing,removal-candidates}.json`
and writes records **through the store API**, never by hand-editing the JSON
(which M0's guard now blocks — a real test of the design).

Honest scope, from residue-ledger §5/§6:

| Ledger bucket | Count | Becomes | Suppresses? |
|---|---:|---|---|
| 3 — Inert/dead implementation | 42 | `dead_code`, `resolution` per §6 (`delete` for the 27 ordinary-helper mutants; `implement` where the argument says unfinished) | Yes (level 1) |
| — of which defense-in-depth-keep | 15 of the 42 | `dead_code` with the §6 **invalidation trigger** in `issueRef`, or held back pending **D5** | See D5 |
| 2 — Redundant behaviour | 538 | `unresolved` + `CounterexampleSearchEvidence` (`strategy: "fuzz"`, real `runs`/`seed` from the receipts) | **No** (level 0) |
| 1 — Test/observation gap, untouched | 72 | **nothing** — no record. Absence is the correct state. | — |
| 1 — Test/observation gap, overclaimed | 45 | **nothing** — these are measurement bugs, routed to task #10 (§7.4) | — |
| 4 — Policy/uncertainty residue | 1 | Deferred to M4 | — |

**So M1 does not make 698 survivors disappear. It makes 42 actionable and
preserves 508+ searches' worth of evidence.** Any framing stronger than that is
the overclaim this whole design exists to prevent.

**Verification:** record count matches the bucket table exactly;
`mutation survivors --json` open-count drops by exactly 42 (not 698);
`mutation survivors --include-dispositioned` shows all of them; the committed
ledger diff is reviewable in one PR. **Risk:** `scratch/` is gitignored and may
not survive the intervening sessions — see §7.5.

### M2 — `mutation dispositions` read verb + stale reporting

§3.5's read surface, including `--buckets` (regenerating residue-ledger §5
from committed records instead of throwaway scripts) and `--prune-stale`.

**Verification:** unit tests on the pure aggregation; `--buckets` reproduces
§5's four counts against the M1 data; `--stale` correctly flags a record after
its symbol is edited; registrar pin updated to eight names.

### M3 — `duplicate`, self-certified structurally

A detector computing the structural duplicate predicate (§3.1) over the
manifest, minting `producedBy: "interlinked-duplicate-check"` certificates, plus
`--kind duplicate --representative <id>` on the CLI.

**Verification:** P/N cases for the predicate; a dogfood run over the live
manifest reporting how many of the 17,378 survivors are structural duplicates —
which is itself a useful, previously unmeasured number.

### M4 — `outside_contract` / `accepted_risk` behind an approval resolver

Needs an `ApprovalResolver` that can verify an `artifactRef` **exists and is not
agent-writable**. Candidate ref kinds, in descending confidence: a signed git
tag; a commit trailer on a commit the current session did not author; a path
under a protected-file glob; a PR review URL (network — admission-time only,
never on the hook path, per the supply-chain precedent).

**Verification:** each ref kind gets P/N cases including the adversarial case —
an agent writing the artifact itself. **Gated on D3.** Until it lands, these two
kinds stay off the CLI, exactly as `mutation-disposition.ts:29-31` already
decided.

### M5 — Durable `proved_equivalent` (deferred until a certificate issuer exists)

Fixes the §1.3 acceptance-destruction bug by re-deriving `status: "equivalent"`
at read time from a live, `certificateHolds`-passing ledger record instead of
trusting the manifest's status field.

**This is the only milestone that touches the hot path**, because the per-edit
gate reads `acceptedSurvivors()` from status (`manifest.ts:298-307`) and would
need the ledger join. **Its verification must include a latency measurement
against `per_edit_mutation`'s `budget_ms`**, not just correctness tests. Low
urgency: there are currently zero acceptances in the manifest (residue-ledger
§1), because nothing can mint a certificate.

---

## 6. Evidence obligations

The Check Evidence Contract's tier table keys off `CHECK_REGISTRY` entries.
This design adds **none** (§3.6), so the registry sweep in
`check-evidence/contract.test.ts` does not cover it. That is a reason to set the
bar deliberately, not a reason to have none — `detectDispositionLedger` rides a
`pre_block` rail, and house policy is that pre_block demands ~zero FP.

**Self-imposed obligation: `pre_block` tier for the detector (3 MUST-FIRE / 3
MUST-NOT-FIRE, 100% branch, corpus, adversarial), `post`-default tier for
everything else (2/2, 90% branch).** Cases use the existing labeled convention
(`it("P1: …")` / `it("N1: …")`), which `mutation-disposition.test.ts:12-98` and
`baseline-integrity-gate.test.ts` already follow.

| Surface | MUST-FIRE (block) | MUST-NOT-FIRE (allow) |
|---|---|---|
| `detectDispositionLedger` | P1 record added by hand; P2 `suppressionLevel` raised; P3 `symbolHash` rewritten on an existing record; P4 a `certificate` sub-object inserted | N1 record removed; N2 level lowered; N3 whitespace/key-order reformat only; N4 a non-ledger `.interlinked/` file; N5 ledger does not exist yet (creation is not loosening) |
| `refuseRecord` | P1 bare `unresolved`; P2 `killed`; P3 `proved_equivalent` | N1 `unresolved` **with** evidence; N2 `dead_code` with resolution |
| `isLive` | — | P1 matching hash → live; N1 changed hash → stale; N2 symbol absent → stale; N3 file absent → stale |
| `withDispositions` | P1 level-1 record applied; P2 **level-0 `unresolved` NOT applied** (the §1.5.1 invariant); P3 stale record not applied; P4 input manifest not mutated | — |
| **Durability** | P1 `applyMeasuredRun` over the same symbol, then `withDispositions` → record still applied (the §1.3 regression) | — |

**Corpus obligation.** The residue ledger's own §3.4 finding is the cautionary
tale: 72 rows tagged `exhaustive` and **0 of 72** contained enumeration
language — a label calibrated against intent rather than against the tree. So
M3's duplicate predicate must be calibrated against the live 17,378-survivor
manifest before it is trusted, exactly as `halstead_difficulty` had to be
(fixtures said 25; the tree said 80).

**Mutation obligation.** `disposition-store.ts` is a small, pure, branch-dense
module — precisely the shape this repo's own campaign shows is worth mutating.
Measure it with `interlinked mutation measure src/harness/mutation/disposition-store.ts --record`
once M0 lands, and treat surviving mutants as an M0 follow-up rather than an
M0 blocker.

---

## 7. Risks + anti-goals

### 7.1 The Goodhart surface, and the one sentence that must not be written

A disposition is an agent-writable record that removes work from a work-list.
That is the definition of a gaming surface. Three mitigations, all designed in:

- **Suppression is never free.** Level 0 (`unresolved`) suppresses nothing, and
  the store refuses the evidence-free version — so the cheapest possible call
  buys nothing at all.
- **The per-edit gate never yields.** No disposition kind below level 2 changes
  a block. Dispositioning is not an escape from the gate; deleting the code is.
- **The gate's block message must not name `mutation disposition`.** Today it
  ends *"Resolve by strengthening the test, fixing or removing the code, or
  annotating an equivalent mutant"* (`verdict.ts:24`) — deliberately naming no
  command, and the only annotation door that exists (`mutation accept`) refuses
  everything without a certificate. Wiring `disposition` into that sentence would
  teach every future agent that annotating is a way past a block. **Anti-goal,
  stated here so a later "make the error message more helpful" change does not
  quietly introduce it.**

### 7.2 Determinism

Nothing here calls a model. `suppressionLevel`, `isLive`, `refuseRecord`,
`withDispositions`, and `detectDispositionLedger` are pure functions over JSON
and content hashes. The `[proven]`/`[heuristic]` axis does not apply — no
finding is emitted to the agent on the hook path at all.

### 7.3 A quiet ledger is not a failed ledger

If M1 lands 42 records and the ledger then sits still for a month, that is the
correct outcome for a repo whose agent kills mutants rather than annotating
them. Fire rate measures the agent. **Anti-goal: adding a "dispositions
recorded" metric to any dashboard or ratchet.** A number that rewards recording
dispositions is a number that rewards not writing tests, and it would invert the
entire design in one quarter.

### 7.4 Do not give the 45 overclaims a disposition kind

They are mutants a receipt claims killed that the manifest still shows survived
(residue-ledger §5) — a test-selection defect (§4's scope-narrowing note, task
#10), not an adjudication. A kind like `measurement_disputed` would let a
harness bug be closed as a judgment. They stay open survivors until task #10
explains them.

### 7.5 M1's input is gitignored and racing

`scratch/ledger-analysis/*.json` is gitignored, was written against manifest
generation 1090, and a sweep was actively rewriting the manifest throughout
(residue-ledger census-cutoff caveat). Mitigation: M1 re-derives `symbolId` and
`symbolHash` from the **current** manifest at write time, so a record is either
written live or written stale-and-visible — never written against a hash nobody
can check. If `scratch/` is gone by the time M1 runs, the 42 removal candidates
are recoverable from residue-ledger §6's committed table; the 538 fuzz-evidence
records are not, and would have to be re-earned or dropped. **That asymmetry is
an argument for running M1 soon.**

### 7.6 Two files that must agree

The ledger and the manifest can drift: a manifest rebuilt from scratch orphans
every record. Mitigation: orphans are *stale*, not silently dropped, and M2's
`--stale` view makes an orphaned ledger loudly visible rather than quietly
inert. Accepted cost of §3.2's decision.

### 7.7 N=1

The ledger's shapes are calibrated against this repo's mutation manifest only.
Per house N=1 discipline, this memo proposes **no** registry-wide rework, no new
check ids, and no tier recalibration. `.interlinked/mutation-dispositions.json`
is absent-by-default and every consumer must render an honest empty state — a
repo with no mutation runner sees exactly nothing.

---

## 8. Open decisions for the user

**D1 — Sidecar ledger, or fix the manifest in place?** §3.2 recommends the
sidecar on durability, reviewability, single-writer ownership, and line-cap
grounds. The superseded draft at this path recommended the manifest. This is the
one architectural fork, it changes M0's shape, and a sibling memo has already
assumed an answer — it should be decided rather than settled by landing order.

**D2 — Commit the ledger, or keep it local?** The recommendation assumes
committed (carve-out per §4.1), matching `check-corpus.json`. Committed means
adjudications travel and get reviewed; it also means every disposition is a PR
diff line. If you want mutation adjudication kept out of PR review, say so —
it inverts §3.2's second reason and weakens, but does not kill, the sidecar case.

**D3 — Which approval artifacts count as human (M4)?** Signed git tag, commit
trailer, protected-glob path, PR review URL — or none of these, and
`accepted_risk` / `outside_contract` stay permanently unexposed. This is a trust
policy, not an engineering choice, and it is the only place a human signature
enters the mutation pipeline.

**D4 — Keep the type at eight members, or add `test_gap` / `observation_gap`?**
§3.1 argues against: they are the default state of an unadjudicated survivor and
making them recordable creates a 17,378-row Goodhart surface. Accepting this
means the ten-state conceptual model and the eight-member type stay
deliberately different, and the synthesis Part 5 table should say so.

**D5 — How should the 15 defense-in-depth-keep mutants be recorded?** They are
inert *today* but deliberately retained as a second trust boundary
(residue-ledger §6). Calling them `dead_code` misfiles them as removable;
leaving them unrecorded loses the analysis; `outside_contract` is the honest kind
but is gated behind D3. Options: (a) `dead_code` with the invalidation trigger in
`issueRef` and a `resolution: "implement"` reading, (b) hold them out of M1 until
M4, (c) a ninth member — which contradicts D4's reasoning.

---

## 9. Effort estimates

Units are focused agent-sessions on this repo, assuming the house verify /
typecheck / test loop and the ~500-line cap.

| Milestone | Estimate | Dominant cost | Notes |
|---|---:|---|---|
| **M0** | **1.0–1.5 sessions** | The two gate detectors and their pre_block-tier evidence (~60 lines of detector, ~200 lines of test) | The store module is ~180 straightforward lines; the registrar block is ~25. The temp-repo round trip is the slowest single item. |
| **M1** | 0.5–1.0 | Mapping 581 receipt rows onto typed evidence and re-resolving every `symbolId`/`symbolHash` against the live manifest | Pure data work. Doubles as the first real load test of the store. Front-load if `scratch/` durability is a concern (§7.5). |
| **M2** | 0.5 | `--buckets` reproducing residue-ledger §5 exactly | Aggregation over a committed file; no new enforcement. |
| **M3** | 1.0 | Corpus calibration against 17,378 survivors, not the detector | The §3.4 lesson: calibrate on the tree, never on fixtures. |
| **M4** | 1.5–2.0 | The approval resolver and its adversarial cases | Blocked on D3. The estimate is wide because ref kinds differ by an order of magnitude in difficulty. |
| **M5** | 1.0 | Hot-path latency verification, not correctness | Deferred; no certificate issuer exists, so there is nothing to make durable yet. |
| **Total M0–M2 (the item as briefed)** | **2.0–3.0** | — | M3–M5 are follow-ons with their own gates. |

---

## Appendix A — Probe reproduction

Both probes are read-only, write nothing, and live in gitignored `scratch/`:

```bash
npx tsx scratch/disposition-durability-probe.mts   # C1 carry-forward loss, C1b skip path, C2 gaming hole, C2b control
npx tsx scratch/eqprobe.mts                        # accepted equivalence reverted by re-measure
```

Promote both into real tests during M0 (§5, §6) — they are the two regressions
this design most needs pinned.

## Appendix B — Claims deliberately NOT made

- That M1 resolves 698 survivors. It resolves 42 and preserves evidence for 508+ (§5, M1).
- That the 581-mutant candidate pool is equivalent. **1** is machine-confirmed (residue-ledger §3.2); the rest are `unresolved` with search evidence, which is what §3.1 records them as.
- That `exhaustive`-tagged receipts are bounded-domain proofs. 0 of 72 contain enumeration language (residue-ledger §3.4); they migrate as `unresolved`, not as a proof kind.
- That this design has been validated on a second codebase. It has not (§7.7).
