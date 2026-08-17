# 24. Cloud mutation runner — the deterministic substrate, parallelized

**Status:** decision record + build plan, 2026-08-16. **Nothing built beyond M0.**
Numbered 24 because plan 21 §0 already reserves 22–23 for its pending renumber of
the two colliding `20-*` memos — this document must not create a third collision.

**Provenance.** Every architecture choice and product decision here was made in
the 2026-08-16 working session; the measured numbers were produced by that
session's campaign (sources inline). Cloudflare product capabilities were
**fact-checked against the live product docs on 2026-08-16** (15 claims; a
research agent's verdict list, reproduced in §7's corrections): tags below are
**[verified]** (live docs or skill docs confirm), **[corrected]** (our first
draft was wrong; the text now states the checked fact), and
**[verify-at-build]** (not documented anywhere found — test it, do not assume
it). Nothing in the last category is load-bearing for M1's start.

---

## 0. One paragraph of thesis

The mutation campaign's binding constraints were never intelligence — they were
**measurement throughput** (two LAN boxes, one Stryker slot each), **state
freshness** (long-lived runner worktrees that silently went six commits stale),
and **model-API rate windows**. The cloud runner removes the first two
structurally and turns the third into a config value. The platform itself stays
**deterministic compute only** — measure, prove, ledger, receipts. No model
call happens inside the platform in the primary mode; customers bring their own
agents. That separation is the product: agents are interchangeable and
benchmarkable against it; the substrate is not.

---

## 1. Why now — the evidence from the local campaign

Three incidents this week are the design brief:

1. **Stale runner worktrees (2026-08-16).** Both LAN runners sat six commits
   behind HEAD. Graph-scoped tests imported modules the runner checkouts did
   not have; dry runs died as `ENOENT mutation.json`; a day of sweep budget
   burned on junk failures, and one degraded measure recorded a **false 0 → 122
   survivor regression** before the cause was found. A long-lived worktree is
   mutable shared state with no declared version. The fix class is per-job SHA
   pinning (§3.2) — under it this incident is structurally impossible, because
   the measured commit is declared by the job and recorded in provenance, never
   inherited from whatever a directory happened to contain.
2. **The daemon restart storm (2026-08-15/16, postmortem in
   `scratch/fleet-r3/repair-followups.txt` #19–#25).** Root causes included the
   44MB manifest being re-parsed inside the daemon (~1.7GB transient heap per
   Stop). The landed fix — the **survivors-index sidecar**
   (`src/harness/mutation/survivors-index.ts`, 427KB vs 43MB, written
   atomically with every manifest persist; measured: three Stop events now cost
   +128KB RSS) — is the local precursor of this plan's DO ledger (§3.4): a
   small, always-consistent fold beside a large authoritative record.
3. **Throughput arithmetic (§5).** At two single-slot boxes the remaining
   campaign is weeks; the work is embarrassingly parallel at both the agent and
   the measure level, so wall-clock at ~100-way parallelism collapses to about
   a day. Local hardware cannot get there; a sandbox fleet can.

---

## 2. Product decisions (set by the operator, 2026-08-16)

These are decisions, not options. Revisit them only with the operator.

- **D1 — BYO agents is the primary mode.** Customers' own agents (Claude Code,
  Codex, Gemini CLI, anything speaking the runner protocol) connect to the
  substrate exactly the way the local fleet talks to the two-box runner today:
  `{file, overlayContent, overlays[]} → mutation.json`, at larger N. No
  platform-side model dependency in this mode.
- **D2 — AI Gateway is off the critical path.** It returns only in an optional
  **factory mode** (platform-supplied agents), where it earns its place as the
  model-choice knob — Sonnet / Terra / Luna / Flash / customer key — plus
  fallback chains, caching, and per-file/per-tenant cost attribution feeding
  the eval telemetry. Factory mode is M3, not MVP.
- **D3 — Dynamic Worker Loaders are not for the runner.** Stryker is a heavy
  Node process; it needs containers, not isolates. Loaders (and
  dynamic-workflows) are the substrate for the **Tier-2/3 policy product** —
  per-tenant customer check/policy code running per-event in isolates. That
  belongs to the three-tier enforcement docs
  (`docs/design/tier-2-llm-policy-gate.md`, `tier-3-async-deep-review.md`);
  this plan only cross-references it.
- **D4 — The round-loop is also the agent eval.** Each round's per-file
  kill-delta measures the connected agent. Calibration data from the local
  campaign (measured 2026-08-16): pass-1 yield on unworked heavy files is
  **~85–90%** (W9: 546/604); fresh-eyes pass-2 yield on prover-resistant
  residue is **~3%** (6 measured kills of 205 worked; the other ~97% were
  re-confirmed equivalent with proof-grade arguments). Consequence for round
  design: pass-2 routes to **adjudication** (disposition records), not to
  repeated kill attempts. The same numbers, computed per customer agent, are
  the benchmark product.

---

## 3. Architecture

The stack is deliberately small, and every piece is deterministic compute:

| Concern | Product | Why this one |
|---|---|---|
| Orchestration | **Workflows v2** | Durable rounds across crashes/days [verified: 50K concurrent/account (waiting instances don't count), 2M queued/workflow, "can run forever"; creation caps 300/sec **per account** and 100/sec **per workflow class** — corrected: shard classes or fan out as steps] |
| Repo delivery | **Artifacts + sandbox snapshot restore** | Per-job SHA via git checkout after clone/restore [verified: `ref` accepts a commit hash on the read side; **corrected: create/fork/import pin branches only — the SHA pin is a checkout step, not a control-plane field**]; `createBackup()`/`restoreBackup()` snapshots skip repeated clone+install [verified] |
| Execution | **Sandbox SDK + Containers** | Per-file Stryker in isolation [verified: `sandbox.exec` — **set an explicit `timeout`; there is no default**]; sizes up to `standard-4` (4 vCPU/12GiB); ~1,500 vCPU account ceiling [verified; **corrected: no `heavy` tier exists**] |
| Ledger | **One Durable Object per repo** | Serializes manifest folds — merge-safe by construction [verified headroom: a DO handles ~500–1,000 simple req/sec; folds arrive at minutes-per-measure rates] |
| Blobs | **R2** | Raw `mutation.json`, receipts, round reports |
| Rate governance | **Queues + token-bucket DO** | Smooths model-API TPM [verified: pull consumers 5,000 msg/sec/queue; push figure verify-at-build]; shard the bucket DO if it approaches the req/sec ceiling |
| Egress | **sandbox-auth Outbound Workers** | Zero credentials in sandboxes [verified: handlers run outside the sandbox with binding access]; **corrected: interception covers HTTP/HTTPS 80/443 only — block everything else with `enableInternet=false`**; export `ContainerProxy` or interception fails silently |

### 3.1 Orchestration — Workflows v2

One durable **campaign workflow per repo**. Each round is a phase: fan out
per-file measure jobs, collect, decide routing (kill-wave vs adjudication per
D4), repeat. Two verified facts shape the fan-out design:

- **There is no child-workflow join.** [corrected] A workflow can `create()`
  instances of another workflow class from inside a `step.do()`, but the
  parent "continues execution immediately" — children run independently, and
  fan-in must be built by hand (child `sendEvent` → parent `waitForEvent`).
  For per-file measures the simpler shape is therefore **steps, not
  children**: a step awaiting a sandbox exec is I/O wait, and the step CPU cap
  (30s default, configurable to 5 min **active CPU**, not wall-clock) easily
  covers a minutes-long measure whose work happens in the sandbox. The
  step-count ceiling (10,000 default, 25,000 max per instance) bounds one
  campaign instance at roughly 8,000 file-measures per round-trip-heavy
  design — fine for one round over this repo, so use one workflow instance
  per **round**, not per campaign, if step budgets get tight.
- **Waiting instances do not count toward the 50K concurrency cap**
  [verified], which makes `step.waitForEvent` cheap as the human gate — the
  first consumer is dead-code **removal approval**, which the local campaign
  already established must be a human decision with a recorded disposition.
  Default `waitForEvent` timeout is 24h; its maximum is undocumented
  [verify-at-build] (`step.sleep` supports 365 days, so long gates have an
  escape shape).

Rounds surviving crashes and days matters because campaigns are days-long by
nature; today that durability lives in one orchestrator session's context
window, which is the weakest link in the current system.

### 3.2 Repo delivery — pinned SHAs via snapshot + checkout

Every measure job declares the commit SHA it measures. The fact-check
[corrected] the first-draft mechanism, and the corrected one is simpler:

- **The pin is a git checkout, not a control-plane field.** Artifacts'
  create/fork/import accept branches only; the read side accepts a commit hash
  (`ref`), and remotes are standard git-over-HTTPS — so the sandbox pins by
  `git checkout <sha>` after clone/restore, and that SHA goes into the job
  receipt.
- **The fast path is `createBackup()`/`restoreBackup()`** [verified — the
  changelog motivates it with exactly our case: skipping repeated
  `git clone` + `npm install`]. One warm snapshot per repo holds the tree and
  `node_modules`; each job restores it, fetches, checks out its SHA, applies
  overlays. This de-risks M1 completely.
- **ArtifactFS is demoted to an M2+ experiment** [corrected — the weakest
  claim in the draft]: it is a Go CLI plus FUSE daemon, not an API; no Sandbox
  SDK integration exists; FUSE is production-only (absent in `wrangler dev`);
  read-only-vs-writable semantics and SHA addressing are undocumented. If it
  matures into a mountable, SHA-addressable layer it replaces the snapshot
  path for very large repos; nothing in M1 waits on it.

The job then applies its **overlays** — the same overlay set the two-box
protocol ships today (target file content, companion tests, graph-scoped
tests, dep closure). The measured SHA is recorded in the manifest's
`MeasurementProvenance` (the field shape exists; add the SHA field at M1).
Survivor counts are only comparable when both their scope **and their base
SHA** match — extending the provenance rule the local system already enforces
for scope.

### 3.3 Execution — Sandboxes + Containers

The Sandbox runs the exact contract of `scratch/two-box-runner/runner.mjs`:
apply overlays, `stryker run --mutate <file>` under the repo's own
`stryker.conf.json` + `vitest.stryker.config.ts`, return `mutation.json`.
**Measured precedent:** the earlier cloud lane ran this in a Worker-driven
Sandbox and killed 34/34 mutants
(`project_mutation_worker_sandbox_deploy`). Containers provide the warm pool —
images with `node_modules` and the Stryker toolchain baked in. At 100-way
parallelism, warm-vs-cold start is roughly the difference between a one-hour
and a three-hour full-repo sweep. Per-test dry-run cap stays 30s (the local
value, deliberately kept — see the slow-test detector rationale).

### 3.4 Ledger — one DO per repo

The single genuinely serial resource in the whole system is the manifest fold.
A Durable Object per repo owns it: measure results arrive concurrently, the DO
applies `applyMeasuredRun` folds one at a time, and writes the survivors-index
sidecar in the same operation (the local invariant, kept). Everything else —
blobs, receipts, round reports — is append-only in R2 and needs no
coordination. Multi-tenant later: DO Facets give each tenant an isolated
SQLite owned by a supervisor DO [verified] — and the skill docs position
facets as an **alternative to** the Workers-for-Platforms dispatch-namespace
pattern for multi-tenancy, not a layer under it [corrected]; single-tenant
MVP needs neither.

### 3.5 Rate governance — Queues + token-bucket DO

Applies to factory mode (platform-billed model calls) and, optionally, as a
courtesy limiter for BYO fleets that ask for it. The token bucket smooths TPM
against the model API tier so a 100-way fan-out degrades to queuing, never to
429 storms. This is the component that converts §5's "rate-limit windows"
constraint into a dial.

### 3.6 Egress — sandbox-auth Outbound Workers

Sandboxes hold zero credentials. Outbound Workers inject what a job needs and
deny everything else; the allowlist is registry-only by default. This is the
cloud mirror of interlinked's own supply-chain gate — **the product enforces
on its infrastructure what it enforces in the customer's repo**, which is both
correct engineering and the marketing sentence.

### 3.7 Observability + receipts

Workers Analytics (plus Gateway logs in factory mode) feed the existing viz
dashboard feeds. Every measure result is returned as a **signed receipt**
(job, SHA, scope, verdict, timings), which slots directly into the
proof-of-enforcement ladder at R1 (cloud-signed) — the ladder the roadmap
already defines, with R2/BFT unchanged and PoW still never.

---

## 4. M0 — what already exists (all measured, nothing aspirational)

- The runner **protocol** and overlay scoping (`computeMutationTestScope`,
  `buildScopedMeasureOverlays`), hardened this week: companion tests now ship
  even when the graph scope is over cap (the `trajectory.ts` 137→39 fix).
- **Provenance stamping** (`MeasurementProvenance`) with the
  scope-comparability rule; SHA field is a one-line extension.
- The **cloud validation**: Worker-driven Sandbox measured files and killed
  34/34 mutants in the earlier lane.
- The **survivors-index sidecar** — the DO-fold's local precursor, live since
  2026-08-16 (427KB, +128KB per three Stop events, 105× smaller than the
  manifest).
- The **disposition store** (M0+M1, 713 records) — the adjudication surface
  D4's routing depends on, with its anti-gaming guard under
  `baseline_integrity_gate`.
- Engine scaffolding: root `stryker.conf.json` + `vitest.stryker.config.ts`,
  declared-operator pinning, the 30s dry-run cap.

## 5. Capacity model (bottom-up, measured constants)

Repo state at writing: **816 files, 133,381 mutants, 112,593 killed (84.4%),
18,398 survivors** (66 files ≥50; 330 files 20–49; 286 files 5–19; 79 files
1–4), 2,390 uncovered. Unit costs, measured this campaign: one agent-run 30–40
min wall and 200–335k tokens; one per-file measure 1–4 min.

Work ledger ≈ **800 agent-runs**: pass-1 on heavy files 396; mid-bucket
batches 96; tail batches 8; uncovered/coverage batches ~30; adjudication
batches ~110; pass-2 kill attempts cut to a remnant by D4's 3% datum
(originally modeled at 156).

| Deployment | Wall-clock | Governor |
|---|---|---|
| Two LAN boxes (today) | weeks | model-API rate windows + 2 measure slots |
| Cloud, ~100-way | agent wall ≈ 5h; measure sweep <1h/round; 3 rounds ≈ **6–12h** | model-API tier + ≈$700–1,200 of Sonnet-class tokens (~220M) |

State plainly: **the binding constraint is model-API throughput, never
platform compute.** The platform's own cost (sandbox-hours, DO ops, R2) is
negligible against the token line. This is also the demo: "133k mutants, 816
files, mutation-hardened in a day" is the launch benchmark run.

## 6. Milestones

- **M1 — Sandbox measure service** *(build first)*: port the runner contract
  to Sandbox exec; Artifacts-pinned delivery (mount if ArtifactFS proves out,
  archive otherwise); SHA into provenance; single-repo, single-tenant.
- **M2 — Workflow driver + DO ledger**: campaign workflow, per-file fan-out,
  DO fold + sidecar, Queues/token-bucket; the BYO connection contract
  documented as the public protocol page.
- **M3 — factory mode + multi-tenant**: Gateway-routed platform agents,
  per-tenant DO Facets (or the W4P dispatch pattern — decide then), signed
  receipts wired into proof-of-enforcement R1.

Estimate given M0: **MVP (M1+M2, single-tenant) ≈ 2–4 focused sessions.**

## 7. Open questions and fact-check corrections

**Corrections applied from the 2026-08-16 live-docs fact-check** (15 claims
checked; the three that mattered):
1. **ArtifactFS** is a CLI + FUSE daemon with undocumented read/write and SHA
   semantics — demoted from the M1 path to an M2+ experiment (§3.2); the
   snapshot-restore + checkout path replaces it.
2. **No child-workflow join exists** — the parent never awaits a child;
   fan-out is steps, fan-in (if children are ever used) is hand-built via
   `sendEvent`/`waitForEvent` (§3.1).
3. **Creation is capped 100/sec per workflow class** (not just 300/sec per
   account); outbound interception covers **ports 80/443 only** (pair with
   `enableInternet=false`); the `heavy` sandbox tier **does not exist** —
   real tiers run `lite` → `standard-4` (4 vCPU / 12 GiB).

**Still open (verify at build time):**
1. `sandbox.exec` sizing for Stryker: pick the tier empirically
   (`standard-2`/`standard-3` are the candidates); always set an explicit
   `timeout` — there is no default.
2. `waitForEvent` maximum duration (default 24h is documented; the max is
   not).
3. Queues **push**-consumer throughput (pull is documented at 5,000
   msg/sec/queue).
4. **DO fold throughput** at 100-way result arrival (documented headroom
   ~500–1,000 req/sec makes this near-certain, but measure it).
5. **Receipt schema + signing** for R1: reuse the sponsor feed's Ed25519
   pattern or the enforcement-ledger's; decide at M2.
6. Whether the **courtesy limiter** (§3.5) should be default-on for BYO
   fleets; default-off preserves the "your agents, your budget" stance.
7. Analytics Engine bindings do not work in local dev — plan the M2 test
   harness around that gotcha.

## 8. Cross-references

`docs/design/per-edit-cloud-mutation-testing.md` (the per-edit spec this
generalizes; its runner contract is M1's source), `docs/plans/06-cloud-metrics-program.md`
(deferred cloud lanes; this plan supersedes its mutation lane),
`docs/design/mutation-residue-ledger.md` + `docs/design/round2-routing.md`
(the adjudication semantics D4 routes into), plan 19/DISPOSITION (the
registration surface), `docs/design/tier-2-llm-policy-gate.md` (D3's home),
and `scratch/fleet-r3/repair-followups.txt` #19–#26 (the incident record that
motivated §1).
