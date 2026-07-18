# Tree-State Substrate — the content plane (decision + architecture)

**Status:** DECISION — approved for implementation, 2026-07-14. Not yet built.
**Implementation plans:** `docs/plans/tree-log/00-INDEX.md` (start there; four phased plans).
**Companion decision:** `docs/design/state-substrate-decision.md` (the *event*-ledger decision; this doc is the parallel decision for *content*).
**Audience:** Anyone implementing or reviewing the tree-log, the cloud mirror, or any feature that needs "what did the tree look like at time T."

---

## TL;DR

Interlinked persists **events** (activity.jsonl), **metrics** (baselines/ratchets), and
**findings** (error-history, recurrences) — but **no store anywhere holds file
content or tree state**. Meanwhile eight design docs each independently assume a
tree-state store exists (five of them name Cloudflare Artifacts as where it lives),
and each defines only the fragment it needs. Per the keystone-omission methodology in
`docs/design/maximal-local-enforcement-roadmap.md` ("naming it per-feature is how
three docs each conclude they independently need it; naming it once is how it gets
built"), this doc names it once.

**The decision:** build a **per-session snapshot log** ("tree-log") — a daemon-owned,
content-addressed store of working-tree states at tool-call granularity, written at
PostToolUse, reconciled at session boundaries, kept under `.interlinked/tree-log/`.
Local-only and valuable standalone (lost-update recovery, session time-travel,
tree-bound receipts). Later, mirrored per opt-in to a cloud git store — Cloudflare
Artifacts when available, any bare git remote as the stub — which is the missing
populator for every cloud feature that forks "the user's tree."

**What it is NOT:** not a gate (never blocks, never on the decision hot path), not a
second source of truth for *current* state (the working tree stays canonical; the
log is canonical only for the new axis, content *history*), not a Tier-2 input, not
a replacement for reservations, git history, or the team remote, and not default
egress (mirror is off unless configured).

---

## 1. The evidence — eight docs, one missing substrate

Verified against the doc set on 2026-07-14 (line numbers drift; quotes are the
anchor):

| Doc | What it already assumes | The fragment it leaves undefined |
|---|---|---|
| `pre-post-pipelined-cloud-checks-and-failure-recovery.md` §1.4 | Cloud check Workflow does `env.ARTIFACTS.get(workspaceBaseline(pre_event.session_id)).fork('check-<receipt_id>')`; Phase 3d is gated on "Artifacts beta access" | How `workspaceBaseline(session_id)` is **populated** — nothing writes it |
| `cloud-local-disagreement-policy.md` §3–4 | Parity invariant: "cloud forks the user's repo at the exact commit the local hook is evaluating. If the user has uncommitted changes, the diff is included in the artifact. No staleness."; SessionStart pre-warm "fork the repo into an Artifact" | The continuous refresh. Stale artifact is failure category B with remedy "refresh artifact and rerun" — refresh mechanism undefined |
| `multi-agent-pre-push-review.md` | A per-(user,repo) **Cloudflare Artifacts git repo** + persistent Sandbox; "Each commit pushed to the dev's git remote also lands in the Artifacts repo"; verdicts stored as signed bundles **in** the Artifacts repo | **Commit-only** (`git checkout ${commitSha}`) — uncommitted/in-flight work is invisible; the substrate "doesn't exist yet" |
| `per-edit-cloud-mutation-testing.md` §7/§10/§12 | Ships full file overlays per request because "the cloud clone comes from git, so a test-first test that only exists locally must travel with the edit"; the Artifacts provisioner is the stubbed seam; §12 gates default-on on it | The shared base that would turn per-request overlay *payloads* into *deltas* |
| `multiplayer-control-plane.md` + `multiplayer-broker-orchestration.md` | Handoffs, receipts, and a CLI-hook adapter that already streams "proposed edits" to the server; mapping table row "Code artifacts \| Artifacts / R2 / git mirror" | Handoffs transfer **bindings without bytes** (broker §7 revokes A1's binding, issues B1's — the uncommitted content stays on A's machine); receipts pin identity/scope/task but **not content**; edit deltas arrive with no base to apply them to |
| `tier-3-async-deep-review.md` | "The reviewer agent has read access to the entire repo"; reviews `@{u}..HEAD` | The **mechanism** for that repo access is unspecified; uncommitted state is only a last-resort fallback (`git status` scan) |
| `trajectories-as-primitive.md` §4.3.1 | Cross-agent stale-context detection: `read(x.ts, content_hash=H_a)` … sibling `write(x.ts → H_b)` … `write(x.ts, derived_from=H_a)` ⇒ warn | The store of those content hashes (and the diffable content behind them). Unbuilt |
| `harness-system-diagrams.md` | "Cloudflare Artifacts (ArtifactFS) blobless clone — each copy shares the content-addressed base and is a one-file overlay" as eval scratch | The **persisted** base. Its own substrate map confirms: no durable store holds content |

Adjacent business fact (`ideal-customer-profiles.md`): the free-vs-paid
discriminator is "*prove to someone else* my agents were governed," and the planned
R0 receipt is specified as "**ruleset-hash + tree-bound**, reproducible." Proof
requires verdicts bound to — and ideally dereferenceable to — exact tree states.

Field-tested motivation (`cohort-git-discipline.md` §"Field-tested during
authorship"): two sessions both wrote `docs/external-pulse/bun-in-rust.md`; "the
second write silently replaced the first author's paragraph." Blast-radius rules
*prevent* some of this class; a snapshot log makes the remainder *recoverable*.
Today it is neither preventable in full nor recoverable at all.

## 2. The decision

Build one substrate in four phases (each independently shippable and valuable):

1. **Local snapshot log** (`docs/plans/tree-log/01-local-snapshot-log.md`) — the
   daemon writes content-addressed snapshots of edited files at PostToolUse into a
   bare git object store at `.interlinked/tree-log/`, one ref per session, with
   full-state reconciliation at session boundaries. CLI: `interlinked tree-log
   status|show|diff|restore|prune`.
2. **Content bindings** (`02-content-bindings.md`) — receipts gain a `ContentBinding`
   (snapshot commit + tree hash + base head); `interlinked verify --receipt` ships
   the R0 tree-bound receipt; cross-agent stale-context warnings (inform-only) use
   the read/write content hashes.
3. **Cloud mirror** (`03-cloud-mirror.md`) — opt-in `git push` of session refs to a
   per-(user,repo) mirror store behind a `SnapshotStore` seam: any bare git remote
   today, Cloudflare Artifacts when beta access lands (Artifacts speaks git, so the
   push path is identical; only auth/provisioning differ). Secrets-scan gate before
   every push. Off by default.
4. **Consumers** (`04-consumers.md`) — wire the eight assuming features to the
   substrate: workspaceBaseline population, parity refresh, pre-push review of
   in-flight state, mutation fork+delta, Tier-3 uncommitted review,
   `Handoff.snapshot_ref`, `task-fork` broker plans, live conflict *warnings*.

### 2.1 The granularity model (unifies three conflicting shapes)

The assuming docs want three different granularities. They unify as one store,
three ref layers:

- **One mirror store per (user, repo)** — identity from
  `docs/plans/cloud-mirror-compatibility-changes.md` #7:
  `sandboxId = sha256("${userId}:${repoCanonicalUrl}").slice(0,16)` (pure function,
  planned home `src/lib/sandbox-identity.ts`). Long-lived; real commits accumulate
  here (the pre-push review doc's shape).
- **One ref per session** — `refs/interlinked/sessions/<session-id>`: the snapshot
  chain. This *is* `workspaceBaseline(session_id)` from the pipelined-checks doc:
  the baseline for a session is the tip of its session ref.
- **Fork per receipt** — a cloud check forks from a session ref at a specific
  snapshot commit (the mutation/pipelined shape). Locally the analog is a read-only
  checkout of that commit.

### 2.2 Snapshot semantics: base + overlay

A snapshot does **not** re-hash the whole repo. Each session ref is an independent
chain whose trees contain only the files that differ from a recorded **base**:

- `base_head` = the real repo's `git rev-parse HEAD` at session start, recorded as a
  commit trailer. Committed history is *already* content-addressed and durable in
  the real repo (and, cloud-side, in the mirror/origin) — never duplicated.
- The session tree accumulates: files dirty at session start (captured by the
  session-start reconciliation scan) ∪ files the session edits ∪ files found dirty
  at the Stop/SessionEnd reconciliation scan.
- Full tree state at snapshot T = `base_head` ∪ (session tree at T, which wins per
  path). This is exactly the "content-addressed base + overlay" vocabulary already
  used in `harness-system-diagrams.md`.

Incremental cost per snapshot is O(changed files), because a persistent per-session
git index carries the unchanged entries forward.

### 2.3 Storage-engine sanction (deliberate, not accidental)

`harness-system-diagrams.md` states the substrate invariant "append-only JSONL
throughout (no SQLite)." The tree-log introduces a **third sanctioned engine**: the
git object store, driven via `git` plumbing (`hash-object`, `update-index`,
`write-tree`, `commit-tree`, `update-ref`) with `execFileSync` argv-form (never
shell strings — same safety rules as `assessRollbackFeasibility` in the pipelined
doc: argv form, `--` termination, machine-parseable output).

Why git objects and not another JSONL/CAS: (a) content-addressed + immutable +
hash-chained, which is the exact property set the diagrams doc already requires of
sync/receipt formats ("signable + hash-keyed"); (b) diff/blame/bisect over snapshot
history come free; (c) the cloud mirror becomes literally `git push`, and Cloudflare
Artifacts is a git server — one wire protocol for stub and target; (d) precedent:
`scratchpad-archive.ts` already ships a homegrown CAS (content-addressed blobs +
per-session manifest); tree-log is that pattern upgraded to the standard tool.

The **queryable index stays JSONL**: `.interlinked/tree-log/snapshots.jsonl` is an
append-only projection (one line per snapshot: ts, session, ref, commit, kind,
paths, skips). Rebuildable from the object store; never a second writer.

## 3. Non-negotiables (inherited constraints, with sources)

These are binding on every phase. An implementation that violates one is wrong even
if it works.

1. **The working tree is the source of truth for current content.** The tree-log is
   canonical only for a *new axis* — content history — exactly as `activity.jsonl`
   is canonical for event history but not current state
   (`trajectories-as-primitive.md`: "the event log is the source of truth; the
   derived state is a cache"). No feature may read the tree-log for "what is the
   file now."
2. **Local authoritative; cloud additive** (`harness-system-diagrams.md`: "The cloud
   is additive: local stays authoritative"; `state-substrate-decision.md` Option C).
   The mirror is a projection of the local log; the local log never depends on it.
3. **Never on the decision hot path; never blocks.** Snapshot writes are async,
   post-decision, fire-and-forget, budgeted; failures degrade to a warning (mirrors
   the `astComplexityAvailable()` loud-degrade pattern). Coordination features fail
   open (`feedback_safety_continuity`).
4. **In-session may gate; non-session prior may only inform**
   (`harness-system-diagrams.md` authority rule). Anything the tree-log powers
   *across* sessions or humans — stale-context warnings, live conflict overlap,
   dashboard diffs — is inform-only. Reservations remain the only blocking
   primitive for concurrency.
5. **Daemon owns the store; agents cannot write it.** Same posture as the
   graph-prediction shards' §9 disk-write protection and the scratchpad write guard
   (`evaluator/scratchpad-write-guard.ts`). Load-bearing for anti-gaming: once
   receipts bind to snapshot refs, an agent that could rewrite snapshot history
   could forge evidence — the same threat class `baseline-integrity-gate.ts`
   exists for.
6. **Redaction before egress** (`trajectories-as-primitive.md`: the redaction
   contract "applies before any trajectory leaves the local machine" — content is
   *more* sensitive than trajectory). The mirror push gate secrets-scans every
   outgoing blob; findings abort the push entirely (no partial push). Mirror is
   **off by default**; "code never leaves the machine" remains the free-tier
   default and the ICP-1 differentiator. The mirror is the *paid* trust-boundary
   feature by design.
7. **Deterministic only** (`feedback_harness_deterministic_only`). Everything here
   is hashing, diffing, and counting. No LLM anywhere in the substrate.
8. **Tier 2 is not a consumer.** Tier 2 judges pre-application intent (fresher than
   any snapshot) and depends on an append-only cached prompt prefix that mutating
   tree state would break. Do not route tree state into it.
9. **Never push to the team remote.** The mirror is a distinct remote; the
   implementation refuses a mirror URL that resolves to `origin`. Snapshots are
   machine-grade history and must never pollute human-facing branches.

## 4. Vocabulary (reuse, don't invent)

| Term | Meaning here | Source of the name |
|---|---|---|
| `content_hash` | sha of a file's bytes at an observation point | `trajectories-as-primitive.md` §4.3.1 |
| `derived_from` | the content_hash a write was based on (its read) | same |
| base + overlay | committed `base_head` + session tree of differing files | `harness-system-diagrams.md` |
| fresh / stale / authoritative | snapshot vs moved-on working tree | `graph-prediction-protocol.md` §3/§5 |
| deferred | written locally, mirror push pending | `graph-prediction-protocol.md` §10 |
| reconcile | full-state scan absorbing out-of-hook drift | graph-prediction reveal/reconcile |
| snapshot / session ref / ContentBinding | this doc | new |

## 5. Consumers (who reads it, and in which phase)

**Local-only (Phases 1–2, no cloud):** lost-update recovery (the cohort bug class);
crash recovery / session time-travel; `git bisect` over tool calls ("which tool call
broke the build"); tree-bound R0 receipts (`verify --receipt`); mutation-receipt
binding unification; cross-agent stale-context warnings (§4.3.1); optional: content
hashes replacing mtime freshness keys in graph-prediction (its own flagged
weakness).

**Cloud (Phases 3–4, opt-in):** `workspaceBaseline` population + fork-per-receipt
(pipelined checks); parity-artifact freshness + category-B refresh (disagreement
policy); pre-push reviewers seeing in-flight state (multi-agent review — smallest
step, its Artifacts repo is already designed); mutation runner fork+delta through
its existing provisioner seam; Tier-3 full-repo access + uncommitted review +
snapshot-keyed caching; multiplayer `Handoff.snapshot_ref` (handoffs that carry
bytes), `task-fork` broker plans (provision = fork, deprovision = merge-or-discard),
live cross-cohort conflict *warnings*, dashboard diffs.

**Explicit non-consumers:** Tier 2 (see non-negotiable 8); the reservation blocking
path (reservations stay path-based and authoritative for mutual exclusion); grep
acceleration (the trigram dirty layer already handles in-session content).

## 6. Costs, risks, and their answers

- **Out-of-hook drift** (formatters, human edits, generated files): snapshots record
  *actual disk bytes*, never replayed tool inputs; session-boundary reconciliation
  scans `git status --porcelain -z` and folds drift in. The log is honest by
  construction.
- **Storage growth:** content-addressing dedups identical blobs; per-file size caps
  and binary skip (recorded in the index — no silent truncation, repo principle);
  retention window + `tree-log prune` + auto-prune at SessionStart.
- **Performance:** hashing only changed files per flush (ms-scale); the one full
  scan per session boundary is `git status`-scale. Budgets pinned by a probe in the
  `e2e-stability.mjs` pattern (p99 + RSS).
- **git absent / not a repo:** tree-log disables with one loud daemon-startup
  warning (the `astComplexityAvailable` degrade pattern). Fail-open.
- **Secrets in snapshots:** local store is same-trust-domain as the working tree
  itself (and `.interlinked/` is already the home of activity logs carrying edit
  payloads). Egress is where the risk changes — hence non-negotiable 6.
- **Artifacts is closed beta:** every cloud consumer treats it as swap-behind-seam
  already; the git-remote stub works today; request beta access in parallel
  (standing recommendation).
- **Merge pressure from task-fork:** cheap forks make divergence cheap; merge
  discipline (small tasks, broker-ordered merges, impact-analysis at merge) is the
  control plane's job and is deliberately Phase 4 — the substrate ships without it.

## 7. Relationship to the sibling decisions

- `state-substrate-decision.md` chose: JSONL canonical → derived rebuildable index →
  cloud DO mirror when multiplayer materializes, for **events**. This doc is the
  same C-shape for **content**: working tree + object store canonical locally →
  JSONL projection for queries → git-push mirror when a cloud consumer is real.
- `cloud-mirror-compatibility-changes.md` is the "do these now" seam list for the
  cloud substrate; its items #2 (agent_source enum) and #7 (sandbox identity) are
  prerequisites reused here. Phase 1–2 of this substrate belongs on that same
  "do now" list: it is the content-side seam that plan currently lacks.
- `per-edit-cloud-mutation-testing.md` §10's RepoProvisioner seam is the pattern
  precedent (build the available impl now, stub the gated one, swap behind one
  interface) and becomes a Phase-4 consumer.

## 8. Open questions (tracked, not blocking)

1. Retention defaults (proposed: 20 sessions / 14 days — validate against real disk
   numbers from dogfooding).
2. Should reconciliation also snapshot at Stop (not only SessionStart/SessionEnd)?
   Proposed: yes at Stop, cheap incremental (trajectory persistence already happens
   at Stop).
3. Multi-daemon writes (one daemon per repo is today's invariant; a second
   `--session-id` daemon would race the store) — Phase 1 ships a lockfile and a
   loud skip; revisit if multi-daemon becomes real.
4. Mirror auth for the git-remote stub (deploy key vs token) — per-team choice;
   Phase 3 documents both.
5. Whether `Handoff.snapshot_ref` transfers via the mirror only, or peer-to-peer
   bundles (`git bundle`) for mirror-less teams — Phase 4 decision.

---

*Cross-reference checklist (one line to add to each assuming doc when Phase 1
lands): pipelined-cloud-checks §1.4, cloud-local-disagreement §3, multi-agent
pre-push review §"Artifacts", per-edit mutation §10, multiplayer-control-plane
§"Proposed Cloudflare Mapping", tier-3 §"scope", trajectories §4.3.1,
harness-system-diagrams §3 — each gains: "Tree-state substrate (population/history
of this store): `docs/design/tree-state-substrate.md`."*
