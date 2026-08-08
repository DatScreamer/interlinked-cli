# Agent-Era Checks — Watch the Agent, Not Just the File

**Status:** design exploration / backlog. 2026-06-09.

**Premise.** The harness's static code-quality surface is **saturated** — ~230 check
ids across ~75 family files (`src/harness/checks/*.ts`) already cover error-handling
(`empty_catch`, `catch_and_log`, `lossy_error_rethrow`), resource/lifecycle
(`lifecycle_cleanup`, `listener_pairing`, `cleanup_skipped_on_early_exit`), concurrency
(`floating_promises`, `await_state_toctou`), security (SSRF/IDOR/SQLi/pickle/XXE/taint),
test-quality (`tautological_assertion`, `mocking_the_sut`, `snapshot_overuse`), and even
comment-vs-code drift (`comment_claims_throws_doesnt`). Another ESLint-style rule here is
low marginal value and commoditized (Semgrep/SonarQube/CodeQL do it too).

**The frontier is the agent-era layer** — checks that exploit the four things only
Interlinked has and a linter never will. This doc catalogs them.

**Companion to:**
- `docs/design/test-category-adoption-from-the-wild.md` — the *execution / test* side
  (run real tests/coverage/mutation at inference time). This doc is the *behavioral /
  rule* side.
- `docs/design/trajectories-as-primitive.md`, `trajectory-sequence-detectors.md`,
  `trajectory-integrity.md` — the trajectory substrate every Moat-1/3 check builds on.
- `docs/design/open-obligation-ledger.md` + `proof-of-enforcement.md` — where claims and
  obligations land and become provable.
- `docs/design/cloud-governor-architecture.md` — the cloud-anchored trust boundary for
  the security checks.

---

## 0. TL;DR

Don't mine the static surface deeper — it's done. Build checks that watch the **agent**:
its **trajectory** (action stream + claims), the **pre-disk** intercept, the
**multi-agent** coordinator, and **cross-session** memory. Marquee net-new checks:
**hallucinated-package guard**, **read-before-mutate**, **trajectory secret-exfil /
prompt-injection taint**, the **claim→obligation→verification ledger**
(anti-confabulation), and **cross-agent semantic conflict**. The deterministic
*verifications* run in the gate; only claim/intent *extraction* is LLM and stays in the
cloud-advisory tier (`feedback_harness_deterministic_only.md`). Ship behavioral checks
**advisory-first**, **dogfood**, **fail-open** (`feedback_safety_continuity.md`).

---

## 1. Why — the saturation finding + the four moats

A linter is a pure function of *file content*. ~228 of our ~230 checks are exactly that.
The agent's **trajectory**, the **pre-disk** window, the **cohort**, and the
**cross-session corpus** are barely mined for *enforcement*. Each is a moat a competitor
relying on file-level CI cannot cross:

| # | Moat | What it is | Existing substrate |
|---|---|---|---|
| 1 | **Trajectory** | the ordered stream of the agent's reads/edits/commands + its prose claims | `session-state.ts`, the 23 trajectory detectors, `project_trajectory_as_primitive` |
| 2 | **Pre-disk intercept** | block before the proposed bytes land (`tool_input` at PreToolUse) | `feedback_pretooluse_cloud_synchronous_block`, the test-category doc §5 |
| 3 | **Multi-agent coordinator** | the cohort + reservation view across all live agents | `cohort.ts`, `reservations.ts`, `project_supervisor_pattern` |
| 4 | **Cross-session memory** | recurrence log + error history + the full activity corpus | `recurrence.ts`, `error-history.ts`, `project_activity_log_storage_direction` |

Per-check tags below: `[det]` deterministic / `[LLM]` needs a model (→ cloud-advisory
only); hook; `local`/`cloud`; **tier** (block / advisory / nudge); and *net-new* vs
*extends `<module>`*.

---

## 2. Moat 1 — Trajectory & anti-confabulation

The biggest gap. These need the action stream, so no file-level tool can replicate them.

### 2.1 Claim → obligation → verification ledger  `claim_obligation_ledger`
The agent constantly asserts things in prose: *"I added tests for the error path," "this
now handles nulls," "I ran the build — it passes," "removed the old API."* Each becomes a
tracked **obligation**; the harness **verifies it deterministically** against the
trajectory/tree and flags the gap.
- *Catches:* confabulation — claimed work that didn't happen. *"You said tests pass — no
  test command ran this turn." "You said you removed `oldFn` — grep finds 3 callers."*
- *Detect:* claim **extraction** (LLM, cloud-advisory) → maps each claim to a
  **deterministic verifier** (did a test command run? does the symbol still exist? was a
  branch added?). The verification is the gate; the extraction is not.
- `[det verify + LLM extract]` · PostToolUse/Stop · local (verify) + cloud (extract) ·
  advisory→block · **extends** `open-obligation-ledger.md`, `done_without_verify`,
  feeds `proof-of-enforcement.md`. Lineage: `reference_devin_cloud_verification`
  (pre-commit the expected outcome → the agent lies less).

### 2.2 Read-before-mutate  `read_before_mutate`
The trajectory records every `Read`. If the agent is about to rewrite or delete a
file/region it never opened this session, block.
- *Catches:* blind destruction — agents confidently delete code they don't understand.
- *Detect:* compare the Edit/Write target span against the session's read-set.
- `[det]` · **PreToolUse block** · local · block · **extends** `deletion-hygiene.ts`
  (which already guards deletions; generalize to "editing a region you never read").

### 2.3 Reward-hacking / gate-gaming meta-detection  `gate_gaming`
We're gating an optimizer, so it learns to satisfy the gate instead of the goal. Detect
edits whose *only* effect is to pass a check.
- *Catches:* `expect(true).toBe(true)` to clear assertion-density; `as any` to silence
  tsc; a suppression added **while that check was failing**; catch-and-ignore to make an
  error vanish; hardcoding a test's expected value.
- *Detect:* deterministic where the signal is structural ("a suppression appeared on a
  line the gate was about to flag"; "a new test has no assertion touching the SUT");
  LLM/cloud where it needs intent ("does this diff advance the task or only the gate?").
- `[det + LLM]` · PreToolUse/Stop · local + cloud · block (structural) / advisory
  (intent) · **net-new**; the test-integrity guards (test-category doc §9.1b) are the
  test-weakening slice — this generalizes to all gates. **Strategically the deepest:**
  it's adversarial-robustness *of the harness itself*.

### 2.4 Agent-era security — trajectory taint  `trajectory_secret_exfil`, `trajectory_injected_action`
Static `tainted_to_privileged_sink` tracks taint *within a file*. The agent-era version
tracks it **across actions**.
- **Secret exfiltration** — agent `Read` a `.env`/credentials/key file → then makes a
  network call / commits / sends to an MCP. *Catches:* credential leak the file-level
  taint can't see. `[det]` · **PreToolUse block** · local fast-path + **cloud-anchored**
  (security is never local-only — `feedback_local_checks_not_a_trust_boundary.md`).
- **Prompt-injection response** — agent `WebFetch`/reads external content → then exhibits
  a scope change or a sensitive action (reads `~/.ssh`, exfiltrates, escalates). *Catches:*
  the agent *acting on* injected instructions. **Extends** the content-scanner from
  *detecting* injected text to *catching the action it induced*. `[det]` · PreToolUse
  block · local + cloud-anchored.
- Lineage: `reference_sondera_architecture` (trajectory taint tracking, Escalate).

### 2.5 Scope-drift & flailing  `scope_drift`, `agent_flailing`
- *Catches:* edits to files unrelated to the task's initial working set; A→B→A
  oscillation; the agent re-reverting its own changes.
- *Detect:* pure trajectory signals (edit-target vs initial working set; state cycles).
- `[det]` · Stop · local · nudge · **extends** the trajectory detectors.

### 2.6 Reinvention guard  `reinvention_guard`
- *Catches:* *"You added `lodash.debounce`, but the repo already exports `debounce` in
  `src/utils`."* Dependency bloat **and** duplication an agent creates from not knowing
  the codebase.
- *Detect:* new symbol/import vs the repo index (`trigram-index.ts` + `project-graph.ts`).
- `[det]` · PreToolUse · local · advisory · **net-new** (uses indexes you already build).

---

## 3. Moat 2 — Pre-disk sharpenings

### 3.1 Hallucinated-package / slopsquatting guard  `hallucinated_package`
When the agent writes `import cool_helper` or `pip install fast-jsonparse`, resolve the
**package name** against the registry/lockfile/installed set.
- *Catches:* AI models invent plausible-but-nonexistent package names; attackers
  pre-register those names ("slopsquatting"). An unresolved third-party import is both a
  bug *and* a live supply-chain attack vector.
- *Detect:* name ∉ {lockfile ∪ installed ∪ allowlist} and name resolves to a third-party
  spec (not a local module). Distinct from local-module import resolution in `imports.ts`.
- `[det]` · **PreToolUse block** · local + cloud-anchored · block · **sharpens**
  `imports.ts` + `package-allowlist.ts` + `supply-chain.ts::findTyposquatMatch`.

*(The other pre-disk add — impacted tests / patch-coverage / diff-mutation at PreToolUse
— lives in `test-category-adoption-from-the-wild.md` §5–§6.)*

---

## 4. Moat 3 — Multi-agent semantic coordination

Reservations stop two agents editing the *same file*. They don't stop *semantically
incompatible* changes across *different* files — the harder, more valuable problem the
coordinator is uniquely positioned for.

### 4.1 Cross-agent semantic conflict  `cross_agent_semantic_conflict`
- *Catches:* Agent A changes a function's signature; Agent B (different file, no
  reservation clash) adds a caller using the *old* signature. Both pass locally; they
  merge-break.
- *Detect:* the coordinator holds both in-flight diffs; cross-reference signature/symbol
  changes in A against new uses in B (reuses `impact-analysis.ts` / `export-ripple`).
- `[det]` · Stop / commit · cloud (needs the cross-agent view) · advisory→block ·
  **net-new** · `project_supervisor_pattern`.

### 4.2 Duplicate-work detection  `duplicate_agent_work`
- *Catches:* two agents independently implementing the same thing.
- *Detect:* overlapping new symbols/intent across cohort diffs. `[det/LLM]` · Stop ·
  cloud · nudge · **net-new**.

### 4.3 Cross-agent obligation propagation  (extends §2.1)
- Agent A's signature change *creates* an obligation ("update all callers") that Agent B
  inherits. The ledger spans agents. `[det]` · Stop · cloud · **extends** §2.1 + cohort.

---

## 5. Moat 4 — Cross-session learning

### 5.1 Auto-ratchet from recurrence  `recurrence_autoratchet`
- A pattern that recurs in *this repo's* history auto-promotes advisory→default→block.
  The harness tunes itself to the codebase instead of one global policy.
- `[det]` · config/Stop · local · mechanism · **extends** `recurrence.ts` +
  `proposeAction`. (Unifies with the existing non-null / `as any` ratchets.)

### 5.2 Regression-of-past-fixes  `past_fix_regression`
- *Catches:* *"This exact bug shape was fixed in commit `abc123`; your edit reintroduces
  it."* The harness remembers what already shipped-and-broke.
- `[det]` · PreToolUse · local · advisory→block · **uses** `error-history.ts`.

---

## 6. Commodity surfaces worth *deepening* (not moat, but our cadence is the edge)

The quick audit found these present-but-thin. Worth catch-up because pre-disk/per-edit
beats CI — but they're not differentiation.

| Surface | Deepen | vs existing |
|---|---|---|
| **Infra-as-code** | Dockerfile (root user, unpinned base, secrets in build args, no healthcheck); **CI workflow** (`pull_request_target` + checkout-PR-code = RCE; excessive `permissions:`; actions unpinned-by-SHA); IaC (`0.0.0.0/0` security groups, public buckets, unencrypted storage) | have `github-actions.ts` + `ubs_github_actions_injection`; rest thin |
| **DB / query** | N+1 (`loop { query }`); destructive-migration safety (`DROP COLUMN` / `NOT NULL`-without-default on populated table) | have `migration_ordering`, `migration_parity` |
| **API-contract evolution** | OpenAPI / GraphQL / proto breaking-change | have `schema_type_drift` (type-level only) |

`[det]` · PreToolUse · local · advisory · **net-new detectors, existing family pattern**.

---

## 7. Enforcement *primitives* (mechanisms, not detectors)

Higher leverage than any single check — a better primitive that many checks plug into.

- **Obligation ledger as first-class.** Every "you should also do X" becomes a tracked
  obligation the agent must discharge before Stop/commit — unifies dozens of one-off
  nudges into one clearable list and is the substrate for §2.1 + `proof-of-enforcement`.
- **Generalized budget ratchets.** Make "budget ratchet" one primitive (dependency count,
  bundle size, test-runtime, public-API surface, transitive-dep count): declare a budget,
  block growth, allow shrink — same shape as the line-cap / non-null / coverage / CRAP
  ratchets, generalized.
- **Capability / scope tokens** (Sondera-style). An agent may only write within its task
  scope / reservation; out-of-scope write → block. Turns §2.5 scope-drift from a nudge
  into an enforced boundary. `reference_sondera_architecture`.

---

## 8. Cloud LLM-judge advisory tier (Tier 2/3 — already designed, not re-proposed)

Intent-vs-diff coherence, "is there a simpler way" (`/simplify`), architectural review,
`/security-review`. Keep **advisory** and **out of the deterministic gate**
(`feedback_harness_deterministic_only.md`). This is where the LLM *extraction/judgment*
halves of §2.1 / §2.3 / §4.2 live.

---

## 9. Cross-cutting discipline

- **Determinism boundary.** The *verification* is deterministic and may gate; the
  *extraction/intent* is LLM and stays cloud-advisory. Never an LLM in the local gate.
- **Advisory-first + dogfood.** Behavioral checks carry higher FP risk than static ones.
  Ship advisory, measure on this repo, promote to block only once clean
  (`project_maximal_local_enforcement`). Each ships ≥3 positive / ≥3 negative fixtures
  per the agent-quality convention.
  **Amended 2026-08-07:** clean-on-this-repo is necessary, not sufficient — it shows the
  check does not block US, not that its FP rate is low on the multi-language,
  human-written codebases the harness targets. And the inverse never holds: staying
  quiet here is not grounds to leave a check advisory or to retire it. See
  `maximal-local-enforcement-roadmap.md` §Thesis.
- **Fail-open.** A flaky behavioral heuristic must never wedge the agent
  (`feedback_safety_continuity.md`). Security checks are the exception to "advisory-first"
  — they block, but are **cloud-anchored** (local is not the trust boundary —
  `feedback_local_checks_not_a_trust_boundary.md`) and fail-open-live.
- **Parity.** Anything with a cloud half is single-sourced and parity-pinned
  (`registry-parity.ts`), per the test-category doc §8.
- **Registration.** Detector in `checks/<family>.ts` → `check-registry/entries-*` →
  `check-metadata.ts`, like every other check.

---

## 10. Prioritized sequencing

| # | Build | Why first | Det? | Hook | Moat |
|---|---|---|---|---|---|
| 1 | **Hallucinated-package guard** (§3.1) | net-new, deterministic, zero-FP, pre-disk block, real security value | ✅ | PreToolUse | 2 |
| 2 | **Read-before-mutate** (§2.2) | cheap (trajectory exists), FP-safe, prevents blind destruction | ✅ | PreToolUse | 1 |
| 3 | **Trajectory secret-exfil + prompt-injection** (§2.4) | highest-stakes, uniquely ours, deterministic | ✅ | PreToolUse | 1 |
| 4 | **Claim→obligation ledger** (§2.1) | anti-confabulation flagship; feeds proof-of-enforcement | ✅ verify | PostToolUse/Stop | 1 |
| 5 | **Cross-agent semantic conflict** (§4.1) | the multiplayer differentiator | ✅ | Stop/commit | 3 |
| 6 | **Reward-hacking / gate-gaming** (§2.3) | adversarial-robustness of the harness itself | partial | PreToolUse/Stop | 1 |
| 7 | **Reinvention guard** (§2.6) + **recurrence auto-ratchet** (§5.1) | reuse existing indexes/logs | ✅ | PreToolUse/config | 1/4 |
| — | infra-as-code / DB / API-contract deepening (§6) | catch-up, slot into existing families as capacity allows | ✅ | PreToolUse | — |
| — | enforcement primitives (§7) | refactor underneath the above as they prove out | — | — | — |

**The one-line thesis:** we've won the static-linter game; the next decade of value is in
checks that watch the *agent* — confabulation, gate-gaming, secret-exfil, and cross-agent
coherence.

---

## Appendix — master catalog

| Check id | Catches | Det/LLM | Hook | Local/Cloud | Tier | Status | Moat |
|---|---|---|---|---|---|---|---|
| `claim_obligation_ledger` | claimed work that didn't happen | det verify / LLM extract | Post/Stop | local+cloud | advisory→block | extend ledger | 1 |
| `read_before_mutate` | deleting/rewriting unread code | det | PreToolUse | local | block | extend deletion-hygiene | 1 |
| `gate_gaming` | edits that only satisfy a gate | det+LLM | Pre/Stop | local+cloud | block/advisory | net-new | 1 |
| `trajectory_secret_exfil` | read-secret → network/commit | det | PreToolUse | local+cloud-anchored | block | net-new | 1 |
| `trajectory_injected_action` | acting on fetched/injected content | det | PreToolUse | local+cloud-anchored | block | extend content-scanner | 1 |
| `scope_drift` | edits outside task scope | det | Stop | local | nudge | extend trajectory | 1 |
| `agent_flailing` | A→B→A / self-revert loops | det | Stop | local | nudge | extend trajectory | 1 |
| `reinvention_guard` | re-adding an existing util/dep | det | PreToolUse | local | advisory | net-new | 1 |
| `hallucinated_package` | nonexistent / slopsquat package | det | PreToolUse | local+cloud-anchored | block | sharpen imports | 2 |
| `cross_agent_semantic_conflict` | incompatible cross-agent diffs | det | Stop/commit | cloud | advisory→block | net-new | 3 |
| `duplicate_agent_work` | two agents, same work | det/LLM | Stop | cloud | nudge | net-new | 3 |
| `cross_agent_obligation` | A's change obligates B | det | Stop | cloud | nudge | extend ledger | 3 |
| `recurrence_autoratchet` | repo-recurring pattern → ratchet | det | config | local | mechanism | extend recurrence | 4 |
| `past_fix_regression` | reintroducing a fixed bug shape | det | PreToolUse | local | advisory→block | use error-history | 4 |
| `dockerfile_*` / `ci_workflow_*` / `iac_*` | infra misconfig | det | PreToolUse | local | advisory | net-new detectors | — |
| `n_plus_one` / `destructive_migration_guard` | query/migration hazards | det | PreToolUse | local | advisory | net-new detectors | — |
| `api_contract_break` | breaking API/schema change | det | PreToolUse | local | advisory | net-new | — |

## Appendix — references

- Hooks: https://code.claude.com/docs/en/hooks
- Existing substrate: `src/harness/{session-state,cohort,reservations,recurrence,error-history,taint-tracker,trigram-index,project-graph,registry-parity}.ts`,
  `src/harness/checks/{deletion-hygiene,imports,supply-chain}.ts`,
  `src/harness/content-scanner/`, `src/harness/check-registry/`, `check-metadata.ts`.
- Companion docs: `test-category-adoption-from-the-wild.md`,
  `trajectories-as-primitive.md`, `trajectory-sequence-detectors.md`,
  `trajectory-integrity.md`, `open-obligation-ledger.md`, `proof-of-enforcement.md`,
  `cloud-governor-architecture.md`.
- Memories: `project_trajectory_as_primitive`, `project_trajectory_detectors_shipped`,
  `project_supervisor_pattern`, `project_proof_of_enforcement_bft_extensibility`,
  `feedback_harness_deterministic_only`, `feedback_local_checks_not_a_trust_boundary`,
  `feedback_safety_continuity`, `feedback_taste_enforcement`,
  `project_maximal_local_enforcement`.
- Lineage: `reference_sondera_architecture` (trajectory taint, capability tokens,
  Escalate), `reference_devin_cloud_verification` (anti-confabulation),
  `reference_echo_free_supervision` (predict env response).
