# Predictive-Gate Validation Join — the precondition for any predictive *block*

**Status: STUB — a precondition spec, not yet scheduled.** This is deliberately modeled on the §18 RFC's structure for the Bayesian classifier (precondition → acceptance bar → substrate dependency), because it is the same problem: *a predictive signal cannot be allowed to gate until it is shown to predict.* If this stays a one-paragraph backlog item it will never get built; it is written here with an acceptance bar and a named dependency so it can be scheduled as its own work.

## The problem

Every predictive signal in the system — the **graph-prediction score** (`docs/design/graph-prediction-protocol.md`, shadow mode), a future **trajectory/competence classifier**, any **agent-competence estimate** — assumes its prediction is worth gating on. **Nothing yet proves that.** Per the §18-RFC logic (a classifier ships shadow/inform-only until its agreement with ground truth is measured), no predictive signal earns *blocking* authority until a **validation join** demonstrates that prediction accuracy actually tracks defects. This doc is the home for that join; without it, every predictive gate in the doc set is resting on an unvalidated premise.

## What the join *is* (mechanically)

A deterministic query that correlates **predicted outcome** against **observed defect**, keyed on `(session_id, file)`:

- **Left side — predictions:** the prediction-reconciliation log (the graph-prediction protocol's reconcile output, `graph-reconciliations.jsonl`): each row is a prediction + its later reconciliation (was the predicted shape/outcome correct).
- **Right side — outcomes:** the **outcome-valence ledger** (§6.5: `user_undid` / `reviewer_flagged` / `ci_failed` — the negative-valence records that mark "this edit was actually bad").
- **The question:** *do high-accuracy predictions correlate with a low subsequent-defect rate, and low-accuracy predictions with a high one?* If accuracy and defect-valence are independent, the predictor has no gating authority; if they correlate, it earns it — bounded by the acceptance bar below.

This is a deterministic join over two append-only logs — no LLM in the loop, consistent with the harness's deterministic-checks discipline. It is *analysis*, run at a deferred cadence (nightly / on-demand), not a per-edit hook.

## What it *depends on* (the unmade decision this surfaces)

Both logs must exist **durably and joinably on a settled state substrate** — and that substrate decision is still open: **local append-only JSONL** vs **cloud DO-SQLite** vs **mirrored**. The join can't be built durably until that's decided, because:
- a per-session JSONL that's GC'd at session end can't support a cross-session correlation;
- the join *is* a query, and queries want an indexed store (the DO-SQLite case) far more than a JSONL scan once the corpus is large.

So this doc has an explicit upstream dependency: **the durable trajectory/finding substrate** (`maximal-local-enforcement-roadmap.md` → "Adjacent work"; receipt ledger Phase 0.3 + finding history Phase 0.4). The join is one of the first real *consumers* that decision needs to serve.

## Acceptance bar (borrowed from §18, adapted)

A predictor graduates from shadow/inform-only to *may-block* only when **all** hold:
1. **Correlation** — accuracy↔defect-valence correlation clears a pre-registered threshold on a held-out window (the §18 analog of "agreement rate ≥ 90%"; the exact statistic + threshold to be set against the first real corpus, not guessed here — *measurement-pending*).
2. **OOD fallback** — on inputs outside the validated distribution (new file kinds, unseen languages, novel trajectory shapes), the predictor **does not block** — it falls back to inform-only.
3. **Drift monitoring** — the correlation is re-checked on a rolling window; if it decays below threshold, blocking authority is **automatically revoked** back to inform-only.

## The gate it unblocks (the teeth)

**No predictive signal earns *blocking* authority until this join passes for it.** Until then — and this is the operative rule, not an aspiration — graph-prediction, any trajectory/competence classifier, and any future predictive gate are **shadow / inform-only** (they may write `additionalContext` and durable findings; they may *not* return a `block` decision). This is the same detection/decision + fail-open discipline the deterministic gates already follow, applied to the predictive ones: the join is the typed evidence a Cedar *block* rule is allowed to read.

This turns the validation join from "nice analysis we'll get to" into **the single precondition gating every predictive block in the system** — which is what it actually is.

## Next step

Schedule it behind the substrate decision (above). The minimal first cut: once both logs land on one joinable substrate, write the deterministic correlation query + a pre-registered threshold, run it shadow for a window, and only then let any predictor's `block` rule consult the result. Owner artifact: this doc + the query; not a footnote on graph-prediction.
