# Local gate catalog — every candidate runnable on one machine, by latency tier

Status: design catalog / build plan, 2026-08-11. Nothing here is implemented
unless it names a shipped module. Companions (no content duplicated here):
`agent-terraforming-checks.md` (the selection criterion + the six terraformers),
`per-edit-cloud-mutation-testing.md` §13b (mutation latency budget + proxy
lattice), `monotonic-metric-ratchet.md` (ratchet mechanics all entries reuse),
the witness-backed verification design (earliest-surface routing).

Doctrine constraints that bind every entry: deterministic only (no model in
the check path); blocking tier needs ~zero FP measured against a real corpus,
never fixtures; phase = earliest point the evidence exists; a check that adds
noise displaces attention and does not ship. Latency doctrine: there is no
sub-10ms pipeline budget — PreToolUse may take seconds when it must,
PostToolUse stays synchronous, and 30–60s is an accepted deliberate window
(it doubles as the multi-agent sync barrier).

## Tier A — milliseconds, PreToolUse-capable (content + cached graph)

Evidence: proposed content (before disk) + the daemon's cached project graph
+ the complexity gate's already-paid parse stash. All introduced-vs-baseline
(multiset) semantics per `pre-block-gate.ts`.

1. **Unvalidated-boundary count** — regex/AST count of unparsed
   `JSON.parse`/casts at boundaries; edit may not increase the file's count.
   Registry-contract compatible. Start `pre_warn`; `pre_block` only after a
   corpus FP run.
2. **Unified escape-hatch debt** — one shrink-only number over `as any` +
   non-null assertions + suppression directives + `interlinked-ignore`s.
   Unifies four existing per-kind ratchets.
3. **Hub purity** — branch budget that shrinks as fan-in grows (inputs: parse
   stash + graph). Reverse direction (the importing edit that turns a file
   into a hub) lands at PostToolUse on the importer.
4. **Test-scope weight (delta)** — "this edit adds an import edge that widens
   X's scoped suite"; graph lookup + import parse of proposed content.
   Degrades portably to test-file count when no runtime history exists.
5. **Predicted mutation latency** — mutant density × test-scope seconds,
   calibrated against the measured baseline (the 2026-08-11 overnight run is
   the first calibration corpus). Conformal interval; warn when the *lower*
   bound exceeds the runner budget.

## Tier B — one to five seconds, PostToolUse (needs disk / a process)

6. **Import-time side-effect witness** — `import()` the edited module in an
   isolated node process; measure wall, heap, fds, attempted network.
   Executed evidence for top-level work; also the denominator behind slow
   test startup.
7. **Executed ReDoS oracle** — extract regexes from the edit, time them
   against crafted adversarial inputs under a timeout. Upgrades the
   nested-quantifier heuristic to `[proven]`, zero FP by construction.
8. **Boundary battery** — synthesize inputs from the edit's own AST
   (comparison literals ±1, NaN, -0, Infinity, empty/huge collections,
   surrogate pairs); run the edited pure functions on them. Off-by-one
   killer; no fuzzer randomness.
9. **Type-surface diff** — `tsc --emitDeclarationOnly` (incremental) on the
   edited module pre/post; diff the `.d.ts`. Silent contract breaks caught at
   the edit, not at the importer's build.

## Tier C — 30–60 seconds, PostToolUse (instrumented scoped-suite runs)

All entries share ONE piece of infrastructure: an instrumented scoped-test
harness (run the file's scoped suite with hooks installed) plus the ChangeSet
overlay pair (pre-edit and post-edit builds). Build the seam once; each gate
is a plugin.

10. **Golden-trace differential replay** — replay the last N recorded real
    inputs (from `.interlinked/` logs) through both builds; diff outputs.
    Deterministic behavior-preservation — the named audit gap. The one gate
    that exploits data only Interlinked has.
11. **Stability witness (flake-at-birth)** — scoped suite 2–3× with shuffled
    order + re-run; bit-diff results. Catches order dependence and
    clock/random leakage while the offender is one file.
12. **Fault-injection error-path witness** — re-run injecting one thrown
    error per IO site systematically; report catch blocks that never execute
    even under injected faults.
13. **Effect-trace diff** — patch `fs`/`net`/`child_process` during the run;
    diff the capability trace across the edit. Performance and security in
    one gate (a diff that suddenly opens sockets is an alarm). If only one
    Tier-C gate gets built first, build this one.
14. **Empirical complexity fitting** — run edited functions at input sizes
    n/2n/4n; log-log slope is the measured exponent. Slope high-water per
    function catches O(n)→O(n²) as a number, not a review comment.
15. **Sampled local mutation** — ~20 random mutants of just the edited
    functions, sequential, Wilson interval on kill rate. The degraded-local
    mode of the cloud design; beats "not measured" whenever the runner is
    unreachable.
16. **Invariant-inference diff** (Daikon-lite) — record boundary properties
    (sorted, non-null, monotone, length-preserving) during the scoped run;
    diff the inferred set across the edit. Behavior drift without goldens.
17. **Growing fuzz corpus** — 30s coverage-guided burst (deterministic seed),
    corpus persisted under `.interlinked/` across sessions; crash-free corpus
    size only grows. A cross-session ratchet artifact.
18. **Resource ceilings on tests** — scoped suite under explicit heap/wall
    limits; per-test-file high-water ratchet. Keeps every other gate inside
    its budget forever (the 2026-08-11 crash, generalized into a gate).
19. **Leak slope** — heap high-water across 5 repetitions of the same test;
    positive slope = leak at introduction time.
20. **Strictness-debt ratchet** — typecheck changed files under the *next*
    tsconfig strictness tier; error count may only shrink. A migration
    engine disguised as a counter.

## Tier D — cadence (verify / commit), local but not per-edit

21. **Measured mutation latency budget** — the §13b ratchet; ground truth
    that calibrates entries 4–5.
22. **Gravity-weighted quality floors** — eigenvector centrality on the
    reverse import graph scales required mutation/coverage floors.
23. **Modularity ratchet** — Newman Q of the import graph may not drop;
    cross-cluster imports warn with the Fiedler-cut receipt.
24. **Hidden-coupling grading** — effective resistance vs co-change
    correlation; refines the existing `hidden` pair flag.
25. **Reliability propagation** — survivor rates as defect probabilities
    propagated through the DAG; repo reliability number ratchets; per-edit
    marginal impact ranks what to test next.
26. **Concept-lattice coverage analysis** (FCA) — tests covering nothing
    unique; code covered only incidentally; exact minimal affected-test set.
27. **CUSUM fire-rate drift** — statistical Goodhart detection: a check whose
    fire-rate collapses abnormally fast is being gamed.
28. **EVT-derived thresholds** — every cap a quantile with confidence
    interval from the tree's own distribution, recalibrated at cadence
    (institutionalizes the halstead lesson).

## Local hardware notes

- Verification workloads pinned to efficiency cores (`taskpolicy` QoS), never
  competing with the user (the runner's Nice+LowPriorityIO, generalized).
- Graph / coverage matrix / trigram index as mmap'd binary snapshots —
  microsecond loads on the hook path.
- Baselines as a meet-semilattice: branch merges take the per-file meet —
  monotonicity preserved by construction across branches and machines.

## Build order

1. Tier A 1–2 (pure content, mechanics exist) → immediate.
2. The instrumented-harness seam + effect-trace diff (13) → unlocks all of
   Tier C as plugins.
3. Predicted mutation latency (5) + measured budget (21) — tonight's baseline
   is the calibration corpus; ship predictor as `pre_warn`.
4. Type-surface diff (9) + stability witness (11).
5. Graph tier (22–23) once the oracle-graph interface lands.

Every entry adopts brownfield via the high-water/grandfather pattern and is
protected by `baseline_integrity_gate` once baselined.
