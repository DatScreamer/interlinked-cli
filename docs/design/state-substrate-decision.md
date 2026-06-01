# State-Substrate Decision — the shared blocker under the validation join, the durable ledger, and cross-session signals

**Status: DECISION — recommended call below, confirmable.** This doc exists to give the state-substrate decision the same *name-it-once-as-shared-infrastructure* treatment the test-coverage map just got (`maximal-local-enforcement-roadmap.md`). It was scattered as a dependency-mention across three+ docs — which is how a blocking *decision*, like a keystone *artifact*, gets footnoted in three places and therefore never made. This is the single home; everything below waits on it.

## What waits on this decision (why it's the deeper keystone)

| Waiting feature | What it needs from the substrate |
|---|---|
| **Validation join** (`predictive-gate-validation-join.md`) | a *joinable, queryable* store — it correlates the prediction log × the §6.5 valence ledger; a correlation query wants an index, not a scan |
| **Durable trajectory + finding ledger** (Principle #7's write-target, `harness-system-diagrams.md`) | *cross-session durability* — steering serves future agents only if the finding outlives the session |
| **Receipt ledger** (Phase 0.3) | per-tool-call receipts, durable + content-hash-keyed |
| **Finding history** (Phase 0.4) | per-fingerprint lifecycle (first/last_seen, status) — a *queryable* view |
| **Cross-session recurrence / anything multi-agent** | a shared store readable across sessions / agents / machines |

Four-plus high-value unbuilt items, each independently blocked on one call. Two of them — the validation join (gates *every* predictive block) and the durable ledger (makes steering serve future agents and humans) — are among the most consequential unbuilt things in the whole set. A decision referenced as a footnote in three docs gets made about as often as a keystone footnoted in three docs gets built: ~never. Hence this home.

## The three options + tradeoffs

| Option | Pros | Cons |
|---|---|---|
| **A · Local append-only JSONL** (status quo) | shipped; local-canonical + authoritative; offline; crash-safe append; signable / content-hash-keyed (forward-compat) | cross-session queries are O(scan); no index for the join / aggregation; grows unbounded; not natively shareable across machines / agents |
| **B · Cloud DO-SQLite** | indexed, SQL-queryable (the join *is* a query); the DO is the natural cross-session / cross-agent coordination point (supervisor pattern); scales | requires the cloud → breaks "local-canonical, period" + offline; cloud as the single source of truth is the wrong default for a local-first kernel |
| **C · Mirrored — JSONL canonical + a derived SQLite index** | keeps JSONL canonical / authoritative / offline; adds a queryable index for the join + aggregation | two surfaces; the index must stay a *rebuildable projection*, never a second writer |

## The call

**Option C, framed to dissolve its only real con: keep the append-only JSONL as the single canonical, authoritative, signable log (unchanged, local-first), and add a queryable index as a *derived, rebuildable projection of the JSONL* — never a second source of truth.**

- The index starts as **local SQLite**, built by replaying the JSONL. Because it is *derived*, it can be dropped and rebuilt at any time → there is **no dual-source-of-truth consistency problem** (the worry that sinks most "mirrored" designs). It's a cache / view, not a writer.
- It **mirrors to a cloud DO-SQLite only when cross-session / cross-machine / cross-agent sharing is the actual need** — consumer-driven, not speculative. Single-agent local deploys never touch the cloud; the supervisor-pattern multi-agent case gets the shared DO when it materializes.
- This respects the existing **"storage is local-canonical, period; sync is additive later"** principle verbatim — JSONL is authoritative; the index (local, then cloud) is the additive, rebuildable query / sync layer the receipt format was already designed (signable, content-hash-keyed) to support.

**Why not A or B:** A can't serve the validation join's correlation query at corpus scale — and that join is the gate under every predictive block. B violates local-first and offline. C is the only option that keeps the canonical store local + authoritative *and* gives the queries an index; the "rebuildable projection" framing removes the consistency cost that normally makes mirroring expensive.

## Schedule (the trigger — so this isn't itself a footnote)

The index is **consumer-driven**: build it when the first consumer needs a query the JSONL-scan can't serve cheaply. That first consumer is the **validation join** (a correlation over a growing corpus) — so the index work is *coupled to* scheduling the validation join, not a separate speculative project. Until then, JSONL-scan suffices (the corpus is small). The cloud mirror is a later, separate trigger (the first real cross-session / multi-agent need).

**Confirmable:** this is the recommended call, not a fait accompli — the tradeoffs are on the table; override if the deployment shape (cloud-first, or air-gapped-only) changes the weighting. But it should be *a* call, named here, rather than a dependency mentioned in three places.
