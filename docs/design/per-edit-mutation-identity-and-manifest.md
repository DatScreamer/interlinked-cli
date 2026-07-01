# Per-edit mutation — identity, manifest, and output contracts (build step 2 spec)

**Status:** design proposal, 2026-06-27. The foundational data model for
`per-edit-cloud-mutation-testing.md` **step 2** — the types, schemas, and algorithms
that the runner (step 5), red/green (step 6), and verdict mapping (step 7) are all
written against. Modeled as a **sibling of the coverage index**
(`coverage-index/types.ts`, `incremental-per-edit-coverage-crap-ratchet.md`): same
content-hash validity inputs, same immutable-snapshot-with-`generation`, same
instability/quarantine model.

This is the load-bearing, **prototype-first** dependency: until identity is proven
stable (§6) the gate ships survivor findings as WARN, not BLOCK.

---

## 1. What "identity" is

A mutation engine reports each mutant by **raw location** (`file:line:col`, operator,
original→replacement). Location is **not** an identity: inserting lines above a
mutation shifts its location, so a location-keyed survivor list reports phantom
"new" survivors on edits that never touched the code.

**Identity** is a stable name for a single mutation, derived from *what it is and
where it structurally lives*, not its line number. Three nested identities:

- **Symbol** — the enclosing function / method / form. `symbolId` is anchored to the
  qualified name path (+ arity/overload discriminator), **not** a line. Stable under
  edits elsewhere in the file.
- **Site** — a mutable point within a symbol (e.g. one `>`). `siteId =
  hash(symbolId, mutator, originalLexeme, ordinalWithinSymbol)`.
- **Mutant** — a specific replacement at a site (`>`→`>=` vs `>`→`<`). `mutantId =
  hash(siteId, replacement)`. The survivor diff keys on `mutantId`.

**Why ordinal drift is contained.** `ordinalWithinSymbol` (the *n*-th identical
`(mutator, lexeme)` in source order) only shifts if operators are added/removed in
the symbol — which changes the symbol's content hash (§2), putting it in the
**changed region** where re-evaluation is *expected*. For an **unchanged** symbol
(hash identical) the operator set is identical, so ordinals — and therefore every
`siteId`/`mutantId` — are stable by construction. The residual risk reduces to
`symbolId` anchoring (renames, anonymous functions) + hash normalization, handled by
the quarantine model (§6).

## 2. Derivation algorithm

Input: the engine's per-mutant output (Stryker `{ location, mutatorName,
original/replacement }`; `cargo-mutants` / `mutmut` equivalents) + the file AST.

```
for each mutant M reported in file F:
  sym       = enclosingSymbol(F.ast, M.location)            // function/method/form node
  symbolId  = sha256(F.repoRelPath, qualifiedNamePath(sym), arityDiscriminator(sym))[:16]
              // anon/lambda/top-level fallback: normalized AST path from nearest named ancestor + index
  ordinal   = index of (M.mutatorName, M.originalLexeme) among identical occurrences in sym, source order
  siteId    = sha256(symbolId, M.mutatorName, M.originalLexeme, ordinal)[:16]
  mutantId  = sha256(siteId, M.replacement)[:16]

symbolHash(sym) = sha256(normalize(sourceText(sym)))        // whitespace/comment-insensitive → reformat-stable
```

`normalize` strips comments and collapses insignificant whitespace so reformatting
does not churn the hash. `qualifiedNamePath` / `arityDiscriminator` reuse the AST
walker the cyclomatic gate already parses with (`cyclomatic-ast.ts` / the `typescript`
lib), so no new parser is introduced.

## 3. Changed-region derivation

The changed region is **per-symbol, content-hash-based** (not raw line-diff):

```
changedSymbols(base, overlay, changeSet) =
  { sym in symbols(changeSet.files of overlay) :
        base.symbolHash(sym.symbolId) is absent           // new symbol
     OR base.symbolHash(sym.symbolId) ≠ overlay.symbolHash(sym) }  // body changed
```

Derived from the atomic `ChangeSet` (one unit over the whole `tool_input` — see the
parent doc §7). Symbols whose hash is unchanged are **skipped** for re-mutation
(differential, §5) and are *out of scope* for the survivor diff. Deletes drop a
symbol's records; renames are a delete + add unless `symbolId` survives (§10).

## 4. The `mutation-manifest.json` schema

`.interlinked/mutation-manifest.json` — a sibling of `CoverageIndexManifest`.

```ts
type StableId = string;        // 16-hex-char sha-256 prefix
type MutantStatus = "killed" | "survived" | "timeout" | "uncovered" | "equivalent" | "indeterminate";

interface MutantRecord {
  mutantId: StableId;
  siteId: StableId;
  mutator: string;             // engine operator name (provenance)
  originalLexeme: string;
  replacement: string;
  ordinalWithinSymbol: number;
  status: MutantStatus;
  firstSeen: string;           // ISO — when this identity first appeared
}

interface IdentityInstability {            // mirror of coverage-index `ShardInstability`
  events: Array<{ at: string; kind: "id_churn" | "status_flip" }>;
  consecutiveStableRuns: number;
  quarantined: boolean;                    // quarantined survivors downgrade BLOCK → WARN (§6)
}

interface SymbolRecord {
  symbolId: StableId;
  qualifiedName: string;                   // human-readable provenance, e.g. "PaymentService.charge"
  symbolHash: string;                      // §2 — differential-skip key
  mutants: Record<StableId, MutantRecord>; // keyed by mutantId
  instability: IdentityInstability;
}

interface MutationManifest {               // sibling of `CoverageIndexManifest`
  version: 1;
  generation: number;                      // immutable snapshot; promotion = compare-and-swap on generation
  authoritativeAt: string;                 // ISO of the run that established it
  engine: string;                          // "stryker" | "cargo-mutants" | "mutmut" | …
  engineVersion: string;
  dependencyGraphVersion: string;          // invalidation input, as in the coverage index
  environmentHash: string;                 // toolchain/runtime fingerprint
  sourceRevision?: string;
  files: Record<string, Record<StableId, SymbolRecord>>;   // file → symbolId → record
}
```

`accepted-survivors(manifest)` = every `mutantId` with `status ∈ {survived,
equivalent}` (grandfathered backlog + annotated equivalents). The coarse
`mutation-gate.ts` `{score, killed}` view is **derivable** as a count aggregate over
`files[*][*].mutants` — kept only for the legacy weekly ratchet, never the gate.

## 5. The survivor diff (the invariant, operationalized)

```
overlayMutants = run engine on covered sites of changedSymbols only (differential: unchanged symbols reuse cached status)
newSurvivors   = { m ∈ overlayMutants :
                       m.symbolId ∈ changedSymbols
                     ∧ m.status === "survived"
                     ∧ m.mutantId ∉ accepted-survivors(baseManifest)
                     ∧ ¬ baseManifest.symbol(m.symbolId).instability.quarantined }   // quarantined ⇒ WARN, not BLOCK
uncoveredSites = { covered=false sites ∈ changedSymbols }                              // §5 of parent doc (coverage prefilter)

BLOCK  iff  newSurvivors ≠ ∅  OR  uncoveredSites triggers block (policy: block | coverage-debt)
```

A clean **measured** pass (§8) writes a new `generation`: promote the staged symbol
records (statuses + hashes) via compare-and-swap, exactly as the coverage index
promotes a manifest.

## 6. Identity stability — quarantine + the validation harness

**Runtime quarantine** (mirrors `ShardInstability`). An **`id_churn`** event = for a
symbol whose `symbolHash` is *unchanged* across runs, its `mutantId` set differs
(identity is not behaving as a stable key). On churn: append the event, reset
`consecutiveStableRuns`, set `quarantined = true`. A quarantined symbol's survivors
**downgrade BLOCK → WARN** until `consecutiveStableRuns ≥ N` (config; default 3),
then clear. This makes instability fail safe (warn, never false-block) without
disabling the gate — the same contract the coverage index uses for unstable shards.

**Pre-promotion validation harness** (the prototype-first gate). Before any mutator's
findings are allowed to BLOCK:

```
corpus = function-level edit pairs (repo git history + a synthetic edit generator)
for each (before, after) in corpus:
  for each symbol S unchanged in `after` (normalize(text) equal):
     assert  mutantIds(before, S) === mutantIds(after, S)      // zero churn expected
churnRate = churned_symbols / unchanged_symbols
promote mutator M from WARN→BLOCK only when churnRate(M) < threshold (default 0.1%)
```

Per-mutator promotion means a flaky operator stays advisory while stable ones gate.
This operationalizes the parent doc's "ship survivor findings as WARN before BLOCK."

## 7. Integrity rule (anti-gaming)

`baseline-integrity-gate.ts` protects `mutation-manifest.json` as a **shrink-only
exemption surface in changed regions** (analogous to its `untested-files.files`
rule): within `changedSymbols`, the set of `accepted-survivors` (status `survived` /
`equivalent`) may only **shrink**. An edit-tool write that *adds* an accepted entry
for a changed-region mutant — i.e. silences a new survivor — is **blocked**.
`equivalent` annotations are added only through the reviewed `interlinked mutation`
CLI, never a silent manifest edit. This is the mechanism-level half of the
governance lock; the policy-level half (`allow_agent_override:false`) is in the
parent doc §12.

## 8. Output contracts (imported by steps 5 & 7)

```ts
interface MutationReceipt {                // valid only against the exact measured artifact
  overlayHash: string;                     // hash of the proposed overlay content actually run
  generation: number;                      // manifest snapshot the run was diffed against
  sites: Array<{ mutantId: StableId; symbolId: StableId; status: MutantStatus }>;
  engine: string; engineVersion: string; measuredAt: string;
}

interface MutationObligation {             // case-3 fallback (parent doc §12)
  reason: "cloud_unreachable" | "over_budget" | "partial";
  overlayHash: string;
  changedSymbols: StableId[];              // what still needs measuring at commit time
}

type MutationGateOutcome =
  | { kind: "measured"; decision: "allow" | "block";
      receipt: MutationReceipt; newSurvivors: MutantRecord[]; uncoveredSites: StableId[] }
  | { kind: "unavailable"; reason: string; warning: string; obligation?: MutationObligation };
```

Only `kind:"measured"` may block, refresh the manifest, or emit a receipt.
`measured:"allow"` requires the changed region **fully** conclusive against
`overlayHash` (every changed-region covered site `killed`/`equivalent`); any
`timeout`/unmeasured site ⇒ route to `unavailable` (no receipt) — never a forged
clean pass (parent doc §12).

## 9. What each build step imports from this spec

| Step | Imports |
|---|---|
| **1** coverage wiring | reuses `symbolHash` / content-hash infra shared with `coverage-index/` |
| **2** *(this)* | defines all types, the derivation (§2), the manifest (§4), integrity (§7), validation (§6) |
| **3** ChangeSet / provisioner | `changedSymbols` (§3) consumes the `ChangeSet` |
| **5** runner | derivation (§2), differential re-mutation (§5), `MutantStatus`, manifest read/write |
| **6** red/green / RED-witness | feeds RED-witness + test status into the receipt (§8) |
| **7** verdict mapping | `MutationGateOutcome`, `MutationReceipt`, the survivor diff (§5) |

## 10. Open questions / edge cases

1. **Rename of a symbol** — `symbolId` (name-anchored) changes, so an identical-body
   rename resurfaces its mutants as "new." Options: (a) accept it (a rename is an
   edit; re-evaluating is conservative-correct), or (b) add a body-hash fallback so a
   pure rename matches. Lean: (a) for v1; revisit if rename churn is high.
2. **Anonymous functions / top-level statements** — AST-path anchoring is less stable
   than named symbols; the quarantine model (§6) is the safety net. Measure their
   churn separately in the harness.
3. **Engine mutator-name drift across versions** — `engineVersion` in the manifest
   invalidates identities on upgrade (forces re-measure), as the coverage index does
   with `runnerVersion`.
4. **Hash length collisions** — 16 hex chars (64 bits) within one repo's symbol set
   is ample; widen if a collision is ever observed.

## 11. References

**Shipped:** `src/harness/coverage-index/types.ts` (the manifest / instability
conventions this mirrors), `src/harness/mutation-gate.ts` (the coarse `{score,killed}`
view derivable from §4), `src/harness/evaluator/baseline-integrity-gate.ts` (§7),
`cyclomatic-ast.ts` (the AST walker reused in §2).

**Docs:** `per-edit-cloud-mutation-testing.md` (parent — this is its step-2 spec),
`incremental-per-edit-coverage-crap-ratchet.md` +
`incremental-per-edit-coverage-phase0-spike.md` (the coverage-index design this is a
sibling of), `baseline-integrity-gate.md`, `docs/external-pulse/deintroverter.md`
(the per-form content-hash manifest precedent from clj-mutate).
