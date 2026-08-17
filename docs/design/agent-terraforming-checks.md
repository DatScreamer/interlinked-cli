# Agent-terraforming checks — gates whose compliance pressure re-architects the codebase

Status: design catalog, 2026-08-11. No implementation yet. Companion context:
`per-edit-cloud-mutation-testing.md` §13b (mutation latency budget, the first
member of this family recognized as such), `monotonic-metric-ratchet.md` (the
enforcement mechanics every entry below reuses).

## The selection criterion

A **terraformer** is a check whose *fix* makes at least one other gate cheaper
or more precise. It differs from a defect detector: a detector judges code,
a terraformer reshapes the codebase toward a state where agents — and
Interlinked itself — operate better. The line cap is the founding example:

    line cap ↓ → file size ↓ → mutant count & test scope ↓ → mutation fits a
    per-edit budget → agents get ground-truth feedback per edit → better code

Every candidate below must pass: *"name the other gate this makes cheaper."*
A candidate that only expresses taste fails the test and does not ship.

## The currency argument

An agent's scarce resource is context tokens; a small model's scarce resource
is *capability under small context*. A codebase property that lowers the token
cost of a correct edit converts directly into (a) cheaper strong-model work and
(b) feasibility for weaker/local models — goal 4 (training signal) and the
portability goal at once. Several entries below are denominated in this
currency explicitly.

## Catalog — new entries (2026-08-11)

### TF1. Context-closure cap (read-set tokens)
The agent-native generalization of the line cap. Measure: tokens in the minimal
read-set to correctly edit a file = the file + the type/interface slices of its
direct imports (graph-derived, deterministic). Ratchet: per-file high-water,
shrink-only; repo cap for new files. Pressure: extract interfaces, narrow
imports, split god-files — the refactors that make files *understandable in
isolation*. Other gates made cheaper: every LLM-tier gate (Tier-2/Tier-3 prompt cost),
small-model viability, human review.

### TF2. Effect quarantine (purity share)
Deterministically classify functions pure/effectful (effect = fs/net/spawn/
clock/random/console/process, or transitively-effectful callee). Ratchet:
purity share may only rise; effectful functions must live in designated shell
modules (functional-core-imperative-shell, enforced not aspired). Pressure:
push IO to edges. Other gates made cheaper: mutation (pure functions need no
sandbox isolation), all witness checks (replay/fault-injection/boundary
battery run pure code trivially), coverage (pure = easy 100%).

### TF3. Regenerability index (the north star, composite)
Could an agent delete this file and rewrite it from exports + tests alone?
Proxy composite: contract strength (share of exported signatures with named,
non-any types) × test coverage × purity share × addressability (TF4). Ratchet
the composite per file. Pressure: the codebase converges toward "any file is
disposable"; implementation becomes fungible, contracts + tests become the
asset. This is the product thesis in one number.

### TF4. Symbol addressability (search-ambiguity ratchet)
Agents navigate by search, and Interlinked owns the search layer (trigram
index) — so ambiguity is *measurable, not proxied*: for each exported symbol,
how many candidate definitions does the index return for its name? Ratchet:
collision count shrink-only; same for duplicated user-facing error strings
(one string → one throw site). Pressure: distinct names, self-describing
errors. Other gates made cheaper: grep-accelerator precision, agent mis-edit
rate (editing the wrong `parse()` among twelve), log→source attribution.

### TF5. Single-writer state
Every mutable module-level binding has exactly one writer module (graph + AST,
deterministic). Ratchet: multi-writer binding count shrink-only. Pressure:
distant mutation — the agent bug class hardest to see in a diff — becomes
structurally impossible. Other gates made cheaper: change-propagation
analysis, replay determinism, reservation granularity.

### TF6. Change-locality ratchet
Cross-directory co-change rate (already computed by `metrics coupling` /
`rework`) may not grow. Pressure: directory boundaries migrate to match how
change actually flows; edits become single-directory, which shrinks test
scope and review surface. Other gates made cheaper: test-scope weight,
blast radius, reservations.

## Previously identified members (for one catalog)

- Mutation latency budget (`per-edit-cloud-mutation-testing.md` §13b) — ground truth.
- Test-scope weight — the causal driver of mutation latency; per-edit proxy.
- Hub purity — logic budget shrinking as fan-in grows.
- Unvalidated-boundary count — parse-don't-validate, locked in post-sweep.
- Unified escape-hatch debt — one shrink-only number over all suppressions.
- Gravity-weighted floors / modularity ratchet / reliability propagation —
  graph-mathematical family (see conversation record 2026-08-11; spectral
  methods on the cached import graph).

## The anti-fragmentation bound (two-sided pressure)

Splitting is not free: small/cheap models *retrieve* rather than read, and a
concept scattered across eight 50-line fragments costs more hops, more tool
calls, and more reassembly than one cohesive 400-line file. The line cap and
the mutation-latency budget push toward smaller; unbounded, they over-shoot
into fragmentation that raises the true cost while lowering the proxy.

The counterweights are already in this catalog, and the pair is self-balancing:

- **Context closure (TF1) punishes over-splitting automatically** — fragments
  that must be read together keep (or grow) the closure, since it counts the
  import neighborhood plus the hop overhead, not the file alone. A split only
  wins if each piece is *independently* understandable.
- **Addressability (TF4) bounds fragment proliferation** — more files means
  more near-synonym symbols for the search layer to disambiguate, and that is
  measured, not guessed.
- **Where to split is a graph question**: a split is a cut; a good split is a
  sparse cut (low conductance — few severed edges relative to each half's
  internal density). The modularity/Fiedler machinery identifies natural cut
  points where splitting is nearly free. Where no sparse cut exists, the file
  is genuinely cohesive — an honest monolith — and the correct response to
  its verification cost is decoupling its *tests*, never fragmenting its
  logic.

Rule of thumb the ratchets encode: **a split must reduce closure or scope
seconds; a split that only reduces line count is a regression.**

## Brownfield vs greenfield

Nothing here needs new mechanics: every entry adopts via the standardized
high-water/grandfather pattern (`large-files-baseline.json` precedent) —
measure current state, freeze as ceiling, shrink-only from there, protected by
`baseline_integrity_gate`. Greenfield repos get the caps from file one.
Adoption in either case is `interlinked adopt`-shaped: one command, one
committed baseline, ratchet begins.

## Non-goals

- No entry ships calibrated against this repo alone (the N=1 rule).
- No entry ships without naming the gate it makes cheaper (the flywheel test).
- Composite indices (TF3) are score/report tier, never block tier — blocking
  stays reserved for single-cause, zero-FP findings per the phase contract.
