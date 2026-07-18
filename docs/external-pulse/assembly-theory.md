# Assembly Theory (Cronin / Walker) — reuse-aware complexity as a detection prior

- **Source:** Marshall, Murray & Cronin 2017, "A probabilistic framework for identifying biosignatures using Pathway Complexity" (Phil. Trans. R. Soc. A); Sharma, Czégel, Lachmann, Kempes, Walker & Cronin 2023, "Assembly theory explains and quantifies selection and evolution" (Nature 622). Algorithmic anchor: the smallest-grammar problem (Charikar et al. 2005), Re-Pair (Larsson & Moffat 1999), Sequitur (Nevill-Manning & Witten 1997).
- **Encountered:** 2026-07-15, raised by the user while designing `docs/design/spec-audit-runtime-checks.md` — "how might we consider Assembly Theory (and possibly Graph theory)?"
- **Verdict:** compound — **adopt** the reuse-aware weighting core (lane 3 substrate, in-CLI, no dep); **reject** the selection/biosignature framing as inapplicable and contested; **skip** any use of the word "assembly" in agent-facing warning text.

## 1. Core idea (one sentence, your words)

The **assembly index** of an object is the minimum number of joining steps needed to
build it from primitives *when any structure already built along the way can be reused
for free*, and the theory's second move is to weight that index by **copy number** —
because a high-assembly-index object appearing in many identical copies cannot
plausibly have arisen independently, so its recurrence is evidence of a shared
producing process.

## 2. Anatomy (load-bearing claims, in my words)

1. **Assembly index = minimal construction path with reuse.** Not object size, not
   entropy: it counts *construction steps* and charges nothing for re-using a
   subassembly a second time. So `ABABABAB` is cheap (build `AB`, reuse), while an
   equally long unstructured string is expensive.
2. **Copy number is the second axis, and it does the real work.** A complex object
   seen once is a curiosity; seen a thousand times identically, it implies a factory.
   The ensemble measure `A = Σ e^{a_i}(n_i − 1)/N_T` makes this explicit: the
   exponential in `a_i` means high-complexity items dominate, and the `(n_i − 1)`
   means a single copy contributes **nothing**. Recurrence-at-complexity is the signal.
3. **Exact computation is NP-hard**; the field uses split-branch / pathway
   approximations, and the practical estimator for molecules is mass spectrometry
   peak counting.
4. **The contested claim** is the physics one — that this quantifies selection and
   distinguishes life-produced from abiotic matter as *novel* theory. Critics have
   argued the index is substantially a compression measure and that the novelty over
   established algorithmic-complexity/LZ-family results is overstated. **I take no
   position** — and note that our use needs none of it.
5. **What survives the critique is exactly what we want.** Even the harshest reading —
   "this is grammar-based compression with a copy-number prior" — describes a
   rigorous, deterministic, well-studied tool. The critique attacks AT's claim to new
   physics, not the utility of reuse-aware construction cost as a measure. We are
   adopting the part nobody disputes.

## 3. Deterministic or agentic?

**Fully deterministic**, and cheaply approximable. Assembly-index estimation over text
or an AST reduces to grammar compression (Re-Pair/Sequitur are ~200 lines, linear-ish,
no dependency); copy number is a count. No inference, no model — clears
`feedback_harness_deterministic_only` outright. License: N/A (published theory; we
implement from the algorithmic literature, borrow no code).

## 3b. Role in its native architecture — and does it transfer?

Natively AT is an **oracle**: a claimed detector of selection, where a high `A` licenses
the inference "a process made this." That role does **not** transfer — we have no
ensemble of independently-arising artifacts, our "copies" arise by human/agent copy-paste
(which is the *hypothesis*, not a rare event to be detected), and nothing here should ever
be phrased as detecting intent.

The role that *does* transfer is **prior**: a principled significance weight for whether
a recurrence is meaningful. In our topology it must be strictly non-authoritative — it
ranks and gates findings, never produces one on its own. Treating an assembly score as
evidence of a defect would be exactly the "statistical monitor masquerading as an
invariant" error the Sol audit itself flags (V-5).

## 4. Substrate vs. surface

- **Surface** (reject): biosignature detection, "quantifying selection," ensemble `A`
  as a global artifact score. A repo-wide "assembly number" would be ornamental math —
  the failure mode the FrankenGraphDB plan itself names for its own calibration plane.
- **Substrate** (adopt): (a) reuse-aware construction cost of a span, via grammar
  compression; (b) the copy-number-at-complexity prior, i.e. `significance ∝
  e^{a_i}·(n_i − 1)`; (c) the assembly *pathway* as a DAG — isomorphic to the
  content-addressed/Merkle structures we already ship.

Borrowable without the surface: yes, entirely. We want the estimator and the prior.

## 5. Lane (1–6)

**Lane 3 (substrate)** primarily — a reusable measure over `trigram-index` /
`literal_occurrences` / the proposed spec-fact ledger. **Lane 4 (pattern)** secondarily:
"recurrence-at-complexity is the signal, and trivial recurrence is noise" is a design
principle that retro-justifies several hand-tuned constants we already carry.

## 6. Dependency & displacement

- **Deps:** none. Re-Pair/Sequitur are short, self-contained, and pure-TS-able; no
  import, no subprocess. Passes the dependency filter cleanly.
- **Displacement:** does not replace `trigram-index.ts` (that is a *lookup* index; this
  is a *scoring* pass over candidates it returns). Overlaps and would **subsume the
  hand-tuned exclusion list** in `checks/policy-constant-drift.ts` (`{0,1,-1,2,100,1000,
  24,60,1024}`) and the `magic_literal_cross_file_proliferation` thresholds — those are
  hand-approximations of "assembly index too low to be meaningful."
- **Equivalence (capability-by-capability):** reuse-aware complexity of a span —
  **absent**; copy-number index — **shipped** in narrow form (`literal_occurrences`,
  exact literals, session-scoped); construction DAG with dedup — **shipped** as
  content-addressing (`scratchpad-archive.ts` CAS; tree-log git objects, designed);
  significance-weighted finding ranking — **absent** (`suggestion-scorer.ts` ranks by
  hand-assigned weights, not structural complexity).

## 7. Smallest spike

≤1 day: run Re-Pair over this repo's `docs/` + the FrankenGraphDB tri-doc set; emit the
non-terminals with `copy_number ≥ 2` ranked by `e^{a_i}(n_i − 1)`. Success = the top of
that list is dominated by structures a human agrees are load-bearing conventions
(invariant phrasings, repeated contract blocks, config shapes), and the bottom is
boilerplate. That single ranked list is testable in an afternoon and either the prior
separates signal from noise on real docs or it doesn't.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | assembly-weighted drift significance (FP control for `spec_fact_drift` / magic-literal families); downstream-assembly compounding score | §7 | next (after the fact ledger exists to score) |
| Guardrails (P2–3) | rank which (invariant, delta) pairs are worth an LLM call — the pre-filter's economics are exactly a significance prior | reuse the same score in the Tier-2 pre-filter | parked |

Agent CI row deleted — Tier 3 gets an *agenda* from the coupling graph, and ranking it
is the same P1 score; nothing AT-specific lands there.

## 9. Artifact

RFC-by-inclusion: folded into `docs/design/spec-audit-runtime-checks.md` §8 as the
scoring layer under the existing detectors, plus this intake. **Not** its own feature,
never its own command, and no agent-facing vocabulary — a warning says "this exact
28-token block appears at 4 other sites," never "assembly index 19."

## Notes

- The honest summary of the transfer: **graph theory supplies the structure, assembly
  theory supplies the weighting.** Graph theory answers "what is connected to what, is
  anything dangling, is the order consistent" (deterministic *findings*); assembly
  theory answers "of the recurrences we found, which ones matter" (deterministic
  *ranking*). Neither reasons; both are bookkeeping — which is the correct division
  under the no-autofix, detection-first policy.
- Best line of defense against ornamental math, borrowed from the audited plan itself:
  every score must bind to a check that would otherwise be hand-tuned, or be removed.
  The acceptance test for AT here is *retiring the magic-number exclusion list*, not
  producing a dashboard.
- Watch for the seductive overreach: "detect whether this document was authored
  coherently or patched incoherently." The bounded, real version — near-duplicate
  high-complexity structures that diverge at the top — is just drift detection with a
  good prior. The unbounded version is a biosignature claim about prose, and we should
  never ship it.
