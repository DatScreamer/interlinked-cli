# Sol Ultra plan audit (FrankenGraphDB) — review findings as a check corpus

- **Source:** https://github.com/Dicklesworthstone/frankengraphdb/blob/main/PLAN_AUDIT_BY_SOL_ULTRA.md (audit of `COMPREHENSIVE_PLAN_FOR_THE_DESIGN_OF_FRANKENGRAPHDB.md`)
- **Encountered:** 2026-07-15, user shared after a 5-hour GPT-5.6 Sol Ultra multi-round adversarial review in Codex (plus a 4-hour-and-counting revision pass)
- **Verdict:** compound — PR (deterministic spec-drift checks + findings ingestion), RFC (`docs/design/spec-audit-runtime-checks.md`), cloud-roadmap entry (Tier 2 invariant taxonomy, Tier 3 doc review scope)

## 1. Core idea (one sentence, your words)

A frontier-model batch audit of a 334 KB design doc produced ~70 findings whose *detection signals* cluster into nine classes, and roughly a third of them (the clerical-drift and known-pitfall classes that revision churn keeps re-introducing) decompose into deterministic per-edit checks over two substrates we mostly already have — a cross-doc fact ledger and a findings-reconciliation ledger — while the rest route to the already-designed Tier 2/3 cloud gates.

## 2. Anatomy (concrete walkthrough)

The audit is one 284-line report: 15 P0 architectural contradictions, ~40 specification gaps
across storage/query/security/verification, 7 workstream-sequencing conflicts, and 8 concrete
document/repository errors. Load-bearing observations from actually reading it:

- **The clerical findings are ID-namespace arithmetic.** "Plan has seven bets incl. B7; AGENTS.md and README say six." "Plan defines FG-INV-28; README says FG-INV-01 through FG-INV-20." Both are `count/range claim` vs `regex-crisp ID census` (`B\d`, `FG-INV-\d+`) — fully mechanical. Verified against the live repo: the in-flight revision resolved the bet drift by demoting Sextant into B5 — the token `B7` no longer exists, so a census check passes today and would have fired at audit time. This class is what a 4-hour revision pass churns *constantly* (renumbering, consolidation, range claims).
- **The doctrine findings quote invariant sentences.** "Retention contradicts the 'commit stream is always the sole truth' doctrine"; "constraint indexes vs FG-INV-18 discardability." The contradicted invariant is lexically extractable (the plan literally numbers them FG-INV-xx); the *judgment* that a mechanism violates it is LLM work — a classification against a fixed taxonomy, which is Tier 2's canonical v2 shape.
- **The deep findings cite external literature.** SSI serializability (Cahill–Röhm–Fekete), Raft payload availability, DBSP Z-set semantics, RFC 6962 split-view, conformal exchangeability. No local oracle exists; only a frontier model with sources finds these. That's Tier 3 by definition.
- **Several findings are recurring spec falsehoods**, not project-specific: exactly-once triggers to external systems, in-house crypto primitives, `forbid(unsafe_code)` + inner `allow` (rustc forbids lowering), truncated-hash-as-identity, post-filter visibility for MVCC/authz indexes, self-oracle common-mode validation, byte-identical floats across heterogeneous machines. These are a *pitfall lexicon* — the prose analog of `nan_coercion_guard`'s "generalize the bug class" program.
- **The audit's own remedy list converges on our architecture**: it recommends "a machine-readable registry containing claim class, assumptions, checker path, owner, dependencies, and gate" and "synchronize README/AGENTS from the authoritative registry" — i.e. gen-markers + check-inventory + registry-parity, which this repo already practices on itself. The finding corpus independently validates the single-source-of-truth doctrine.

Full finding-by-finding classification: `docs/design/spec-audit-runtime-checks.md` appendix.

## 3. Deterministic or agentic?

Hybrid, and the split is the whole point. Per class (~70 findings): ~15% deterministic now
(ID/count/range drift, path existence, dangling refs, pitfall lexicon, claim-tag discipline);
~22% Tier 2 — LLM classification against deterministically-extracted taxonomies (invariant
contradictions, example-vs-grammar drift, workstream-DAG ordering); ~63% Tier 3 — omissions,
external-standard conformance, theory errors. License: audit text is a public repo doc; we
borrow *patterns*, no code.

## 3b. Role in its native architecture — and does it transfer?

Natively it's a **terminal batch oracle**: N adversarial rounds × whole corpus, after authoring,
5+ hours wall-clock, output is a one-shot prose report that a second 4-hour agent pass consumes
lossily. Transplanted here it becomes three different roles: the recurring classes become
**edit-time invariants** (Tier 1, ms); the judgment classes become **delta classification during
authoring** (Tier 2, seconds, async); the deep classes stay a batch oracle but **diff-scoped and
with durable machine-readable output** (Tier 3 → findings corpus), so each terminal audit is one
round over residue, not five hours over everything including clerical drift.

## 4. Substrate vs. surface

Surface: the audit report. Substrate worth borrowing: (a) the finding taxonomy itself as a
check corpus; (b) the file:line-cited numbered-finding format — machine-ingestible into
`findings/corpus.ts` provenance rows; (c) the claim-class taxonomy recommendation
(theorem / model-check / runtime assertion / statistical / benchmark) as a tag discipline our
`[proven]`/`[heuristic]` determinism tags already mirror.

## 5. Lane (1–6)

Lanes 2 + 4 + 5. Lane 2: concrete new detectors (spec fact-drift family, pitfall lexicon,
dangling-ref/path-existence checks). Lane 4: the pattern "external review findings become
harness state with a reconciliation lifecycle" (lands on the built `findings/corpus.ts`).
Lane 5: invariant-taxonomy classification (Guardrails) and doc deep review (Agent CI) — both
slot into designed seams, not new products.

## 6. Dependency & displacement

- **Deps:** none. Extraction is regex/line-oriented over markdown; ledger is derived JSONL;
  no parser dependency (fenced-block linting for known languages reuses existing tool runners).
- **Displacement:** extends rather than replaces — `checks/markdown.ts` (placeholder links only
  today), `literal_occurrences` (cross-file value index, Stop-consumed), doc-marker-drift Stop
  check (gen-markers), `registry-parity.ts` (paired-registry drift), `change-propagation-docs.ts`
  (doc propagation targets), `findings/corpus.ts` + `finding-rules.ts` (built ingestion + rules
  layer), `async-finding-queue.ts` (built, unwired delivery channel).
- **Equivalence (capability-by-capability):** cross-doc fact ledger — **absent** (nearest:
  literal_occurrences, session-scoped values only); findings ingestion+reconciliation — corpus
  **shipped**, reconciliation lifecycle **designed** (v2 outcome ledger), span-matching **absent**;
  invariant distillation from plan docs — /enforce **shipped but wrong mode** (requires
  agent-action triggers; system-invariants route to SKIP/prose today); Tier 2 taxonomy gate —
  **designed** (three-tier v2); Tier 3 doc review — **designed** (Stage 6, open decision 12);
  spec pitfall lexicon — **absent** (pattern precedent: 2026-06 bug-class generalization).

## 7. Smallest spike

One day: `spec_id_census` — extract `PREFIX-\d+`-style ID namespaces + count-word/range claims
from all committed `.md`, recompute census per edit, warn on claim-vs-census drift with both
provenances. Dogfood target: this repo's own docs (which already carry hand-maintained
gen-markers for exactly this) and the FrankenGraphDB tri-document set as the regression corpus
(the B7/FG-INV-28 findings are the acceptance tests).

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | spec fact-ledger checks (census/range/anchor/path), pitfall lexicon, claim-tag nudge, findings ingest + Stop reconciliation | §7 | now |
| Guardrails (P2–3) | invariant-taxonomy classification of spec-edit deltas (policy.md-as-taxonomy, v2 shape) | /enforce `--invariants` distill mode emitting a taxonomy from FG-INV-style registries | next |
| Agent CI (P4–5) | diff-scoped doc deep review whose findings auto-ingest into the corpus (closing the loop) | enroll one plan doc via /enforce, run designed Stage-6 review on a doc diff | next |

## 9. Artifact

PR (spike ladder in the design memo) + RFC (`docs/design/spec-audit-runtime-checks.md`) +
cloud-roadmap entries as above. Compound verdict: adopt the taxonomy and the reconciliation
pattern now; the semantic tiers ride existing designs.

## Notes

- The user's actual pain is **wall-clock, not tokens**: 5 h audit + 4 h revision, serialized
  at the end. The transplant's value is amortization — ms/edit for the recurring share,
  seconds/edit async for the judgment share, one diff-scoped batch round for the residue.
- Sol's report cites `file:line` for most findings — parseable provenance. When commissioning
  future audits, request numbered findings + per-finding file:line/quote (it makes ingestion
  lossless; Sol already nearly complies).
- The revision workflow had no closure mechanism: nothing verified all 70 findings were
  addressed. `pending_completions` (record obligations, clear on visit, warn at Pre/Stop) is
  the built template for exactly that.
