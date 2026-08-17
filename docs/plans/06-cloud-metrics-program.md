# Plan 06 — Cloud metrics program (deferred lanes)

**Status:** parked by directive 2026-07-24 — the local lane (see
`docs/design/history-relational-metrics.md` + `scratch/CAMPAIGN.md` Wave 2) is
being built first. This doc preserves the cloud analysis so it does not get
re-derived. Companion evidence: session measurements of 2026-07-24.

## A. Cloud-required — never for the math, always for one of three reasons

Every metric in the program computes locally at this repo's scale. Cloud is
mandatory only where one of these holds:

| Reason | Items | Notes |
|---|---|---|
| **Trust boundary** — local checks are bypassable by the governed agent (`feedback_local_checks_not_a_trust_boundary`) | proof-of-enforcement for ANY gate; escape-hatch-rate integrity; security-class per-edit blocks | The metric runs locally; the *attestation that it ran untampered* is the cloud part. Builds on [[project_proof_of_enforcement_bft_extensibility]] R1 (cloud-signed). |
| **Data locality** — the data does not exist on this machine | cross-environment flakiness (CI runner history); FP calibration of detectors across foreign repos; fleet-wide baselines across the ~116 MCP servers; cross-user recurrence | You cannot parallelize your way to data you don't have. |
| **LLM judgment** — deterministic-only local pipeline by decree (`feedback_harness_deterministic_only`) | Tier 2 policy gate, Tier 3 deep review, any "is this violation actually bad taste" escalation | Designed in docs/design/tier-2-llm-policy-gate.md / tier-3-async-deep-review.md. |

## B. Local-possible but slow — cloud parallelization wins

Ranked; item 1 is already proven in production and is the template.

1. **Per-edit mutation testing** — measured ~250s local wall (why
   `per_edit_mutation` is OFF locally) vs. deployed cloud Worker v3 killing
   34/34 in bounded time. Template seam: cloud returns results into the same
   per-edit `MetricRegression[]` under `budget_ms`.
2. **Deep-history scans** — Tornhill-grade coupling evolution / per-line age
   maps over 10k+ commits: O(commits × files) blame, tens of minutes locally,
   embarrassingly shardable by commit range (merge counts).
3. **Cross-repo FP calibration** — the `cross-repo-validate` skill's job at
   fleet width; one sandbox per repo. Prerequisite for promoting
   `cognitive_complexity` (and future taste metrics) from advisory to a
   default-gate cap with a defensible number.
4. **Clone/near-dupe at fleet scale** — trigram candidates locally, pairwise
   verify sharded in cloud; cross-server clone detection across the MCP fleet.
5. **Type coverage per-PR** — full checker-API pass (~2,108 files) is
   audit-cadence locally; per-file parallel in cloud if wanted per-PR.
6. **Big-suite coverage/affected-tests per edit** — existing pattern: big
   suites → commit gate locally, cloud runners per-edit.

## C. The seam (build contract when this un-parks)

- PreToolUse may block synchronously ~25s on cloud work
  (`feedback_pretooluse_cloud_synchronous_block`); the 30–60s window is
  deliberate (`feedback_deliberate_prepost_latency`).
- One combined verdict: local metrics in ms + cloud metrics under `budget_ms`
  → single `MetricRegression[]` per edit (mutation gate already defines this).
- Batch lanes (2, 3, 4) are jobs, not gates: they SET the water-lines the
  local gates then enforce for free.

## D. Un-park triggers

- Lane 3 first, when cognitive-cap promotion needs cross-repo FP evidence.
- Lane 1 re-enable locally only if the runner round-trip fits `budget_ms`.
- Lane A trust-boundary work when multi-agent/BFT (R1) resumes.
- **Mutation lane superseded (2026-08-16):** the cloud mutation runner now has
  its own decision record and build plan — `docs/plans/24-cloud-mutation-runner.md`.
  This program keeps the non-mutation metric lanes only.
