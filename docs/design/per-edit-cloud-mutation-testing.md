# Per-edit, in-session cloud mutation testing

**Status:** SHIPPED except deliberate deferrals, 2026-07-02 — daemon gate live
(`per_edit_mutation`, shipped default-off + `budget_ms` knob; dogfooded
warn-mode in this repo), identity + manifest + receipts persisted on
measured-clean, §6 site-count + §7 red/green + RED-witness wired end-to-end
(the Worker emits `testRun`; the overlay set ships the companion test), cloud
Worker deployed + token-gated + e2e-verified (fixture repo: witness
satisfied/unmet, suite-red short-circuit). Deferred: Artifacts provisioner
(§10 stop-line), Mode-C fan-out, in-Sandbox scoped test selection (big-suite
repos stay honestly not-measured). Probe: `.interlinked/e2e-mutation-gate.mts`.
Original proposal below, unchanged:

**Proposal status was:** design proposal, 2026-06-27 (rev. 5 — **default policy + config**
(`per_edit_mutation`: default-on, capability-aware, agent cannot override; §12).
rev. 4 **availability
model**: hard-on-evidence, fail-open-on-capability — an unmeasured allow never
refreshes the manifest or emits a clean receipt (§9, §12). rev. 3 recast as an **agentic discipline
loop**, not a dashboard metric; coverage-prefilter + uncovered class; site-count
precheck; content-hash manifest + focused rerun; worker isolation. Builds on rev. 2:
obligation-model reversal, survivor-identity invariant, atomic change-set, honest
wire/fallback). Scoped with the user; for agent review. Narrow slice of
`docs/plans/10-mutation-testing.md`.

---

## 1. Scope and stance

The feature: on each agent edit, a **PreToolUse** hook takes the proposed
`tool_input`, runs **red/green + coverage + mutation** against a **warm cloud copy
(or copies)** of the repo, and gates the tool call inside the **~25s budget**.

**Mutation testing here is an agentic *discipline loop*, not a dashboard metric.**
The agent **operates** the loop — it writes the missing test, or removes dead /
over-specific code — but the **oracle is mechanical**: tests, coverage, mutants,
and a clean survivor list. The verdict is never an LLM judgment
(`feedback_harness_deterministic_only`). The loop ends only when the changed region
has **no uncovered mutation site and no survivor** — the mutate4go / clj-mutate
discipline (Uncle Bob: *"Mutants should all be red!"*). This is the agentic port of
his **red → green → mutate → refactor** cycle.

**This is a deliberate reversal of the current obligation model.** Two shipped docs
say mutation does *not* block edits:

- `per-edit-coverage-enforcement.md:23` — *"Mutation: commit-time obligation
  (unchanged — the one that can't fit per-edit)."*
- `harness-system-diagrams.md:108` (§0 of harness-system-diagrams.md, box 7) — *"Mutation (box 7) is a per-plan
  obligation, hard-gated at commit — not a per-edit block."*

This doc **promotes mutation to a per-edit block and demotes the commit gate to the
degraded-path fallback** (§12). Enabling basis: `harness-system-diagrams.md:162`
(*"supersedes the old 'heavy work can never be synchronous' stance … the cloud tier
targets the same ~25s by horizontal fan-out"*) and
`feedback_pretooluse_cloud_synchronous_block`. It answers the two objections at `harness-system-diagrams.md:108`:

1. *"A Pre-block fires no Post, so it couldn't carry the survivor list."* — The
   PreToolUse **block `reason` carries the full survivor list + four-way guidance**
   synchronously (`reason` is shown to the agent — `project_posttooluse_visibility`).
2. *"The fix is cross-file and iterative."* — That iteration **is the loop** (§2).
   We block only on a **new survivor in the just-edited region** (§4), never the
   pre-existing backlog.

| In scope | Out of scope (cut) |
|---|---|
| Per-edit, in-session evaluation as a discipline loop | Whole-repo / overnight **batch** sweeps |
| Per-edit block, default-on, hard-on-evidence within ~25s (§12) | `Workflows` / durable orchestration |
| Source mutation (`#1`) + red/green + RED-witness | Test amplification (`#4`), any **LLM-as-judge** |
| Survivor-identity invariant + uncovered class | `Workers AI` / `AI Gateway` |
| Mechanical verdict (killed/survived/timeout/uncovered/equivalent) | Checked-coverage dynamic slicing (`#2` rigorous) |
| Everything **up to** the Artifacts seam (§10) | The Artifacts provisioner impl (await GA/access) |

## 2. The discipline loop (the thesis)

Realized **across successive PreToolUse calls**, with the mutation manifest (§4) as
cross-call memory. Because the gate is *pre-landing*, the agent refines the
*proposed* ChangeSet until it is clean — **nothing bad ever hits disk** (stronger
than the post-hoc, file-at-a-time loop of mutate4go/clj-mutate).

```
proposed edit → overlay → affected tests GREEN → coverage (fresh) → mutate changed region
      │
      ├─ uncovered site OR new survivor?
      │        → BLOCK. reason = mechanical work-list:
      │            • uncovered sites  (file · symbol · location — "no test executes this")
      │            • survivors        (file · symbol · mutator · original→mutated — "no test kills this")
      │            • four-way guidance: strengthen test · fix source · remove dead/over-specific code · annotate-equivalent
      │        → agent revises the ChangeSet (add test / delete code) and resubmits
      │        → FOCUSED RERUN: re-mutate only previously-failing or content-changed sites (manifest skips clean+unchanged)
      │
      └─ zero uncovered, zero new survivor (FULLY measured) → ALLOW → emit receipt + update manifest
```

The agent is the actor; the harness is the oracle. A survivor's fix is not always
"write a test" — it is frequently **"remove dead or over-specific code"** (a mutant
that can't be killed because the code is unreachable or the spec over-fits). The
loop surfaces that; the agent decides; the oracle re-checks.

## 3. Goals & non-goals

**Goals**
- The changed region reaches **zero uncovered sites and zero new survivors** before
  the edit lands; the block always carries the full mechanical work-list.
- `allow` ⟺ affected tests green **and** RED-witness satisfied **and** no uncovered
  site **and** no new changed-region survivor (§4–5).
- **Default-on; hard-on-evidence, fail-open-on-capability:** mutation is *authoritative when
  measured* — any red test, invalid RED-witness, uncovered changed-region site, or
  surviving changed-region mutant **blocks**. When mutation cannot be measured
  (local-only, or cloud cold/unreachable/timed-out) the hook **allows to preserve
  tool continuity but does not claim approval**: it surfaces `[mutation:not-measured]`
  and refreshes neither the manifest nor a clean receipt (§9, §12). Unavailability is
  an *unmeasured allow*, not a lowered bar. (Absolutely-hard = fail-closed = opt-in
  only, §13.)
- **Small scope is enforced, not assumed:** a patch with too many mutation sites is
  rejected/split *before* mutation (§6), never pushed into a giant obligation.

**Non-goals**
- Not the commit gate (it stays, as the fallback — §12).
- Not a mutation *generator* — **wrap a mature engine** (Stryker / `cargo-mutants`
  / `mutmut`), per `feedback_coverage_100_is_the_north_star`.
- Not an LLM judge — the agent operates; the verdict is the mechanical 5-state
  status set (§9). `feedback_local_checks_not_a_trust_boundary`.

## 4. The invariant + the mutation manifest

The property is **"no new changed-region survivor,"** not "the file's mutation score
did not regress." Score (`killed/(killed+survived)`) can hold or rise while a *new*
survivor appears. `mutation-gate.ts` cannot express this — `MutationBaseline.files`
is `Record<path,{score,killed}>`, pure counts, **no per-mutant identity**. So this
is **new data, not reuse** (the score ratchet survives only as a derived coarse view).

**Stable site identity** — must survive unrelated edits elsewhere (else editing line
10 forges a phantom survivor at line 200). Engines emit `line:col`; we re-anchor:

```
siteId = hash(repoRelPath, enclosingSymbolId, mutatorName, originalLexeme, ordinalWithinSymbol)
```

anchored to the **enclosing symbol**, not raw location. This re-anchoring is a **new
normalization layer over engine output** and the load-bearing, validation-pending
piece (does identity hold across real refactors? — prototype first).

**Mutation manifest** — `.interlinked/mutation-manifest.json`, modeled on the
mutate4go / clj-mutate **footer manifest** (timestamps + per-function/form hashes).
Per site: `{ siteId, file, symbol, mutator, contentHash, status, first_seen }`,
`status ∈ {killed, survived, timeout, uncovered, equivalent}`. It does three jobs:

1. **Differential re-mutation** — a symbol whose `contentHash` is unchanged since
   last run is skipped; only changed functions/forms are re-mutated (the manifest's
   hash = the changed-region oracle, robust beyond raw AST-diff).
2. **Focused rerun** (§2) — across resubmissions, re-mutate only sites that were
   failing or whose hash changed.
3. **Grandfather / exemption** — entries with `status ∈ {survived, equivalent}` are
   accepted; a **new** changed-region survivor = a `survived` site not already
   accepted → block. Brownfield seeds the manifest with existing survivors.

`baseline-integrity-gate.ts` protects the manifest: **accepted-survivor / equivalent
entries are shrink-only in changed regions** (you cannot silence a new survivor by
editing the manifest; analogous to its `untested-files.files` rule). `equivalent`
annotations go through the reviewed `interlinked mutation` CLI, never a silent edit.
The manifest is refreshed **only on a `measured` clean pass** (§12) — never on an
unmeasured/unavailable allow, so disabling the runner cannot launder a dirty region
clean (the availability analog of the baseline-integrity rule).

## 5. Coverage is a prefilter, not proof — two block classes

Coverage proves *execution*, not *assertion strength* (Uncle Bob). So coverage is a
**prefilter** producing its own block class, distinct from survivors:

- **Uncovered site** — a mutation site in the changed region that **no test
  executes**. BLOCK; work item: *"write a test that exercises X."* Mutation is
  **skipped** at uncovered sites (mutating un-executed code yields guaranteed
  survivors — no signal), but the site is reported as uncovered work.
- **Survivor** — a **covered** site whose mutant **no test kills**. BLOCK; work
  item: *"strengthen the test / fix or remove the code."*

Order: red/green green → **coverage freshness** (recompute coverage on the overlay's
changed files; the `coverage-index/` content-hash invalidation makes this cheap and
correct — never trust stale coverage) → mutate only **covered** changed-region
sites. Both classes block (Bob-shaped: *block on uncovered OR survivor*).

## 6. Small-scope gate (site-count precheck)

Before mutating, count mutation sites in the changed region. If it exceeds a
threshold (**default ~50, configurable** — clj-mutate's "consider splitting a file
over 50 sites" precedent), **BLOCK with "split this patch"** rather than run a huge
job or defer a giant obligation. This enforces the small-edit discipline the
hard-gate depends on, and is consistent with the repo's small-module posture (the
500-line cap, the cyclomatic/CRAP gates). "Small" means a small **behavioral
delta + its test**, atomic across files (§7) — not one file.

## 7. Runtime flow (Bob-shaped v1) + atomic change-set + isolation

```
PreToolUse { session_id, tool_name, tool_input }            ← Claude Code / Codex
  → daemon → normalize tool_input → ChangeSet (multi-file edits/writes/deletes/renames)
  → cheap pre-checks (secrets, destructive, static oracle)                 [shipped]
  → forwardCloudPreToolUse → Worker → warm Sandbox(es) for session_id      [shipped seam]
  → applyOverlay(ChangeSet)            (one atomic overlay over the whole input)
  → RED/GREEN on the overlay           red → BLOCK; RED-witness: new test red on BASE  [reuses selectAffectedTests]
  → coverage freshness (recompute on changed files)                        [coverage-index/]
  → site-count precheck (§6)           over threshold → BLOCK "split this patch"
  → mutate covered changed-region sites only; differential via manifest    [new — engine wrapper]
  → normalize → siteIds; classify {uncovered | survivor}; diff vs manifest [new — §4]
  → mergeCloudVerdict → BLOCK(work-list) | WARN(allow+warnings) | ALLOW     [shipped]
  → on MEASURED-clean ALLOW: commitChange(ChangeSet) atomically; emit receipt + update manifest
  → if mutation UNAVAILABLE (local-only / cloud cold / timeout): allow + [mutation:not-measured]; NO receipt, NO manifest refresh (§12)
```

**Atomic change-set (§5/rev.2 correction).** `tool_input` is not one file —
`Write`/`Edit`/`MultiEdit` and Codex `apply_patch` touch multiple files with
edits + writes + deletes + renames, and source+test-together is how agents satisfy
the gate (`per-edit-coverage-enforcement.md:26`). The daemon normalizes to a
**`ChangeSet`** (ops tagged `write|patch|delete|rename`, old→new paths); the overlay,
affected-test set, and changed region all derive from that one unit:

```ts
interface RepoProvisioner {
  seed(sessionId, repoRef)                  // session start, off critical path
  applyOverlay(sessionId, changeSet)        // non-destructive eval of the WHOLE input
  commitChange(sessionId, changeSet)        // on allow: atomic persist
  forkCopy(sessionId, n)                    // N isolated worker roots for fan-out
}
```

**Isolation (clj-mutate "unique worker roots").** Each parallel worker is its own
**isolated warm copy** — the `forkCopy` sandboxes *are* the unique roots, so
parallel mutants never collide. Within a worker, in-place mutant-switching with a
clean restore between mutants. The container ceiling is 4 vCPU/instance (1,500/account);
scale by **copies**, never vCPU/box. Budget: `RTT + T_green + T_cov +
ceil(N_changedSites/P)·t_covering`, warm copies make seed/overlay ≈ 0 (seed is
off-critical-path).

## 8. Mechanical verdict vocabulary

The oracle's output is exactly five mutant statuses — no judgment:
**`killed` · `survived` · `timeout` · `uncovered` · `equivalent`** (aligns with
`mutation-gate.ts`'s `FileMutationStats`: `killed`/`survived`/`timeout`/`no_coverage`
(=`uncovered`); `equivalent` = annotated). The agent interprets and acts; the status
is mechanical (per the mutate4go / clj-mutate Claude Code skills, which let the agent
operate the tool but keep the verdict mechanical).

## 9. Wire contract (no `warn` decision exists)

`CloudVerdict.decision` is `"allow"|"block"`; `HarnessDecision.decision` is
`"allow"|"block"|"ask"`. **No `warn`.** So:

| Outcome | Cause | Wire |
|---|---|---|
| **BLOCK** *(measured)* | uncovered site; new changed-region survivor; over-size patch (§6); red tests | `decision:"block"`, `reason:` work-list (§2) |
| **WARN** | RED-witness fails; advisory finding; assertion-mutation survivor (`#3`) | `decision:"allow"`, `warnings:[…]` |
| **ALLOW (measured-clean)** | **fully measured**: green + RED-witness + no uncovered + no new survivor | `decision:"allow"` + receipt |
| **NOT-MEASURED** | mutation unavailable (local-only) or cloud cold/unreachable/timed-out | `decision:"allow"`, `warnings:["[mutation:not-measured] …"]` — **no receipt, no manifest refresh** |

Only a **measured** outcome may block, refresh `mutation-manifest.json`, or mark the
edit mutation-clean (§12). A NOT-MEASURED allow preserves continuity but is *not* a
pass — it is the honest third state next to `[proven]`/`[heuristic]`. WARN =
`allow + warnings` (matches `config.ts` `mode:"warn"`); `mergeCloudVerdict` already
unions cloud warnings with `[cloud]` — **no schema change for v1.** A human-visible
first-class `warn` decision is open (§13). Measured survivors are `[proven]` (the
engine ran — add the runner id to `PROVEN_TOOL_CHECKS`); a **receipt is valid only
against the exact proposed overlay content/hash** (§12); identities emit to
`recurrences.jsonl` (`harness_caught`).

## 10. The Artifacts seam (the explicit stop line)

All provisioning hides behind `RepoProvisioner` (§7). **Build the Sandbox impl now;
stub Artifacts.**

| Op | **Build now** — Sandbox SDK `[new]` | **Stub** — Artifacts `[await GA/access]` |
|---|---|---|
| `seed` | `Sandbox.gitCheckout(remote)` | `ARTIFACTS.fork()` from a session baseline |
| `commitChange` | apply ChangeSet ops via `writeFile`/delete/rename | one atomic commit |
| `forkCopy` | pre-warm N sandboxes, each `gitCheckout` once | `ARTIFACTS.fork()` ×N (cheap, isolated) |
| large repos | full `gitCheckout` (slower warmup) | ArtifactFS blobless lazy mount |

Artifacts changes only **provisioning cost** — it is **not on the 25s critical
path** (copies are warm/synced before a PreToolUse fires). Sandbox-first costs
nothing on the gated path; Artifacts is a one-interface swap.

## 11. Cloudflare product mapping (this scope)

| Role | Product | Status |
|---|---|---|
| Front door, per-request fan-out + aggregate | **Workers** (existing `cloud-forward` target) | GA |
| Warm isolated copies: run engine + tests | **Sandboxes** on **Containers** | experimental, usable |
| Session state (warm-pool, manifest sync) | thin **Durable Object** / **KV** | GA |
| Pure-unit mutant subset (optional) | **DO Facets** | experimental |
| Untrusted-suite egress hardening (optional) | **Outbound Workers** | GA |
| Provisioning / cheap copies / receipt | **Artifacts** + **ArtifactFS** — **stubbed (§10)** | private beta |
| ~~Batch~~ / ~~generative~~ | ~~Workflows~~ / ~~Workers AI~~ — **cut** | — |
| **Not used** | ~~`@cloudflare/shell`~~ — Tier-0 FS can't run tests | — |

**Critical-path trio buildable today: Workers + Sandboxes + a thin session DO.**

## 12. Availability model & default policy — hard-on-evidence, fail-open-on-capability

> **Shipped-state note (2026-07-13):** the daemon currently ships
> `per_edit_mutation.enabled: false` (`rules/default-config.ts`) — see the
> Status header. The default-on policy below is the design TARGET, gated on
> the cloud runner path (Artifacts provisioner, §10) being generally
> available. The governance lock (`allow_agent_override: false`) applies
> whenever the gate is enabled.
>
> **Cloud runner: see `docs/plans/24-cloud-mutation-runner.md`** (2026-08-16)
> — the decision record and build plan for the parallelized substrate this
> section's availability model waits on: Workflows-v2 campaign driver,
> Artifacts-pinned SHAs per measure job, Sandbox/Container execution of this
> doc's runner contract, one-DO-per-repo manifest fold, BYO-agent primary
> mode. Its M1 is this document's §10 provisioner made real.

> **Per-edit mutation is default-on and hard-gating when measured. Availability is a
> capability question, not an agent choice.** Users may choose local-only/free
> operation or disable cloud mutation, but **agents cannot downgrade mutation
> policy**. When no configured runner can measure the proposed edit, the hook allows
> with an explicit `[mutation:not-measured]` warning and does **not** issue a clean
> mutation receipt. *(Unavailability is not a pass; it is an unmeasured allow — no
> manifest refresh, no receipt; §4/§9.)*

**Default config** (alongside `per_edit_coverage` in `rules/default-config.ts`, same
two-tier override model):

```jsonc
per_edit_mutation: {
  enabled: true,                            // default-on
  mode: "block",                            // "block" | "warn" | "off"  (per_edit_coverage convention)
  execution: "auto",                        // "auto" | "local" | "cloud"  (capability / placement router)
  cloud_enabled: true,                      // the USER may opt out of the cloud path
  unavailable_behavior: "allow_unmeasured", // "allow_unmeasured" (default) | "block" (fail-closed opt-in, §13)
  allow_agent_override: false               // the governance lock (see below)
}
```

**Capability-aware enforcement — four cases:**

1. **Measured result available (local or cloud)** → **hard gate.** Red tests block;
   surviving changed-region mutants block; **uncovered changed sites block *or* open
   explicit coverage debt** per policy (reuses `debt_mode` / `coverage-debt-gate.ts`,
   so this does not double-gate the existing coverage path). A clean measured result
   updates the receipt + manifest.
2. **No capability (local-only, no runner)** → **allow + `[mutation:not-measured]`.**
   Local-only/free users are **not punished** for lacking cloud; the edit is **not**
   marked mutation-clean; no manifest/receipt update; no obligation (nothing can
   discharge it).
3. **Cloud-authenticated user, `cloud_enabled`** → the cloud path participates and
   **hard-gates when it returns a measured result.** Default on; the **user** may opt
   out (`cloud_enabled:false`); the **agent cannot** (`allow_agent_override:false`).
4. **Cloud configured but temporarily unavailable** → **allow + degraded warning**
   (not a pass); record a commit-time obligation **only if a later runner can
   discharge it** (`open-obligation-ledger.md`); no manifest/receipt update.

**Governance — no agent escape hatch.** `allow_agent_override:false` plus placing
`per_edit_mutation` in the **team tier** (`config.json` / `guard-rules.json`, not the
agent-writable `*.local.json`) means an agent cannot disable mutation, flip
`execution`/`cloud_enabled`, or weaken `unavailable_behavior`; edits to that config
are themselves gated (the baseline-integrity / settings-validator posture —
`project_settings_permission_validator`). This is the **policy-level** lock atop the
mechanism-level locks (§4, §9): *availability is a capability fact, not an agent
decision.*

This keeps `feedback_safety_continuity` (continuity over premature death) *without*
lowering the bar — the bar is unchanged; we did not measure. **Absolutely hard**
(block when unavailable) is the `unavailable_behavior:"block"` opt-in (§13).

**The outcome is modeled explicitly — only `measured` is authoritative** (a
discriminated union, per `docs/plans/12-hook-outcome-tagged-union.md`):

```ts
type MutationGateOutcome =
  | { kind: "measured";    decision: "allow" | "block"; receipt: MutationReceipt }
  | { kind: "unavailable"; reason: string; warning: string; obligation?: MutationObligation };

interface MutationReceipt {            // valid only against the exact measured artifact
  overlayHash: string;                 // hash of the proposed overlay content actually run
  sites: Array<{ siteId: string; status: "killed"|"survived"|"timeout"|"uncovered"|"equivalent" }>;
  engine: string; engineVersion: string; measuredAt: string;
}
```

Only `kind:"measured"` may **block**, **refresh the manifest**, or mark the edit
**mutation-clean**. `kind:"unavailable"` carries `reason` + the
`[mutation:not-measured]` warning + an optional `obligation` (case 3 only).

**Blocking needs evidence; certifying clean needs *complete* evidence.** A definite
changed-region `survived`/`uncovered` is `measured: block` even if other sites timed
out (positive evidence blocks). `measured: allow` requires the changed region
**fully** conclusive (`killed`/`equivalent`) against `overlayHash`; any
`timeout`/unmeasured site ⇒ not clean ⇒ routes to `unavailable` (no receipt) — never
a forged clean pass.

| Failure | Behavior |
|---|---|
| Cold/unseeded session | seed async; first edit is `unavailable` until warm |
| Cloud unreachable / over budget | `unavailable` + `[mutation:not-measured]`; obligation iff commit-time can run it |
| Partial run (timeouts) | block on any measured survivor; else `unavailable` — never a clean receipt |
| Giant patch (§6) | `measured: block` "split" — never a giant obligation |
| Equivalent mutants | manifest grandfather; WARN; `annotate-equivalent` via reviewed CLI |
| Identity instability | §4 risk — survivor findings WARN before BLOCK |
| Large repos | slower warmup only (off critical path); ArtifactFS stub is the fix |

## 13. Open decisions

1. **Strictness:** ratchet (block on *new* changed-region survivor) vs strict
   greenfield (block on any). Lean: ratchet default.
2. **Site-count threshold (§6):** default ~50; per-repo configurable.
3. **RED-witness / identity severity:** WARN until validated, then BLOCK.
4. **First-class `warn` decision** (human-visible)? v1 = `allow + warnings`.
5. **`unavailable_behavior`** (§12 config): default `allow_unmeasured`; `"block"` =
   fail-closed opt-in. Resolved as a config knob, not an open question.
6. **Fan-out width / language:** start 1 `standard-4`, TS first (Stryker).

## 13b. Candidate ratchet: per-file mutation latency budget (2026-08-11)

Observed during the first whole-repo baseline (two-box overnight run): per-file
measure time spans ~6s to >900s. The spread is not driven by line count alone —
it is **mutant count × scoped-suite wall time**. `commands/verify/section-table-*`
siblings are decomposition products under the 500-line cap, yet each one costs
15+ minutes because their test scope pulls the whole verify-pipeline suite;
meanwhile 300-line files with tight unit tests clear in under 30s.

The proposal: treat **mutation latency itself as a ratchetable testability
metric**. A file that cannot be mutation-measured inside a budget is too big,
too coupled, or only integration-tested — all three are things the product
already wants to push against, and no existing cap measures the third.

- Metric: wall seconds for a full scoped measure of the file (recorded in the
  manifest per receipt — already captured).
- Ratchet shape: high-water per file, shrink-only, same
  `baseline_integrity_gate` protection as the other water-lines. Repo default
  cap for NEW files (e.g. 120s); grandfather list for the existing heavy tail.
- Phase: post/verify cadence (never on the hook path — it needs a runner).
- Proxy lattice, made explicit: LOC ~ mutant count (cheap, per-edit);
  test-scope fan-in ~ per-mutant cost (graph-derived, per-edit); measured
  latency = ground truth (runner, cadence). Ratchet the proxies per-edit,
  verify against ground truth at cadence, and let proxy/ground-truth drift
  trigger recalibration — the same calibrate-against-the-tree discipline the
  Check Evidence Contract already enforces for detectors.

## 14. Build sequence (ends at the Artifacts seam)

1. **Wire per-test coverage + freshness** — `coverage-index/` + `coverage-shards/`
   into the per-edit run; recompute-on-overlay. `[wiring]`
2. **Site identity + mutation manifest** — §4 re-anchoring, `mutation-manifest.json`
   (hashes + statuses), `baseline-integrity-gate` shrink-only rule. **Load-bearing —
   prototype identity stability first.** Full spec:
   `per-edit-mutation-identity-and-manifest.md`. `[new]`
3. **`ChangeSet` normalizer + `RepoProvisioner` (Sandbox impl)** — atomic overlay;
   **← stop line, Artifacts stubbed.** `[new]`
4. **Warm-pool + isolated `forkCopy`** — `keepAlive`; unique worker roots. `[new]`
5. **Cloud mutation runner** — wrap Stryker (TS); coverage-prefilter (uncovered
   class); site-count precheck (§6); differential via manifest; per-mutant identity
   stream; focused rerun. `[new]`
6. **Red/green + RED-witness on the overlay** — relocate `coverage-overlay`
   semantics into the Sandbox. `[new + reuse]`
7. **`MutationGateOutcome` + receipt + verdict mapping** — the measured/unavailable
   union (§12), receipt bound to `overlayHash`; extend `forwardCloudPreToolUse`; §9
   wire contract; `PROVEN_TOOL_CHECKS`. `[extend shipped]`

Steps 1–7 need **no Artifacts**; step 3 is the boundary.

## 15. References

**Shipped (verified):** `coverage-overlay.ts`, `coverage-test-selector.ts`
(`selectAffectedTests`), `coverage-runner.ts`, `coverage-index/`+`coverage-shards/`
(landed, unwired), `mutation-gate.ts` (`MutationBaseline{score,killed}` + `FileMutationStats`
`killed/survived/timeout/no_coverage` — **too coarse for the survivor invariant, §4;
status vocabulary aligns, §8**), `cloud-forward.ts` (`forwardCloudPreToolUse`,
`mergeCloudVerdict`), `cloud-governor.ts` (`CloudVerdict.decision:"allow"|"block"`),
`types/decisions.ts` (`HarnessDecision.decision:"allow"|"block"|"ask"` — **no `warn`,
§9**), `types/config.ts` (`mode:"block"|"warn"`), `evaluator/baseline-integrity-gate.ts`,
`rules/default-config.ts` (`per_edit_coverage`, `budget_ms:25_000`).

**In-repo docs:** `docs/plans/10-mutation-testing.md`,
`docs/plans/13-test-quality-suite-implementation-plan.md`,
`per-edit-coverage-enforcement.md:23,26`, `harness-system-diagrams.md:108`/`:162`,
`open-obligation-ledger.md`, `monotonic-metric-ratchet.md`, `baseline-integrity-gate.md`,
`cloud-governor-architecture.md`, `pre-post-pipelined-cloud-checks-and-failure-recovery.md`,
`cf-sandbox-egress-proxy-pattern.md`, **`docs/external-pulse/deintroverter.md`** (the
existing Uncle Bob / clj-mutate intake; the per-form content-hash manifest note that
§4 builds on).

**External (Uncle Bob — sources for the discipline-loop framing):** mutate4go
(`github.com/unclebob/mutate4go`) and clj-mutate (`github.com/unclebob/clj-mutate`)
— file-at-a-time loop until no uncovered + no survivors, footer manifests with
hashes, >50-site split guidance, parallel unique worker roots, Claude Code skills
that operate-but-don't-judge; *Mutation Testing*
(`blog.cleancoder.com/uncle-bob/2016/06/10/MutationTesting.html`) — semantic
stability, "Mutants should all be red!", coverage proves execution not assertion;
*The Cycles of TDD*
(`blog.cleancoder.com/uncle-bob/2014/12/17/TheCyclesOfTDD.html`). A full rubric
intake belongs in `docs/external-pulse/` (see `INTAKE.md`).

**Memories:** `feedback_pretooluse_cloud_synchronous_block`,
`feedback_harness_deterministic_only`, `feedback_taste_enforcement`,
`feedback_coverage_100_is_the_north_star`, `feedback_local_checks_not_a_trust_boundary`,
`feedback_safety_continuity`, `project_posttooluse_visibility`.
