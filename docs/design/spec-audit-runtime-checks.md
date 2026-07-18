# Spec-grade harness — converting audit-class findings into runtime checks

**Status:** V1 MOSTLY SHIPPED — 2026-07-16 (proposed 2026-07-15). Shipped: the
spec-facts substrate (`src/harness/spec/`) and spikes 1–14 (single-file checks,
cross-file ledger + Stop nudge, declared-marker pre-gates, findings
ingest/reconciliation/anti-compounding, pitfall lexicon + claim tags,
capacity/table-sum checks, workstream stage-order detector, contract-template
coverage + join-agenda artifact, code-invariant registry + `spec invariants`
CLI, Re-Pair assembly-significance scoring — **eight registered inline checks**
(`spec_dangling_anchor`, `spec_numbering`, `spec_count_claim`, `spec_pitfall`,
`spec_claim_untagged`, `spec_capacity_claim`, `spec_table_sum`, `spec_stage_order`)
plus the cross-file ledger's `spec` result source, `interlinked findings` and
`interlinked spec agenda|invariants` CLIs), and the Codex subscription review
loop (`.interlinked/codex-review-loop.mjs`, auto-ingesting; raw rounds archived
under `docs/codex-reviews/`). Built under seven adversarial Codex review rounds.
The extractor substrate (`extract-ids`/`extract-counts`/`extract-refs*`/
`binding`/`emphasis-strip`) is CommonMark-hardened through those rounds: every
regex is ReDoS-bounded by executed probe (the round-7 link-label quadratic went
8.4 s → 0 ms), Unicode boundaries are astral- and combining-mark-safe, code
spans / HTML comments / Setext / reference links follow spec precedence, and
namespace-binding is memoized sub-cubic. Rounds 5–7 were designed and
adversarially verified by multi-agent workflows before landing.
Statusline share (§11.1): the snapshot **data plane** ships — `spec_facts_total`
and `review_findings_open` keys are written by the daemon and pinned by tests; the
bash row-1 render segment is deferred behind a decomposition of
`hook-installers-statusline.ts` (at its 500-line cap). Remaining: that render
segment + verify-battery wiring for the ledger checks + the §7.7 benchmark
fixtures + the designed cloud tiers (Tier 2/3).
**Corpus:** the Sol Ultra audit of FrankenGraphDB's design plan
(intake: `docs/external-pulse/sol-ultra-plan-audit.md`), ~70 findings against a 334 KB
plan document, treated as a requirements list for "what should the harness have caught."
**Companion decisions this rides on:** `docs/design/three-tier-architecture-v2.md`
(Tier 2 = classify-into-taxonomy), `docs/design/tier-3-async-deep-review.md` (doc review,
open decision 12), `src/harness/findings/corpus.ts` (built findings store),
`docs/design/stop-event-checks.md` (Stop contract + shipped list).

---

## TL;DR

A frontier-model batch audit is a terminal oracle: N adversarial rounds × the whole
corpus, hours of wall-clock, after the errors are already load-bearing. The harness's
comparative advantage is the opposite shape: O(delta) checks at the moment each error is
introduced, against incrementally-maintained state. This memo decomposes the Sol corpus
by *detection signal* and converts it into three substrates and one policy:

1. **A spec fact ledger** (new, deterministic) — extract ID namespaces, count/range
   claims, anchors/section refs, path references, and declared fact markers from prose
   docs; maintain cross-file; check deltas at Pre/PostToolUse, aggregate at Stop,
   sweep in `verify`. Catches the clerical-drift classes a revision session churns.
2. **A findings reconciliation lifecycle** (extends built `findings/corpus.ts`) —
   ingest any external review report as machine state; track which findings' cited
   spans the session actually touched; nudge at Stop until every finding is addressed
   or explicitly acked. Converts a 5-hour audit's output from a one-shot document into
   a closable checklist.
3. **An invariant registry → cloud tiers** (new /enforce mode + designed Tier 2/3) —
   distill a plan's FG-INV-style numbered invariants and MUST/never doctrine sentences
   into a classification taxonomy; Tier 2 judges each spec-edit delta against it
   (seconds, async, warn-next-turn); Tier 3 does diff-scoped deep review whose findings
   feed back into substrate 2.

Policy: prose extraction is heuristic, so **everything warns except declared-marker
drift**, which is the one zero-FP class and the only `pre_block` candidate. Every check
feeds the recurrence ratchet; recurring Tier-3 findings get generalized into a curated
**pitfall lexicon** (the 2026-06 "bug-class checks from review findings" program,
extended to prose), which is the mechanism by which the deterministic share grows.

Detection is the product; correction stays the agent's job. Findings carry evidence
and — where deterministically computable — *named* candidate resolutions, but **the
harness never writes a fix** (§6.2, a deliberate policy). Semantic joins and checklist
gaps become **obligations** the agent must resolve or ack. Trajectory gates target the
**compounding threshold** — the moment other work starts *building on* an unresolved
error — because that, not the error's existence, is what multiplies the fix cost. §7
is the recall program: the deterministic layer does the *discovery* work of an audit
(joins, checklists, agendas) so that reasoning capacity already present — the coding
agent first, the cloud tiers when built — is spent on real questions, never on search.
§8 names the engine under it: graph theory produces the structural findings, assembly
theory's reuse-aware complexity ranks them and controls their false-positive rate.

Honest shares of the Sol corpus: ~15% deterministically catchable now, ~22% Tier-2
catchable given the substrates, ~63% Tier-3-only (omissions, external standards,
theory). The 15% is disproportionately valuable because it is the *recurring regression*
share — and because clerical drift is what pollutes and lengthens the expensive audits.

---

## 1. What the corpus actually teaches (detection classes)

Classifying all ~70 findings by the signal needed to detect them (full table: Appendix):

| Class | Definition | Sol examples | Detection |
|---|---|---|---|
| **A. Fact drift** | Same enumerable fact stated differently in ≥2 places | "seven bets incl. B7" vs README/AGENTS "six"; plan FG-INV-28 vs "FG-INV-01…20" claims | **Deterministic** — ledger: ID census (`B\d`, `FG-INV-\d+`) vs count/range claims |
| **B. Referenced-but-absent** | Paths that don't exist; entities referenced as load-bearing but never defined; dangling §/anchor refs; promised artifacts missing | `invariants.toml`/`scripts/check.sh` "exist" but don't; `manifest.root` never specified; §620 tests an undefined protocol; Appendix C promises a matrix, ships an inventory | **Deterministic** (paths, anchors) to **semi** (entity definition, promises) |
| **C. Invariant contradiction** | Doctrine/invariant sentence vs mechanism elsewhere | retention vs "commit stream is sole truth"; constraint indexes vs FG-INV-18; PyO3 vs closed-universe; encryption vs O(1) branching | Deterministic *extraction* of the invariant registry; **Tier 2** judgment per edit; Tier 3 for cluster coherence |
| **D. Overclaim** | Guarantee verbs without a claim-class qualifier | "exhaustive over inequivalent interleavings"; "precisely a Z-set stream"; MMR "proves"; byte-identical floats | Deterministic *nudge* (claim-tag discipline); truth-checking is Tier 3 |
| **E. Example↔model drift** | Examples using constructs the spec doesn't define | `path_length(p)` unbound; pattern-literal argument; timestamps where only CommitSeq exists | Known langs: lint the fenced block (deterministic). Custom DSLs: Tier 2 vs extracted grammar |
| **F. Doc↔repo drift** | Prose claims about actual code/files | "zero-copy" claim vs `&[usize]` reality; the missing tooling files | Path/symbol existence **deterministic** (fs + trigram); signature claims Tier 2/heavy |
| **G. Plan-graph defects** | Workstream/gate DAG inconsistencies | W4 deps understated; Warden after everything it changes; sharding workstream referenced, never numbered | DAG census deterministic; ordering judgment Tier 2 |
| **H. Omission** | Missing contracts/fields/interactions | fencing protocol, replay-certificate fields, spill algorithms, authz bypass paths | **Tier 3.** Deterministic assist: coverage matrix (entities × concerns) as advisory |
| **P. Known pitfall** | Recurring spec falsehoods, project-independent | exactly-once to external sink; in-house crypto; `forbid(unsafe_code)`+inner `allow`; truncated-hash-as-identity; post-filter visibility; self-oracle; cross-machine float determinism | **Deterministic advisory** — curated lexicon |

Two meta-observations:

- **The audit recommends our architecture back at us.** Its remedy list includes "a
  machine-readable registry containing claim class, assumptions, checker path, owner,
  dependencies, and gate" and "synchronize README/AGENTS from the authoritative
  registry" — i.e. check-inventory + gen-markers + registry-parity, which this repo
  already practices on its own docs. The gap is that those mechanisms are curated,
  CI-only, and hard-coded to 4 files; substrate 1 is their generalization to arbitrary
  spec docs at edit time.
- **Class A/B/J churn is revision-endogenous.** The fix for "seven bets" was demoting
  Sextant into B5 — verified against the live repo: the token `B7` no longer exists, so
  a census check passes today and would have fired at audit time. Every such
  consolidation creates new stale-reference risk in sibling docs. The 4-hour revision
  pass is *manufacturing* class-A/B work for the next audit; per-edit checks break that
  loop.

## 2. Current surface (verified 2026-07-15)

What fires on a `.md` write today: `placeholder_markdown_link` (empty hrefs only —
`checks/markdown.ts:43`; real anchors deliberately skipped), the 50 KB byte-size
warning, and stub scanning. `readme_script_drift` is verify-only. Everything else
no-ops on prose. Specifically **nothing** inspects: numeric agreement across locations,
arithmetic, dangling anchors/section refs, stale cross-references after a heading edit,
generic doc↔code drift, heading/numbering invariants, contradictions. Adjacent
machinery that exists and is reused below:

| Existing piece | State | Reused as |
|---|---|---|
| gen-markers (`scripts/check-docs.mjs`, 4 hard-coded files) + Stop-time drift nudge (`verification-stop-checks-predicates.ts:336`) | shipped, CI + Stop nudge | the *declared-fact* precedent; fact markers generalize it |
| `registry-parity.ts` (pairwise ID set-membership, verify-only) | shipped | precedent for ID-census parity; extended to value equality via the ledger |
| `literal_occurrences` session map + `magic_literal_cross_file_proliferation` Stop check | shipped | the in-session cross-file value-index pattern the ledger mirrors |
| `recent_line_edits` (per-file span+hash, `types/session.ts:215`) | shipped | span matching for findings reconciliation |
| `pending_completions` + `checkFollowUpViolation` (Pre) | shipped | the obligation lifecycle findings reconciliation copies |
| `change-propagation-docs.ts` (Pre, <5 ms, doc targets) | shipped | Pre-time "this fact also lives at X, Y" propagation category |
| complexity-pulse stash (Pre observer → Post delta, delete-on-read, hash-guarded) | shipped | per-edit fact-delta mechanics |
| `findings/corpus.ts` + `finding-rules.ts` loader layer (`rules-loader.ts:199`) | built | substrate 2's store + born-advisory rule channel |
| `async-finding-queue.ts` (`additional_context` delivery) | built, **unwired** | Tier 2 verdict delivery channel |
| mutation cloud-runner transport (`mutation/cloud-runner.ts:55`, budget_ms, honest `unavailable` arm) | shipped | Tier 2 spec-gate transport clone |
| `structure/` extractors+rules (glossary-residue reads `.md`) | shipped, dormant (needs `structure.json`) | alternative host — see §3.4 |
| /enforce distillation | shipped | invariant extraction after a new mode (§5) |
| Stop checks incl. `doc-marker-drift`, `plan-drift`; Stage-6 earmark for Tier-3 prose review | shipped / earmarked | extended, not duplicated |

## 3. Substrate 1 — the spec fact ledger (deterministic, Tier 1)

### 3.1 Extraction (`src/harness/spec-facts.ts`, new)

Pure function `extractSpecFacts(content, filePath): SpecFacts`, regex/line-oriented, no
deps, no LLM (`feedback_harness_deterministic_only`). Per file:

- **ID namespaces** — cluster `PREFIX-\d+` / `\bPREFIX\d+\b` tokens with a shared
  alpha prefix (`FG-INV-07`, `B3`, `W9`, `G4`, `P0`): DASHED prefixes qualify at ≥2
  distinct ids (the hyphen makes them distinctive, and a prefix stoplist guards
  the common prose pairs like `HTTP-200`); COMPACT prefixes need ≥3 (bare `V8`-style
  tokens are common in prose). Record set, min/max, gaps, duplicates, definition
  sites (heading/table-row vs prose mention).
- **Count and range claims** — `(two…twenty|\d+) <noun>` where `<noun>` matches a
  namespace's noun or a high-frequency capitalized term ("six bets", "28 invariants");
  `X-01 through X-20` range claims.
- **Anchors and section refs** — headings (+ GitHub slugs), explicit `§N.N` /
  `Appendix X` tokens, `[text](#anchor)` and `[text](./file.md#anchor)` links,
  "see §7.3" prose refs.
- **Path references** — backticked repo-relative paths, with a present-tense classifier
  ("exists", "lives at", "see") vs future-tense ("will contain", "planned") — only
  present-tense claims are checkable.
- **Declared facts** — `<!-- fact:NAME -->value<!-- /fact:NAME -->` markers (the
  gen-marker grammar, generalized: any doc may declare; the ledger enforces agreement
  everywhere the same NAME appears). Zero-FP by construction.
- **Named quantities** (v2) — `name = value unit`, "defaults to N", "cap of N" — the
  heuristic tier of class A.
- **Fenced blocks** (lang + content) and **claim-verb sentences** (for §6 consumers).

Extraction cost on the FrankenGraphDB plan (334 KB, 1 251 lines): regex passes, well
under the 800 ms modify budget; expected ~10–30 ms.

### 3.2 The ledger

`SpecFactLedger`: merged per-file `SpecFacts` for all committed `.md` (+ opt-in other
extensions), keyed by content hash, cached under `.interlinked/spec-facts/`
(rebuildable projection — same doctrine as the trigram index; the working tree stays
canonical). In-session freshness via the complexity-pulse stash pattern: PreToolUse
observer stashes `{beforeFacts, afterFacts, afterHash}`; PostToolUse consumes
delete-on-read with the disk-hash guard, then updates the ledger's dirty layer (the
trigram dirty-layer precedent, `trigram-index.ts`).

Derived queries: `census(namespace)`, `claimsAbout(namespace|factName)`,
`referrersOf(anchor|path)`, `sitesOf(factName)` — each answer carries provenance
(`file:line` per site).

### 3.3 Checks

Every check registers per the standing 7-step pattern and ships with ≥3 positive and
≥3 negative cases.

Single-file (inline `CHECK_REGISTRY` entries — the `(content, filePath)` contract
suffices):

| Check | Phase | Gate | Catches (Sol) |
|---|---|---|---|
| `spec_dangling_anchor` | post | default | `[x](#gone)`, `§7.9` with no §7.9, `Appendix Q` (extends `checks/markdown.ts`, which today skips real anchors) |
| `spec_numbering` | post | default | duplicate `FG-INV-12`, gap `B1..B7\{B4}`, duplicate headings — renumber residue |
| `spec_count_claim` (same-file) | post | default | "six bets" while the file itself enumerates B1..B7 (D-1 single-file case) |
| `spec_arithmetic` (v2) | post | advisory | "X = A + B" and table-total rows that don't recompute |

Cross-file (needs ledger + repo root → wired like structure checks in
`server/post-tool-file-checks-phases.ts`, and hand-wired into the verify battery):

| Check | Phase | Gate | Catches (Sol) |
|---|---|---|---|
| `spec_fact_drift` | post (+ pre for *introduction*) | default (declared markers) / advisory (heuristic quantities) | D-1 six-vs-seven across README/AGENTS/plan; D-2 FG-INV-20-vs-28; S-4 encoding contradiction (quantity tier) |
| `spec_xref_integrity` | post + pre-deletion guard | default | edit renames/deletes a heading other files link to → warn with referrer list |
| `spec_path_ref` | post + verify | default (present-tense only) | D-3 `invariants.toml`/`Cargo.toml`/`check.sh` don't exist |
| `spec_symbol_ref` | post | advisory | Q-8 existence half: prose names a code symbol absent from the trigram index |
| `spec_undefined_entity` | verify `--all-checks` | advisory | P0-3 `manifest.root` load-bearing-but-never-defined; P0-4 test-without-subject |
| `spec_promised_artifact` | verify `--all-checks` | advisory | Q-4 promised matrix that never appears |
| `spec_workstream_graph` | verify `--all-checks` | advisory | WS-7 "sharding is the final workstream" with no `W#`; undefined gate refs |

Pre/Post/blocking policy, per the repo's FP discipline:

- **PreToolUse** fires only on *introduction* (before/after delta, the
  `pre-block-gate.ts` introduced-only multiset semantics): the edit adds a claim
  contradicting the ledger, deletes an anchor with live referrers, or changes a
  **declared** fact while sibling sites still hold the old value. Declared-marker
  drift is the sole `pre_block` ("ask") candidate — it is exact-match, zero-FP,
  `severity: error`, honoring the `pre_block` contract in `check-registry/types.ts`.
  Everything heuristic is `pre_warn` at most; prose census on arbitrary docs never
  blocks (a legitimate "six bets" can coexist with a demoted-but-mentioned B7 — the
  live FrankenGraphDB tree proves the FP mode).
- **PostToolUse** is the workhorse: full-file re-extraction, ledger diff, warnings with
  both provenances ("`FG-INV-28` census in plan §F vs 'through FG-INV-20' at
  README.md:381, AGENTS.md:77"). Findings surface as `CheckResultEntry` through
  `post-tool-file-checks` so they auto-feed recurrence
  (`post-tool-file-checks.ts:387`) and the existing dedup/escalation machinery
  (`warnings_issued`, `acknowledged_checks`).
- Determinism tags: declared-marker drift, path existence, anchor integrity →
  `fully_deterministic` (`[proven]`); census/quantity/entity checks → `[heuristic]`.

### 3.4 Why a new module and not `structure/`

`structure/` is the only existing seam with `{graph, changedFiles, repoRoot}` context
and it already reads `.md` (glossary-residue) — but it is dormant behind
`interlinked/structure.json` adoption, and its ArtifactGraph node/edge/companion shape
adds ceremony a fact-value map doesn't need. Spec checks should work out of the box on
any repo containing markdown (config `spec_checks`, default on, include-globs
`**/*.md`, strict families scoped to `spec_docs` globs: `docs/design/**`, `*PLAN*.md`,
README/AGENTS/CLAUDE). If structure/ adoption lands later, the extractor can be
re-hosted there without changing check ids.

### 3.5 Trajectory + Stop wiring (both phases, per the question)

- **Pre, trajectory-aware:** (1) a `specFactSites` propagation category in
  `change-propagation-docs.ts` — editing a fact-bearing region warns "this value also
  appears at X:12, Y:340" *before* the write; (2) `checkFollowUpViolation`-style: open
  spec obligations while the agent moves on; (3) findings-aware steer (§4): "you're in
  §7.3 — open findings F-12, F-19 cite this span."
- **Post, trajectory-aware:** fact changes recorded into a `spec_fact_changes` session
  map (the `literal_occurrences` pattern, `types/session.ts:231` precedent); sibling
  sites not yet updated become `pending_completions` entries.
- **Stop** (formatters in a new `spec-stop-checks.ts`, registered via
  `lifecycle-stop-warnings.ts:150` next to `checkDocMarkerDrift`; config flag in
  `VerificationStopChecksConfig`): outstanding cross-file drift ("you updated
  `max_key_size` in 1 of 4 sites; still stale: …"), unreconciled findings (§4), and
  "heavy spec revision but `verify --specs` never ran" (the
  `formatVerifyNotRunWarning` analog). Signals captured at Post; Stop reads session
  state only (the `stop-event-checks.md` contract). Stop is deliberately the terminal
  backstop rather than SessionEnd: SessionEnd is defensive cleanup
  (`lifecycle-events.ts:239`) and fires when the agent can no longer act on feedback —
  the "at the very least, at session end" tier of enforcement lands at Stop, where the
  nudge still reaches the agent, plus `verify` for CI.
- **verify:** `spec_facts` in the default gate (zero-FP families), `spec_smells`
  advisory under `--all-checks` (entity/promise/coverage/claim-tag families), matching
  the DEFAULT_ADVISORY_SKIPS policy.

## 4. Substrate 2 — findings reconciliation (the workflow closer)

The user's actual loop today: 5-hour audit → prose report → 4-hour revision that
*nothing verifies covered all 70 findings*. Sol's report already cites
`file:line` and quotes per finding — machine-ingestible provenance. Build on the
**built** corpus rather than a parallel store:

- `interlinked findings ingest <report.md> [--reviewer sol-ultra]` — parse numbered
  findings (tolerant: numbered headings + `path:line` tokens + blockquotes; fall back
  to one-finding-per-top-bullet) into `Finding` rows (`findings/corpus.ts:64`) with
  `FindingProvenance{reviewer, file, lines, quote}` and `status: "candidate"`.
- **Reconciliation lifecycle** (the `pending_completions` template): each open finding
  with resolvable spans becomes an obligation. PostToolUse span-matching against
  `recent_line_edits` marks it `touched` (candidate-addressed). `interlinked findings
  ack <id> --reason` records deliberate non-action. Stop formatter: "23 of 70 ingested
  findings have neither a touching edit nor an ack — first 5: …". State transitions go
  through one `applyTransition` (the reservations `ReservationTxn` discipline) so live
  and replay can't drift.
- **Closing the loop with tiers:** whether a touching edit actually *resolves* a
  finding is semantic — an optional Tier 2 classification per finding-delta pair
  (`resolved | partially | untouched-in-substance`), and Tier 3 review output
  (`.interlinked/reviews/*.md`, already-designed schema with severity/file/lines)
  auto-ingests through the same parser. Deterministic layer never claims "resolved" —
  it reports touched/acked/open, which is already the missing control surface.
- Later synergy (one line): tree-log content bindings
  (`docs/design/tree-state-substrate.md`) would make span matching robust across
  rebases via content hashes rather than line numbers.

## 5. Substrate 3 — invariant registry → Tier 2/3 (the semantic share)

Deterministic extraction, cloud judgment — the split the three-product architecture
already mandates:

- **New /enforce mode: `--invariants`.** Verified today: a bare `/enforce` walk skips
  design docs, and the §5/§6 pipeline requires an observable agent-action trigger, so
  a plan's "the commit stream is the sole truth" / FG-INV-xx registry routes to SKIP or
  prose. The new mode drops the trigger requirement and emits
  `.interlinked/policies/<group>.policy.md` **as a classification taxonomy** — exactly
  Tier 2's canonical v2 shape (`three-tier-architecture-v2.md:733`): one labeled entry
  per invariant (id, verbatim quote, provenance), no Cedar predicates over tool input.
  Numbered registries (FG-INV-xx) extract deterministically; MUST/never doctrine
  sentences ride the existing §5 lexicon.
- **Tier 2 spec gate (designed-phase alignment, not a new product):** on qualifying
  spec-doc edits (pre-filter: enrolled `spec_docs` + invariant-keyword/entity overlap),
  classify the delta against the pinned taxonomy — "contradicts INV-18 / consistent /
  not-related", cached prefix = the taxonomy. Transport clones the built mutation
  cloud-runner (`createCloudMutationRunner` — injected fetch, `budget_ms` abort, honest
  `unavailable` third state that never launders); verdicts deliver as
  warn-next-turn via the built-but-unwired `async-finding-queue.ts`
  (`additional_context`), never blocking (LLM verdicts don't meet the `pre_block` bar).
  This is the tier that catches class C — Sol's P0-15/S-7/D-8 shapes — *during* the
  revision instead of five hours after it.
- **Tier 3 doc deep review:** already designed (Stage 6; pre-push `review --staged`,
  warn-only). This memo resolves its open decision 12 in the affirmative for enrolled
  spec docs: enrollment via `/enforce <plan.md>` opts the doc into diff-scoped deep
  review with full-repo context; its findings land in `.interlinked/reviews/` and
  auto-ingest into substrate 2. Class H (omissions) and external-standard findings
  (Raft/DBSP/RFC-6962 class) live here and only here.
- **Pitfall lexicon (`checks/spec-pitfalls.ts`, Tier 1):** curated entries seeded from
  this corpus — exactly-once-to-external-sink; in-house crypto primitives;
  `forbid(unsafe_code)` + inner `allow`; truncated-hash-as-identity; post-filter
  visibility/authz over index traversal; self-oracle common-mode validation;
  cross-machine float byte-identity. Each entry: id, patterns, rationale, citation, FP
  notes, ≥3/≥3 cases. Advisory always. **This is the growth mechanism**: when a Tier-3
  or human audit finding recurs (recurrence log, `proposeAction` → scaffold_rule), it
  graduates into the lexicon — the prose analog of `nan_coercion_guard`'s lineage.
- **Claim-class tags (enrolled docs only):** guarantee-verb sentences
  ("guarantees/proves/ensures/exactly-once/byte-identical") without a
  `[claim: theorem|model|runtime|statistical|benchmark]` qualifier → advisory nudge.
  Adopts the audit's own "claim taxonomy" remedy; mirrors our `[proven]`/`[heuristic]`
  discipline; gives Tier 3 a scoped worklist (verify each `theorem`-class claim).

## 6. From detection to correction — and stopping the compounding

### 6.1 The cost curve and the compounding threshold

An agent error has a timeline: intent → tool call (PreToolUse) → on disk (PostToolUse)
→ **built upon** → Stop → commit → external audit → implementation. Fix cost grows
superlinearly along it, and the discontinuity is the *built-upon* threshold: once
another edit derives from the error, fixing it means fixing dependents too. Sol P0-2
is the worked example — the CommitMarker single-parent shape, one paragraph to fix the
day it was written, contaminated the commit-protocol, branch, and replication sections
authored after it; the audit's remedy is a multi-section rewrite. Every surface in
§§3–5 pushes detection left along this axis; this section adds what detection alone
doesn't provide: correction *pressure* (never autofix), and gates on the threshold
itself.

### 6.2 Correction pressure — without autofix

**The harness never writes a fix. Not staged, not in-flight, not on request.**
Deliberate policy, decided 2026-07-15, two reasons: a wrong automated fix is worse
than a missed finding (the fix inherits none of the FP discipline scrutiny a block
gets, and it lands silently); and the agent must re-derive the correction itself —
self-authored fixes keep the agent's model of the artifact honest, exercise exactly
the behavior the recurrence ratchet exists to train, and are the only path that
prevents the same error's next instance. The precedent is the cyclomatic gate: no
suppression, the escape is to decompose. Corrections work the same way.

What findings carry instead:

| Rung | Eligibility | Mechanism |
|---|---|---|
| **identify** | always | provenance, expected-vs-actual, every disagreeing site quoted (§3.3) |
| **suggest (evidence-only)** | deterministic findings whose resolution space is computable | the warning *names* the candidate resolutions — both directions on ambiguous drift ("either the claim at README.md:93 is stale, or the B7 entries are vestigial"); the single direction when a declared marker fixes truth — but ships no patch; the agent authors the edit |
| **demand (obligation)** | joins and checklist gaps that need reasoning (§7.2–7.3) | the finding registers as an open obligation (`pending_completions` lifecycle): the agent resolves it or acks it with a reason; Stop lists the remainder; unacked obligations persist into the findings ledger for the next session's digest |

Bounding principles. **Direction ambiguity:** census-vs-claim drift has two
legitimate resolutions (the claim is stale, or the enumeration is) — the harness
presents both and never guesses. **Stable-ID awareness:** never suggest renumbering a
stable registry (FG-INV ids are external reference targets); the correct resolution
for a duplicated id is renaming the *newer* entry. **The agent stays the writer** —
authorship, reservations, and the audit trail stay intact; the daemon's only powers
are evidence and refusal (the one `pre_block` class blocks with both provenances
quoted, and the retry is still the agent's own edit).

### 6.3 Anti-compounding gates

Compounding travels through four channels. Each gets a gate, and all four read state
that already exists:

1. **Derivation (read-then-write).** The earliest intervention is the *read*, not the
   write: a Read overlapping an open finding's span attaches a "disputed ground"
   warning via the existing PostToolUse-on-Read path (the `scanFileReadInjection`
   precedent, `post-tool.ts:268`), so the agent is told before it writes anything
   derived. `file_read_at` + `recent_line_edits` supply the join today; tree-log
   content bindings (`derived_from`, tree-state substrate §4.3.1) harden it across
   sessions later.
2. **Dependency crossing (write-on-disputed).** PreToolUse: the edit target depends —
   project-graph edge for code, entity-coupling/referrer edge for specs — on an
   artifact with an open finding → escalated warning naming the finding. This is
   `checkFollowUpViolation` generalized from the session's own follow-ups to all open
   findings.
3. **Reference accumulation.** The ledger counts referrers per disputed fact over
   time; findings rank by **compounding velocity** (dependents gained this session),
   and the Stop report leads with the fastest-compounding ones: "F-7 gained 4
   dependents today; fixing it now touches 1 site, next week 5."
4. **Repetition.** After two same-class instances in one session (recurrence log), the
   third attempt gets a *pattern-level* PreToolUse warning naming the prior sites —
   the class gets caught mid-session instead of instance-by-instance at Post.

Boundary surfaces close the loop: **SessionStart** injects an open-findings digest as
context, so prior sessions' known errors don't silently become this session's
load-bearing assumptions; **Stop** emits the compounding report. Escalation rides the
existing `warnings_issued`/`escalation_emitted` machinery — at most one escalation per
(file, check), advisory tiers never escalate.

## 7. Raising recall — surfacing more of the audit-only mass

Sol's five hours decompose into three activities: **discovery** (which distant
sections and artifacts interact), **reasoning** (do the interacting pieces compose),
and **knowledge** (what Raft/DBSP/rustc actually guarantee). The harness cannot do
the second or third locally — but it can do essentially all of the first,
deterministically and incrementally, and hand the product to reasoning capacity that
is already present: the coding agent itself in-session, the cloud tiers when built,
the next external audit otherwise. Detection stays #1; nothing here fixes anything.

### 7.1 Richer extractors (deterministic warnings)

Quantities with units and dimension checking (`ms` vs `µs` joins, KiB/KB); capacity
arithmetic (an N-bit field near population/reuse claims → "wraps at 2^N — where is
reuse prohibited or the field widened?", the P0-5 generation-wrap shape); layout sums
(struct tables whose field widths don't sum to the claimed total); enumeration
closure ("one of A|B|C" — flag uses of D; prose state machines get a
reachability/undefined-state pass); sum and percentage recompute in tables. Each is a
bounded parser over already-extracted facts — no new dependency.

### 7.2 Contract templates per artifact kind (the omission converter)

Omission-finding looks unbounded, but audits ask the same questions per *kind* of
artifact. Detect each major entity's kind from its defining section (format /
protocol / consensus-replication / crypto-keys / derived-state / identifier /
budget-quota / statistical-guarantee), then check its coupling neighborhood for the
kind's concern checklist: a **format** must somewhere address framing, versioning,
endianness, torn-write/partial-tail, checksum, migration; a **protocol**: timeout,
retry, idempotency, error taxonomy, resumption; **consensus**: leader change, quorum,
unknown-outcome, fencing; an **identifier**: uniqueness scope, collision, truncation,
reuse; **derived state**: invalidation, rebuild authority, staleness. Output is an
obligation, never a verdict: "`manifest.root` (format-kind): no coverage found for
{torn-write selection, directory durability}". On the Sol corpus this mechanically
surfaces the shape of P0-3, P0-4, parts of P0-7/P0-12, S-3, and SEC-1–SEC-4 — ten
findings the appendix currently marks Tier-3-only. The checklists are a curated,
growing corpus exactly like the pitfall lexicon, and audit remedy lists (Sol's own
"specify: …" bullets) are the seed.

### 7.3 Join-agenda generation (deterministic discovery, delegated reasoning)

The coupling index knows every entity bound by constraints in ≥2 distant places and
every invariant sharing entities with a mechanism section. Emit those joins as
**compose-check obligations**: at PostToolUse when an edit touches one side ("you
changed §15.4 retention; FG-INV-07 pins 'commit stream is sole truth' over the same
entity — resolve, or ack why they're consistent"); at Stop as the unresolved agenda;
at verify as the full agenda; and as a standing **review-agenda artifact**
(`.interlinked/review-agenda.md`) that scopes Tier 3 runs and the next external
audit. This attacks the wall-clock problem at its root: discovery is most of what the
five-hour audit buys, and discovery is precomputable. In-session, it conscripts the
strongest reasoner already present — the coding agent — into targeted semantic
verification of exactly the joins its own edits disturbed. The harness does
bookkeeping; the model does all reasoning and all writing.

### 7.4 Code-side symmetry

The same machinery, code-shaped, since these audits find the same classes in code:
extract `// INVARIANT:` / `// SAFETY:` comments, `assert!`/`debug_assert!`
conditions, and doc-comment guarantee sentences into the same registry
(deterministic); obligations fire when an edit lands in an invariant's project-graph
neighborhood. Extend the existing comment-claim drift family to complexity ("O(1)"),
concurrency ("thread-safe", "lock-free"), and determinism claims — each a
verify-or-ack obligation. Kind-scoped completeness applies to code too: a parser
module with zero failure-path tests, a state-machine module with no recovery test.
The 2026-06 bug-class program (nan-coercion et al.) already runs the detector loop
for code; this adds the invariant/obligation layer it lacks.

### 7.5 Domain fact packs

The pitfall lexicon at full strength: small, curated, citation-backed,
machine-checkable facts about common externals (rustc lint-level semantics,
cross-platform float identity, exactly-once impossibility over external sinks,
truncated-hash identity, post-filter visibility). Grown through recurrence: every
audit ingested via substrate 2 whose finding class recurs gets a lexicon candidate
proposed (`proposeAction` → scaffold_rule).

### 7.6 The tiers, scoped

With §7.1–7.5 in place, Tier 2 judges (invariant, delta) pairs instead of whole
corpora, and Tier 3 receives an agenda instead of a blank adversarial mandate — the
same designed systems, an order of magnitude cheaper per finding, which is what makes
running them *continuously* rather than terminally affordable.

### 7.7 Measure recall, don't assert it

The archived Sol audit + the FrankenGraphDB tri-docs are the benchmark corpus. Every
mechanism ships with a scored would-have-fired list against the appendix, so recall
claims in this doc get regression-tested the way check counts do.

## 8. The structural engine — graph theory for structure, assembly theory for weight

§§3–7 name detectors; this section names the two formalisms underneath them, and the
division of labor is clean: **graph theory produces findings** (what is connected to
what, what dangles, what contradicts an ordering) and **assembly theory ranks them**
(of the recurrences we found, which ones can't be coincidence). Neither reasons.
Both are bookkeeping — which is exactly what the no-autofix, detection-first policy
asks of the harness. Evaluation of the assembly-theory transfer, including what we
reject from it: `docs/external-pulse/assembly-theory.md`.

### 8.1 One graph, classical queries

The spec fact ledger (§3) already extracts the pieces; assembling them into a typed
graph costs nothing extra and turns several §7 mechanisms from bespoke passes into
textbook queries. Nodes: entity, section, invariant, claim, workstream, gate, symbol,
file, concern. Edges: `defines`, `references`, `constrains`, `depends_on`,
`delivered_by`, `assembled_from`. This is the *same primitive the repo already ships
for code* — `project-graph.ts`, cycle detection, `impact-analysis.ts` blast radius —
extended to prose entities, so the work is extraction, not algorithms.

| Query | Finding | Sol coverage |
|---|---|---|
| Node referenced with no `defines` edge | undefined load-bearing entity | P0-3 (`manifest.root` never specified); D-3 (path claims) |
| SCC over `defined in terms of` | circular definition | (class not in this corpus; classic spec bug) |
| **Topological-order violation on the workstream/gate DAG** | a stage depends on something scheduled later | W6's unique indexes needed before "Beacon complete"; W4's undeclared Chronicle/Txn/SSI needs (given entity-use extraction) |
| **Backward `constrains` edge** | a late stage changes what an earlier stage froze | Warden at W8 over cursors/indexes/views fixed in W2–W7; Aegis after the commit protocol it rewrites |
| Stage referenced in sequencing prose with no stage node | referenced-but-unnumbered stage | sharding "the final workstream", never numbered W1–W8 |
| Claim node whose evidence edge lands in a later gate | claimed-before-proved | formal anchors at G3; G1/G2 already claim serializability |
| Bipartite incidence: entity × concern (§7.2) | missing coverage cell = omission obligation | P0-3/P0-4, S-3, SEC-1…SEC-4 |
| Two distant nodes sharing ≥1 constrained entity | compose-check obligation (§7.3) | P0-15, S-7, D-8 |
| Betweenness / articulation points | "load-bearing" made quantitative → obligation priority | ranks all of the above |

Those four rows deserve emphasis, because **§7's `spec_workstream_graph` was scoped as
an advisory census and that undersold it badly**. Counted honestly against the audit:
**six of Sol's seven workstream bullets are graph properties** — W6-before-Beacon and
W4's undeclared needs (topo violations), Warden-at-W8 and Aegis-after-commit (backward
`constrains`), sharding-unnumbered (dangling stage), formal-anchors-at-G3
(claimed-before-proved). Extract the sequencing table into a DAG plus each stage's
prose-stated dependencies and constrained entities, and that class falls out of
textbook queries with no model in the loop. Promote it out of advisory once the
extractor's FP rate is measured (§7.7).

The seventh bullet is the honest boundary: *"W8 combines Fabric, Warden, encryption,
Raft, replication, and multi-writer — a scope too broad for one independently
verifiable workstream."* That is a judgment about cohesion, not a topology fact. A
countable proxy exists (distinct subsystems delivered by one stage, the prose analog of
the blast-radius metric) and it is advisory at best — it can raise the question, never
settle it.

### 8.2 Assembly theory as the significance prior

Assembly theory's transferable core is one formula: an object's **assembly index**
`a_i` is the minimum number of construction steps to build it *with free reuse of
anything already built*, and significance goes as `e^{a_i}·(n_i − 1)` over copy number
`n_i`. Rendered for our problem: **a structure too complex to have recurred by
accident, that recurs anyway, is a load-bearing convention — and a divergence among its
copies is drift, not coincidence.** A single copy contributes nothing; a trivial
structure contributes nothing however often it repeats.

That is precisely the false-positive control §3.3 needs, and it arrives with three
concrete consequences:

1. **It retires hand-tuned constants.** `checks/policy-constant-drift.ts` excludes
   `{0,1,-1,2,100,1000,24,60,1024}` by hand; `magic_literal_cross_file_proliferation`
   carries tuned thresholds. Both are hand-approximations of "assembly index too low to
   be meaningful." A `0` has `a ≈ 1` and is suppressed by the formula, not by a list —
   and unlike the list, the formula generalizes to structures nobody enumerated.
   **This is the acceptance test** (§7.7): the score earns its place by deleting the
   exclusion list, not by producing a dashboard.
2. **It sees nested reuse, which n-grams cannot.** The trigram index does flat
   substring lookup; assembly index (via grammar compression — Re-Pair/Sequitur,
   ~200 lines, no dependency) measures *hierarchical* sharing: blocks built of blocks.
   For structured artifacts — nested contract blocks, invariant phrasings, repeated
   config shapes — that hierarchy is the coupling. The index scores candidates the
   trigram index retrieves; it does not replace it.
3. **It quantifies compounding.** §6.3's compounding velocity is exactly the assembly
   index of the subgraph built *downstream* of a disputed node: how much construction
   now depends on the error. "Fixing F-7 now touches 1 site; after this week's
   dependents, 5" stops being a slogan and becomes a computed number — and it is the
   right sort order for the Stop report and the review agenda, because an agenda
   nobody reads in priority order is worth nothing.

The same prior later prices Tier 2: an LLM pre-filter is an economics problem, and
"rank (invariant, delta) pairs by structural significance" is the same score reused.

### 8.3 Boundaries — what we are not importing

- **Never a finding on its own.** The score *ranks and gates* findings produced by
  §§3–7. A high assembly score is not evidence of a defect. Shipping it as one would
  reproduce the exact error the audited plan is criticized for (V-5: statistical
  monitors are not safety enforcement) — in the harness that audits for it.
- **No selection/biosignature framing.** AT's contested claim is that this quantifies
  selection and detects life; we need none of it, and the reading most hostile to that
  claim — "it's grammar compression with a copy-number prior" — is still exactly the
  tool we want. We adopt the part nobody disputes.
- **No agent-facing vocabulary.** A warning says "this exact 28-token block appears at
  4 other sites, all still holding the old value." It never says "assembly index 19."
  Scores live in ranking and thresholds; agents get evidence.
- **Approximation is fine.** Exact assembly index is NP-hard; Re-Pair-class
  approximations are deterministic and linear-ish, and ranking tolerates approximation
  because we need an order, not a theorem.

## 9. What this deliberately does not catch

Be honest in the docs the agent reads: ~60% of a Sol-grade audit is omission-finding
and external-knowledge verification, and §7 converts a large slice of that into
deterministic *obligations* — pointed, provenance-backed questions — while the
*judgment* remains with the agent, the cloud tiers, or the human. An obligation asks
"is the replay certificate's identity closure complete?" — it cannot *answer* that,
nor derive that SSI does not serialize in commit order; no local deterministic system
can.
The architecture's claim is narrower and still decisive for wall-clock:

1. the recurring/regression classes never survive to audit time (ms, at edit);
2. invariant contradictions surface during authoring (seconds, async);
3. the terminal audit runs once over residue, diff-scoped where possible, and its
   output becomes durable, closable machine state instead of a one-shot report —
   so the *next* audit doesn't re-litigate the same ground.

## 10. Rollout (smallest-spike ladder)

| # | Spike | Size | Acceptance |
|---|---|---|---|
| 1 | `spec_dangling_anchor` + `spec_numbering` (single-file, CHECK_REGISTRY) | S | fires on synthetic §-ref/renumber fixtures; 0 FPs across this repo's `docs/` |
| 2 | `extractSpecFacts` + session-scoped ledger + `spec_fact_drift`/`spec_count_claim` (Post warn) + Stop drift formatter | M | reproduces Sol D-1 and D-2 on the archived FrankenGraphDB tri-doc set; passes on the reconciled current set; drift warnings name both candidate resolutions with provenance — no patches |
| 3 | `spec_path_ref` present-tense existence (Post + verify) | S | reproduces D-3; no fires on future-tense plans |
| 4 | `interlinked findings ingest` + reconciliation obligations + Stop nudge + read-time disputed-ground warnings + SessionStart open-findings digest | M | ingests PLAN_AUDIT_BY_SOL_ULTRA.md ≥60/70 findings with spans; Stop reports open-set; a Read overlapping an open finding warns |
| 5 | `<!-- fact:NAME -->` markers + persistent ledger cache + the one `pre_block` (declared-marker drift) | M | marker drift blocks with both provenances quoted (the agent authors the retry); unmarkered drift still warn-only |
| 6 | Pitfall lexicon v1 (7 entries above) + claim-tag nudge (enrolled docs) | S | ≥3/≥3 cases per entry; advisory-only |
| 7 | /enforce `--invariants` distill mode (taxonomy artifact; useful stand-alone as review context) | M | FG-INV registry → 20-entry taxonomy with verbatim quotes |
| 8 | Tier 2 spec gate + Tier 3 enrollment (cloud phase; transport clone + queue wiring) | L | shadow-mode on one enrolled doc; FP < 5% before enforce per the v2 cadence |
| 9 | quantity/unit/capacity extractor + layout-sum + enumeration-closure checks (§7.1) | M | fires on a P0-5 generation-wrap fixture and table-sum fixtures; unit-family negatives don't fire |
| 10 | contract templates v1 — format/protocol/consensus/identifier/derived-state kinds (§7.2) | M | surfaces P0-3, P0-4, S-3, SEC-2 as obligations on the archived plan; ≤2 spurious obligations per 100 KB on this repo's docs |
| 11 | join-agenda obligations + Stop agenda + `review-agenda.md` artifact (§7.3) | M | P0-15, S-7, D-8 joins emitted as obligations when their sections are edited; agenda artifact consumed by one manual review |
| 12 | code-invariant registry (INVARIANT/SAFETY/assert extraction) + comment-claim drift extensions (§7.4) | M | registry built for this repo; obligation fires on an edit inside an invariant's graph neighborhood |
| 13 | workstream/gate DAG extractor + topo-order violation detector (§8.1) | S | reproduces WS-1, WS-4, WS-7 on the archived plan; no fires on a consistent sequencing table |
| 14 | Re-Pair grammar pass + `e^{a}(n−1)` significance score, wired as ranking/threshold under existing drift checks (§8.2) | M | retires the `policy-constant-drift` exclusion list with no new FPs on this repo; ranked recurrence list is human-agreeable (intake §7) |

Spikes 1–6 and 9–12 are pure Tier 1 (deterministic, zero deps, works offline). Each check
registers per the standing pattern (detector in `checks/`, entry in
`check-registry/entries-warnings.ts`, metadata, verify wiring, advisory-skips +
parity-test updates) and feeds recurrence automatically via the post-tool pipeline.

---

## 11. Observable surface — how anyone notices it works

A guardrail's central UX problem: success is mostly negative space (the drift that
never shipped, the audit that found nothing). Two design rules follow. **Every catch
must be visible as a catch→fix loop at the moment it happens** — the block or warning
quotes its evidence in the transcript, and the very next thing the human watches is
the agent resolving it, so cause and correction sit adjacent on screen. And **every
quiet period must be distinguishable from a dead daemon** — the always-visible
statusline row is the heartbeat (checks loaded, ledger fresh); Stop speaks only on
signal, so silence stays meaningful. Nothing below adds new chrome: it puts new
content on surfaces users already look at (transcript, statusline, Stop summary, CLI,
CI, the audit itself).

By distance from the keyboard:

**Watching a session (seconds).** The transcript shows the agent being interrogated
and answering: a write of "the six bets" comes back with both provenances quoted and
the census recount; the agent's next visible action is fixing all four sites — or
acking with a reason that is itself on screen. An edit to §15.4 retention draws
"FG-INV-07 pins 'sole truth' over these entities — resolve or ack," and the human
watches Sol-grade interrogation happen live, mid-authoring, for free. A denied write
is a denial that explains itself. The signature feeling: the agent visibly changes
course for reasons the human can read.

**At session boundaries (minutes).** The Stop summary is the hygiene report that
today doesn't exist: "spec: 2 facts changed, 1 site still stale (PLAN §9.1) ·
obligations: 3 raised, 2 resolved, 1 acked · findings: 61/70 touched-or-acked, open:
F-12, F-31 …". One paragraph, only when there is signal.

**Between sessions (days).** Artifacts a human can open and hand to others:
`.interlinked/review-agenda.md` (the standing, ranked join/obligation agenda —
readable before commissioning the next audit, or handed *to* the auditor);
`interlinked findings status` (the closure dashboard); `interlinked recurrence list`
(proof the checks fire in the wild, with counts). In CI, `verify --specs` fails a PR
that reintroduces drift exactly the way a failing test does — teammates notice
through red CI with a two-provenance message, having installed nothing.

**Per audit cycle (weeks) — the outcome-level proof.** Three observables: the
**composition shift** (the next external audit's findings contain zero class-A/B/F
clerical items and zero workstream-DAG items — if Sol still finds a "six vs seven,"
that is now a harness bug, and §7.7's would-have-fired benchmark catches it first);
the **closure report** (a revision ends with 70/70 findings touched-or-acked,
verified by one command, where today completeness is hope); and **wall-clock** (the
audit brief ships with the agenda, registries, and coupling map — discovery is
pre-paid, so the expensive model's hours go to reasoning, and the run gets shorter
while its findings get deeper).

**The first-contact demo.** For someone who has never seen it work: point
`interlinked verify --specs` at any repo with a large plan document and get
Sol-class clerical findings in seconds; then `interlinked findings ingest
<their-audit>.md` and show the open-set. Minute-one value, no enrollment, no cloud.

**What users must NOT notice** — the inverse acceptance criteria: added latency
(deterministic passes stay in the ms budget; Tier 2 is async, next-turn); repetition
(dedup, escalation caps, and acks exist precisely so a nag never repeats); and the
harness doing the work (no autofix — what the human should observe is *the agent*
getting better, which surfaces as the per-session warning count trending down while
the recurrence log shows classes going quiet). The long-run tell that it works is
that wrongness stops being part of the reading experience: nobody finds a stale
count, a dangling §-ref, or an unreconciled audit finding by hand anymore.

### 11.1 The statusline share

The statusline gets **state, not stories** — and only state that already reached the
agent through hooks or lives in an artifact one OSC-8 click away (the renderer's
existing discipline: every segment links to its file; the statusline is a mirror,
never the primary channel — the agent can't see it). The existing grammar
(`hook-installers-statusline.ts`) has exactly three slots, and the new system feeds
all three without new chrome:

- **Row 1 (capability, persistent):** one new segment, `spec 214 facts`, linked to
  `review-agenda.md` — the §11 heartbeat that distinguishes "quiet because clean"
  from "not running." Dim `spec off` when disabled. The `index 1k files` segment is
  the exact precedent. One segment; no more.
- **Row 2 (outcome chain, freshness-decayed):** zero new UI — spec checks write the
  same structured `last-check.txt` the chain already renders, so "✗ blocked —
  README.md claims 'six bets', census B1–B7 · 12s ago" and "⚠ caught stale count
  before it landed · README.md (8ms)" appear through the existing block/warn
  priorities and age out on the existing windows.
- **Standing state (two kinds, deliberately distinguished):**
  - **Debt** (unexpected: stale sibling sites, open obligations) — a compact dim
    suffix on row 2 (`· 2 drift · 3 obl`), and it participates in brand-yellowing
    the way `review-pending` already does. Links to the agenda.
  - **Progress** (expected: findings closure during an ingested-audit revision) —
    `F 61/70` rendered as a meter, not an alarm: no brand change, dim/green. A
    70-finding revision spending hours at yellow would be alarm fatigue, and closure
    progress is the workflow succeeding, not failing. This counter is also the
    feature's killer screenshot: the harness visibly driving an external audit to
    zero.
  - One rare high-priority chain entry above blocks: `⚠ building on open finding
    F-12 (3 edits)` — the compounding alarm (§6.3). It preempts the chain precisely
    because it is the one ambient state whose cost grows while ignored.
- **Row 3:** sponsor-reserved; untouched. No fourth row — real-estate creep is how
  statuslines die.

Mechanics: all of it is daemon-written snapshot keys (`spec_facts_total`,
`spec_debt_*`, `findings_open/total`, `building_on_finding`) + `last-check.txt`
entries — file reads with `read_snap` defaults, older-daemon degradation, and
freshness gates, exactly like every existing segment. Everything else this design
produces — provenances, agenda contents, Stop reports, recurrence trends, assembly
scores (§8.3 bans the vocabulary everywhere, including here) — stays off the line.

## 12. Local vs cloud — the routing

Placement follows four axes, not preference: the **hot path** (PreToolUse must answer
in ms, offline, with predictable fail semantics — cloud is forbidden there by
design), **data gravity** (when the data is heavy and the compute is light, compute
goes to the data — and the working tree, uncommitted bytes, and session trajectory
live only on the machine; "code never leaves the machine" is also the free-tier trust
wedge), **compute/knowledge gravity** (inference, web-fresh external knowledge, and
fan-out parallelism live only in the cloud), and **independence/proof** (some value
*derives from being elsewhere*). The seam between them is always an artifact —
agenda, registries, findings, receipts — generated deterministically on the machine,
consumed and returned asynchronously, with the honest-`unavailable` degrade and never
a local block on cloud absence.

**Local-exclusive** (a cloud variant would be worse or wrong):

| Mechanism | Why only local |
|---|---|
| Pre gates: drift-introduction warn, anchor-deletion guard, marker `pre_block` | decision hot path; ms budget; must work offline; fail semantics must be deterministic |
| Fact ledger + extractors + dirty layer | reads uncommitted bytes at tool-call granularity; data-heavy/compute-light; privacy default |
| Trajectory anti-compounding (read-taint, write-on-disputed, repetition) | session state exists only in the daemon, at hook cadence |
| Stop / SessionStart surfaces, statusline | physically local UX |
| Join-agenda *generation*, contract-template + lexicon *evaluation*, assembly scoring | cheap deterministic passes over local state (score off the Pre path; Post/Stop/verify granularity) |
| Findings reconciliation (span-matching, obligations, acks) | joins against `recent_line_edits`; source-agnostic (works on a hand-written review too) |
| First-pass obligation judgment | the coding agent itself — free, in-session, and the philosophy: the model does the reasoning |
| `verify --specs` in CI | the local binary runs anywhere; CI needs no service |

**Cloud-only or cloud-best** (the four things a local process cannot manufacture):

| Mechanism | Which cloud value | Why not local |
|---|---|---|
| Tier 2 invariant classification | inference | LLM-in-the-daemon is banned by doctrine; async by design. (Self-hosters may point the same transport at a local model — the architecture stays remote-shaped; only the endpoint moves) |
| Tier 3 deep review; omission judgment; example-vs-grammar and signature-claim checking | inference + corpus reasoning | needs a frontier model over large context, with citations |
| External-standard verification (RFC 6330 fields, Raft/DBSP claims, rustc semantics) | knowledge | requires web-fresh sources *and* inference |
| **Independent verification of agent-resolved obligations** | independence | Sol V-2 applied to ourselves: the agent verifying its own resolutions is a common-mode oracle; the remote reviewer is our "deliberately separate tiny SCC checker" |
| Lexicon / contract-template / claim-tag registry distribution + curation pipeline | scale (central state) | cross-repo sharing with review; local repos can still hand-commit copies |
| Cross-repo recurrence, fleet analytics, benchmark-corpus aggregation | scale | aggregation has no local vantage point |
| Signed, tree-bound receipts ("prove my agents were governed") | proof | local receipts are forgeable by an agent with disk access — the `baseline-integrity-gate` threat model; only an external anchor answers it, and it is the paid discriminator |
| Whole-corpus batch beyond the per-edit budget (giant repos, history mining, N-verifier fan-out) | scale | heavy-deterministic legitimately routes to cloud per the intake compute-budget filter |

Two standing rules. **The gradient flows toward local:** nothing migrates local→cloud;
cloud findings migrate *into* local determinism (Tier-3 finding → recurrence →
lexicon/checklist entry → local check). The cloud is the R&D lab; the local harness
is the factory. **And the split is the business split on purpose** — local is the
adoption and trust wedge (offline, private, free); cloud sells exactly the four
values above, none of which a skeptic could claim belongs on the free tier anyway.

## Appendix — finding-by-finding mapping

IDs: P0-n (blocking), S-n (storage), Q-n (query/exec), SEC-n (security/ops), V-n
(verification/stats), WS (workstreams), D-n (doc/repo errors). "Catchable at" names
the *earliest* surface; det = deterministic, semi = deterministic extraction +
heuristic match, LLM = cloud tier required.

| Finding | Class | Earliest catch | Kind |
|---|---|---|---|
| P0-1 capsule finalized before coordinator validation | C | Tier 2 (entity-coupling scoped) / Tier 3 | LLM |
| P0-2 marker arity vs global+branch ordering | C | Tier 2/3 | LLM |
| P0-3 `manifest.root` never defined; ECS-vs-raw contradiction | B2 + C | verify advisory (`spec_undefined_entity`); Tier 2 contradiction | semi + LLM |
| P0-4 no multi-process fencing; §620 tests undefined protocol | B2 + H | verify advisory; Tier 3 | semi + LLM |
| P0-5 mutable labels vs VId `label_class`; 8-bit generation wrap | C + H | Tier 2/3 | LLM |
| P0-6 SSI serializability unproven | D + H | claim-tag nudge (det assist); Tier 3 w/ citations | det assist + LLM |
| P0-7 Raft commit without payload-availability quorum | H | Tier 3 (external standard) | LLM |
| P0-8 per-shard Raft lacks distributed txn/time model | C/H | Tier 3 | LLM |
| P0-9 Z-set semiring conflation | D + H | claim-tag ("precisely"); Tier 3 (DBSP) | det assist + LLM |
| P0-10 MVCC-filtered HNSW instability | P + H | pitfall lexicon (post-filter visibility); Tier 3 | det advisory + LLM |
| P0-11 authz as optimizer rewrite; bypass paths | H | coverage-matrix advisory; Tier 3 | semi + LLM |
| P0-12 replay certificate missing identity fields | H | Tier 3 | LLM |
| P0-13 per-branch encryption vs structural sharing | C | Tier 2 (pinned invariants) / Tier 3 | LLM |
| P0-14 transparency overclaim (split-view) | D | claim-tag nudge; Tier 3 w/ RFC 6962 | det assist + LLM |
| P0-15 retention vs "commit stream sole truth" | C | invariant taxonomy + Tier 2 per edit | det extraction + LLM |
| S-1 truncated 128-bit hash ≡ content | P | pitfall lexicon | det |
| S-2 EncodingId missing | H | Tier 3 | LLM |
| S-3 SymbolRecord vs RFC 6330 | H | Tier 3 | LLM |
| S-4 EF vs delta-varint vs executor rank/select | A/C | quantity-tier `spec_fact_drift`; Tier 2 | semi |
| S-5 hole bitmap not snapshot-versioned | H | Tier 3 | LLM |
| S-6 generation pin ≠ buffer-frame pin | H | Tier 3 | LLM |
| S-7 constraint indexes vs FG-INV-18 | C | invariant taxonomy + Tier 2 | det extraction + LLM |
| S-8 BranchManifest single parent vs merge | C | Tier 2/3 | LLM |
| S-9 examples use timestamps; model defines CommitSeq | E | example-construct census; Tier 2 | semi |
| S-10 inline descriptors vs unbounded edge types | H | Tier 3 | LLM |
| Q-1/Q-2 path memoization/termination soundness | H | Tier 3 | LLM |
| Q-3 GLA algebra missing operators | H (B2 assist) | operator census advisory; Tier 3 | semi + LLM |
| Q-4 Appendix C promises matrix, ships inventory | B4 | `spec_promised_artifact` advisory | semi |
| Q-5–Q-7 factorization / spill / replanning | H | Tier 3 | LLM |
| Q-8 zero-copy claim vs actual `&[usize]` | F | `spec_symbol_ref` existence (det); signature claim Tier 2/heavy | det + LLM |
| Q-9 InsertionOrder vs CSR sort order | C | Tier 2/3 | LLM |
| Q-10 float byte-identity across machines | P + D | pitfall lexicon + claim-tag | det |
| Q-11/Q-12 view shape / watermark modes | H | Tier 3 | LLM |
| Q-13 trigger exactly-once claim | P | pitfall lexicon | det |
| Q-14 PQ multiplicative-guarantee claim | H | Tier 3 | LLM |
| Q-15 hybrid retrieval underspecified | H | Tier 3 | LLM |
| SEC-1 resource-budget dimensions missing | H | coverage-matrix advisory; Tier 3 | semi + LLM |
| SEC-2 cancellation / COMMIT_UNKNOWN | H | Tier 3 | LLM |
| SEC-3 FGP protocol sketch | H | Tier 3 | LLM |
| SEC-4 backup-manifest fields | H | Tier 3 | LLM |
| SEC-5 audit log vs reclaimable history | C | invariant taxonomy + Tier 2 | det extraction + LLM |
| SEC-6 "test suite proves UDF determinism" | D/P | claim-tag + pitfall | det assist |
| SEC-7 DP principal/accounting | H | Tier 3 | LLM |
| SEC-8 in-house crypto primitives | P | pitfall lexicon | det |
| V-1 DPOR "exhaustive" scope | D | claim-tag | det assist |
| V-2 self-oracle common-mode | P | pitfall lexicon | semi |
| V-3 conformal exchangeability | H | Tier 3 | LLM |
| V-4 OPE positivity/support | H | Tier 3 | LLM |
| V-5 monitors ≠ invariants | D | claim-tag | det assist |
| V-6 TLA+ trace inclusion ≠ refinement | D | claim-tag | det assist |
| V-7 scrub sampling under adversarial faults | H | Tier 3 | LLM |
| V-8 claim taxonomy needed | — | *is* the claim-tag mechanism — adopt | det |
| WS-1/2/3/5 stage ordering + backward-constrains (W4 deps; Warden@W8; Aegis; W6-before-Beacon) | G | workstream DAG: topo violation / backward `constrains` (§8.1) | **det** |
| WS-4 formal anchors at G3 vs claims at G1/G2 | G | claim-node evidence edge in a later gate (§8.1) | **det** |
| WS-7 sharding "final workstream", never numbered | G/B2 | dangling stage node (§8.1) | **det** |
| WS-6 W8 scope too broad | — | subsystem-count proxy advisory; judgment is Tier 3 | semi |
| D-1 seven bets vs "six" in README/AGENTS | A | `spec_count_claim`/`spec_fact_drift` — Pre-introduction warn, Post | **det** |
| D-2 FG-INV-28 vs "01…20" claims | A | `spec_fact_drift` range-vs-max | **det** |
| D-3 invariants.toml / Cargo.toml / check.sh absent | F/B1 | `spec_path_ref` | **det** |
| D-4 `forbid(unsafe_code)` + inner `allow` | P | pitfall lexicon | **det** |
| D-5 `path_length(p)` unbound in README | E | fenced-example lint (custom DSL → Tier 2) | semi |
| D-6 pattern-literal not in grammar | E | grammar census → Tier 2 | semi |
| D-7 "namespaced" label vs unnamespaced keywords | D/C | Tier 2 | LLM |
| D-8 PyO3 vs closed-universe invariant | C | invariant taxonomy + Tier 2; dep-name lexicon assist | semi + LLM |

Shares: ~15% det-now · ~22% Tier 2 over det substrates · ~63% Tier 3 — with the §8.1
workstream-DAG queries moving six WS findings from "ordering judgment → Tier 2" to
deterministic, the det share reaches ~23%. The det share is the recurring-regression
share, and the lexicon + claim-tag mechanisms are how it grows.
With §7's interrogation layer (contract templates + join agendas), roughly **half** the
corpus additionally surfaces as deterministic, provenance-backed *obligations* — the
question reaches the agent even where the answer needs reasoning — with no cloud
dependency. Shares here count proven detection only; §7.7's benchmark keeps them honest.
