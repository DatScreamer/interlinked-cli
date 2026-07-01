<!-- Generated 2026-06-27 by a multi-agent validation campaign (9 datasets recon'd, 8 empirical pilots, ~1000 trajectories). Measured feature->outcome correlation for the deterministic trajectory rules. Companion to deterministic-trajectory-rules.md + .interlinked/qwen-train/scripts/autolabel.py. -->

# Measured-Validation Report — Interlinked Deterministic Trajectory Rules

**Status:** design doc / kept artifact · **Scope:** 233 deterministic trajectory rules (11 families) + 10 security sequence blocks · **Method:** dataset recon → streaming empirical pilots (n≈200/dataset) → feature→outcome correlation against per-trajectory success labels.

---

## 1. Headline

**8 of 9 recon'd datasets ran real empirical pilots; the 9th (`reverted_commits`, git lane) is recon-only (placeholder run).** Five coding datasets streamed full action streams with per-trajectory `resolved` labels; three security datasets were exercised but two of three lack the argument-level or full-stream substrate to discriminate.

**The single most important measured result:** *Yes — our reasoned-but-previously-unmeasured deterministic "bad-trajectory" features correlate with task failure on diverse cross-project agent traces, in the predicted direction, with zero direction reversals among the instrumentable churn/verification signals.* Across the five coding datasets (1,000 trajectories total), every "bad signal" in Families 1 (Churn/Thrash) and 7 (Verification Discipline) was elevated in *unresolved* trajectories whenever the dataset had variance to measure it. The two strongest, most reproducible separators:

- **No-verifier-observed** (`no_verify_flag`) — the single best deterministic failure predictor: resolved runs verify 88% of the time, unresolved only 48% (**4.4× separation**, `agent_traj_4000`); ~2× separator in `swe_smith`.
- **Region-revert / literal-undo** (`region_revert_count`) — **~2.2–4×** higher in failures across `open_swe_traces`, `swe_gym`, `agent_traj_4000`; the strongest *churn* separator.

**The equally important negative result:** Family 2 (Scope-Creep) features do **not** predict failure and in places **invert** (resolved trajectories touch *more* files / top-dirs). This empirically confirms the catalog's design decision to keep all scope-creep rules at **nudge/metric, never block** — breadth ≠ drift on real fixes. And the naive `thrash_files` count (no FP guard) reversed, empirically confirming that the `churn_*` rules' "no green between / failing intervening check" composition guards are **load-bearing**, not decorative.

**Honest caveat up front (distribution shift):** every coding corpus is a SWE-bench-style *batch scaffold* (patch-style, near-100% verifier base-rate, single-task, single-checkout-root). This is a different distribution from interactive Claude Code (multi-agent, IDE reads, feature-build, under-verification common). Outcome granularity is **episode-level `resolved`**, not per-edit — so these pilots validate *direction and population separation of trajectory-aggregate features*, not the per-edit firing precision the live harness actually ships.

---

## 2. Per-coding-dataset measurement tables

All five coding datasets are **accessible** and carry a **full action stream** (normalized to `ToolEvent[]` via a per-dataset adapter). Outcome label is per-trajectory `resolved` (1/true = solved, 0/false = unsolved). "R" = mean over resolved, "U" = mean over unresolved.

### 2.1 `open_swe_traces` — n=200 (config: openhands/sweagent × model split; mean 88.7 msgs, 11.3 edits/episode)

| Feature | R | U | Predicts failure | Notes |
|---|---|---|---|---|
| `region_revert_count` | 0.083 | 0.353 | **yes (~4×)** | Strongest churn separator, corr +0.159. Validates `churn_literal_edit_revert`, `churn_revert_after_check_fail_combo`, `reb_blind_edit_then_revert`. |
| `repeated_failing_command` | 0.183 | 0.441 | **yes (~2.4×)** | Validates `churn_repeated_failing_bash`, `churn_rerun_failing_test_no_source_change`. |
| `revert_churn_ratio` | 2.217 | 2.893 | weak | corr +0.152, modest. Validates Family-1 churn-ratio intuition. |
| `thrash_files_gt3` | 0.650 | 0.824 | weak | corr +0.095. Direction-correct for `churn_*_rewrite` rules. |
| `edits_without_verification` | 0.583 | 0.686 | n/a | 94% verify base-rate → near-zero variance; **untestable, not invalidated**. |
| `scope_distinct_files` | 5.483 | 5.343 | no | Flat (corr −0.017). |
| `scope_distinct_topdirs` | 4.667 | 3.225 | **inverts → success** | corr −0.192: resolved touch MORE top-dirs. Confirms Family 2 stays nudge/metric. |
| `obligation_opens_net` | 1.300 | 0.186 | no | Only 6% firing; mild inversion. |

### 2.2 `swe_gym` — n=200 (15 resolved / 185 unresolved; avg 13 events, 2.7 edits/traj)

Headline of this dataset: a **base-rate confound that inverts the naive correlation then resolves it** — empty-generation trajectories inflate raw churn in *resolved*, so all effects are reported on the **active subset** (trajectories that actually edited).

| Feature | R (active) | U (active) | Predicts failure | Notes |
|---|---|---|---|---|
| `repeated_failing_command` | 0.067 | 0.198 | weak (~3×) | Cleanest separator on this corpus. |
| `region_revert_count` | 0.13 | 0.36 | weak (~2.7×) | Validates literal-revert substrate. |
| `thrash_files_gt3` | 0.20 | 0.48 | weak (~2.4×) | |
| `revert_churn_ratio` | 2.06 | 2.64 | weak | RAW population **inverts** (empty-gen confound). |
| `edits_without_verification` | 4.33 | 4.56 | no | Only 14/101 active ran any verify → under-verification is population-wide. |
| `scope_files` | 2.13 | 2.06 | no | Narrow single-file fixes; no scope headroom. |
| `scope_dirs` | 1.00 | 1.01 | no | ~1 dir/traj; never fires. |
| `obligation_opens_net` | 0.0 | 0.0 | n/a | **Identically zero across all 200** — bug-fix corpus emits no TODO/skip/stub. |

*Power caveat: only 15 resolved trajectories → active-subset effects are indicative, not significant.*

### 2.3 `agent_traj_4000` — n=200 (17 resolved / 183 unresolved; 1,257 edits, 1,776 bash cmds)

| Feature | R | U | Predicts failure | Notes |
|---|---|---|---|---|
| `no_verify_flag` (binary: ran NO verifier at all) | 0.118 | 0.519 | **yes (4.4×)** | **Strongest, length-robust signal.** Validates Family 7 + `fanout_without_verification`. |
| `repeated_failing_command` | 0.059 | 0.279 | **yes (4.7×)** | Highest ratio but rare (3.5% firing) → high precision, low recall. |
| `edits_without_verification` | 0.824 | 2.421 | **yes (2.9×)** | Partly length-confounded; the binary flag confirms it's real. |
| `region_revert_count` | 0.647 | 1.443 | **yes (2.2×)** | Validates `churn_literal_edit_revert`, `churn_sha_cycle_revisit`. |
| `revert_churn_ratio` | 2.206 | 2.720 | weak (1.23×) | Needs a co-firing guard. |
| `scope_dirs` | 1.588 | 1.617 | weak (flat) | No separation. |
| `thrash_files` (>3, no guard) | 0.412 | 0.372 | **no (REVERSED)** | Bare count is non-discriminative → FP guards are load-bearing. |
| `scope_files` | 2.647 | 2.240 | **no (REVERSED)** | Resolved edit MORE files (thorough fix). |
| `obligation_opens_net` | 0.000 | 0.011 | n/a | Fired 1/200; patch-style corpus unexercised. |

### 2.4 `swe_rebench_oh` — n=200 (107 resolved / 93 unresolved) — qualitative effect sizes

Adapter mapped OpenHands tool calls (`execute_bash`/`execute_ipython_cell`→Bash, `str_replace_editor`→Read/Write/Edit). No per-feature mean table emitted; reported directional effects:

| Signal | Effect | Validates |
|---|---|---|
| `thrash_files` | **+74%** in failures (strong) | `churn_full_rewrite_repeat`, `churn_same_anchor_rewrite_count`, `churn_edits_without_green` |
| `repeated_failing_command` | **+54%** (strong) | `churn_repeated_failing_bash`, `churn_rerun_failing_test_no_source_change` |
| `scope_files` | +15% (correct direction) | `subsystem_breadth`, `seed_closure_exit_ratio`, `cardinality_growth_slope`, `netnew_file_ratio_climb` |
| `region_revert_count` | correct direction, sparse | `churn_literal_edit_revert`, `churn_undo_war_value_toggle`, `churn_net_zero_file_vs_head`, `reb_oscillating_read_edit_same_region` |
| `obligation_opens_net` | +11% (weak) | `obl_net_open_at_stop`, `obl_stub_unclosed_after_n_edits`, `todo_stub_ratchet` |
| `scope_dirs` | **could not validate** | single-checkout-root artifact — needs package/manifest-depth segmentation |
| `edits_without_verification` | **no negative class** | every SWE-bench traj verifies |

**Meta-finding (this dataset's banner):** all six instrumentable bad signals correlate with failure in the predicted direction with **zero direction reversals** — first empirical confirmation the reasoned catalog points the right way on real cross-project traces.

### 2.5 `swe_smith` — n=200 — qualitative

SWE-agent traces, boolean `resolved`. **6 of 8 features separate in the predicted direction; the other 2 (scope_dirs, obligation) are corpus-limited (no variance), not contradicted.**

| Signal | Effect | Validates |
|---|---|---|
| `edits_without_verification` | **~2× (single biggest separator)** | Family 7: `vd_code_edit_streak_no_verify`, `vd_commit_no_verify_this_session`, `vd_code_to_test_edit_ratio`, `fanout_without_verification` |
| all four churn features | higher in failures | Family 1 (full churn set) |
| `scope_files` | +15% | Family 2 (partial) |
| `scope_dirs` | untestable (single-package corpus) | — |
| `obligation` | ~1% base-rate, not testable | Family 3 needs greenfield/feature-build corpus |

---

## 3. Per-rule-FAMILY validation coverage

| Family | Name | Verdict | Evidence from | Action gradient |
|---|---|---|---|---|
| **1** | Churn / Thrash | **VALIDATED (directional, reproducible)** | all 5 coding datasets | `thrash_files`, `repeated_failing_command` → **graduation-ready (nudge)**; `revert_churn_ratio` stays `silent_metric` until co-occurrence guards sharpen it |
| **2** | Scope-Creep | **MEASURED — NOT predictive / inverts** | all 5 (scope_files +15% weak in 2; reversed in `open_swe`/`agent_traj`) | **Confirmed: keep at nudge/metric, never block.** `scope_dirs` rules unmeasurable on single-root corpora |
| **3** | Obligation Ledger | **UNMEASURABLE on these corpora** | 0–6% firing; identically-zero in `swe_gym` | Bug-fix/patch corpora emit ~0 TODO/stub markers → needs feature-build corpus |
| **4** | Invariant Ratchets | **INDIRECTLY supported** | via `region_revert` / `net_vs_gross_churn_divergence` | `ratchet_satisfying_line_revert` direction confirmed; needs its own probe |
| **5** | Security sequence detectors | **partially — see §4** | AgentHarm / AgentDojo / CIBER | shape-exercised only; argument-level discrimination unmet |
| **6** | *(not exercised in this batch)* | — | — | see §6 |
| **7** | Verification Discipline | **STRONGLY VALIDATED where variance exists; UNTESTABLE on SWE-bench scaffolds** | `agent_traj_4000` (4.4×), `swe_smith` (~2×) | best single deterministic predictor; **graduation-ready** |
| **8** | *(not exercised)* | — | — | see §6 |
| **9** | Read/Edit Balance | **partial** | `reb_blind_edit_then_revert` via `region_revert` (all coding); `reb_oscillating_read_edit_same_region` via swe_rebench | oscillation rules need read-tool-granular traces |
| **10–11** | *(not exercised)* | — | — | see §6 |

### Families that are UNVALIDATABLE from benchmark scaffolds (and why)

- **Family 7 on SWE-bench corpora (3 of 5):** `open_swe_traces` and `swe_rebench_oh` have a **0.94–1.0 verifier base-rate** → no negative class. The feature is well-formed; it simply cannot be discriminated where everyone verifies. (Validated instead on `agent_traj_4000` / `swe_smith`, which have under-verified traces.)
- **Family 2 `scope_dirs` / package-boundary / disconnected-components:** every coding corpus is a **single-checkout-root, single-package** artifact → top-dir/package segmentation collapses to ~1. Needs multi-package or monorepo traces.
- **Family 3 obligation ledger:** patch-style bug-fix agents introduce ~0 obligation markers. Needs **greenfield/feature-build** trajectories.
- **Read/Edit-balance oscillation & multi-agent families:** benchmark scaffolds (a) collapse `view`/`open`/`scroll` into coarse Read events and rarely interleave reads with edits the way an IDE session does, and (b) are **single-agent by construction** — no concurrent reservation/conflict stream exists to validate multi-agent rules. These require interactive Claude Code traces or a synthetic multi-agent harness; benchmark data structurally cannot produce them.
- **Cross-session families:** episode-level corpora have no session-to-session linkage → `xsr_*` / `session_*` rules unvalidatable here.

---

## 4. Security blocks (10) — validatability from AgentHarm / AgentDojo / CIBER

**Bottom line: 0 of 10 security blocks were validated *discriminatively*. Two were shape-exercised; three got partial/content-level positive seeds; five had no materializable substrate.** The blocker is uniform — Family-5 rules are **two-step followed-by CEP rules that gate on argument content** (file paths, command strings, secret literals, hostnames), and none of the three security corpora records argument-level action streams suitable for that.

| Security block | AgentHarm | AgentDojo | CIBER (RedCode-Exec) | Net |
|---|---|---|---|---|
| `sec_read_secret_then_egress` | shape exercised, **non-discriminative** (fires 52/100 on BOTH splits — 79/96 ids byte-identical) | **FP-discipline only** (18 legit read→send; rule must NOT fire) | content-level positive (30 rows: read `/etc/passwd` + HTTP POST, but both legs collapsed into one exec event) | shape + FP-discipline + content seed; **not the Read→Bash CEP** |
| `sec_credential_staging_fanin` | shape exercised, non-discriminative (16/100 both splits) | — | — | shape only |
| `sec_fetch_remote_script_then_execute` | 0/200 (no download→exec pairs) | — | **partial: 30 download-leg seeds**, "then execute" leg absent | download leg only |
| `sec_encode_obfuscate_then_egress` | — | — | **partial: 30 encode-leg seeds**, egress leg absent | encode leg only |
| `sec_secret_literal_flows_to_command` | 0 (no args) | FP-discipline only (4 legit content-in-send) | 0 (no structured-prefix tokens) | FP-discipline only |
| `sec_env_add_then_git_commit` | 0 (no args) | 0 (domain-API corpus, no git) | 0 (no `.env` writes) | none |
| `sec_git_hook_backdoor` | 0 | 0 | 0 (no `.git/hooks`) | none |
| `sec_ssh_authorized_keys_inject` | 0 | 0 | 0 in sampled scen 1–7 | none |
| `sec_harness_disable_then_guarded_op` | 0 (Interlinked-specific) | 0 | 0 | none — not represented in any external corpus |
| `sec_dns_exfil_burst` | 0 | 0 | 0 (no dig/nslookup) | none |
| *(adjacent: `session_secret_persistence`, `xsr_reintroduce_scrubbed_secret`)* | 0 | 0 | 0 (single-step, no multi-session) | none |

**Decisive corpus facts (honest):**
- **AgentHarm is a harm-*intent* benchmark, not an action stream.** Only `target_functions` tool-NAME list + NL goal — **no arguments, no toolOutcome**. It is *matched-pair*: malicious/benign share byte-identical tool sequences (precision 50%). It cannot validate any detector discriminatively. Only path to positives is **MODE B** (run `inspect_evals/agentharm` against a live model to get `.eval` logs with real `ToolCall` args).
- **AgentDojo dump's `label` is NOT an attack-success flag** — it is exactly `(attack_name != 'none')` (10,439/10,439 injected = 1; 97/97 benign = 0). Injected runs are **first-action snapshots** (mean 1.30 calls; first verb always a benign read/search) → **0/10,439 contain any exfil verb**. No realized exfil chains exist → no positive corpus. It *does* validate **FP-discipline** (18 legit read→egress chains the rules must not fire on) and reveals the host-based FP guard doesn't map to domain-tool recipients (email/IBAN/username, no hostname).
- **CIBER/RedCode-Exec is the malicious *destination*, not the agent *journey*** — one Python payload per row, no tool-call sequence, no PreToolUse/PostToolUse log. A one-ToolEvent-per-row adapter structurally cannot fire two-step CEP rules; it validates only the **underlying single-step content scanners** (filesystem-guards sensitive-file read: 80/200; exfil-to-endpoint: 30/200). Bash/destructive scenarios are GitHub-only (HF mirror is Python-only).

**Positive examples that DO exist (content/shape level):** sensitive-file reads (`/etc/passwd|/etc/shadow|/etc/group`, 80/200 CIBER), remote-script download legs (30), base64-obfuscation legs (30), directory-recon globs (30). These seed the **single-step content scanners** (filesystem-guards), not the trajectory CEP blocks.

---

## 5. Git-history lane

`reverted_commits` (lane=git, accessible, `full_stream=false`) is **recon-only — no empirical pilot ran** (summary = placeholder). The recon establishes the design:

**What commit-scale mining yields:**
- **A derived outcome oracle, not a native one.** Revert relationship is the label: a commit later reverted ⇒ `unresolved`/fail; the revert + any successful re-introduction ⇒ `resolved`/success. For BugSwarm: native fail→pass build status.
- A large, cheap, real-world corpus of *outcome-labeled change sets* spanning many projects/languages — the only lane that scales past a few hundred trajectories.

**Hard limits (why it can't replace trace pilots):**
- **No per-step `toolOutcome`** — must synthesize `toolOutcome="success"` for committed writes; the intermediate failing-command / revert-during-session signal (Family 1's strongest separators) is **invisible** at commit granularity.
- **No action stream** — commits are the *net* diff, not the ordered Read/Edit/Bash journey. Churn-within-session, region-revert, and verification-cadence are all collapsed away.
- **Outcome granularity is coarse and indirect** — "was reverted eventually" is a noisy, lagged proxy for "the trajectory was bad," confounded by refactors, policy reverts, and re-landings.

→ The git lane is best reserved for validating **net-state rules** (`churn_net_zero_file_vs_head`, `net_vs_gross_churn_divergence`, ratchet-satisfying reverts) and as a label-source to **bootstrap** a future trace corpus, not as a substitute for action-stream pilots.

---

## 6. Prioritized data-acquisition + next-measurement plan

Ranked by *marginal rules unblocked per unit of acquisition effort*.

**P0 — Run AgentHarm/AgentDojo in MODE B (live-model eval logs).** The single highest-leverage gap: it is the *only* path to **discriminative** security positives. Run `inspect_evals/agentharm` and the AgentDojo grader against a model to produce `.eval` logs carrying real `ToolCall` arguments + the grader's behavioral pass/refuse label. Unblocks discriminative validation of `sec_read_secret_then_egress`, `sec_credential_staging_fanin`, and (with the dynamic environment) the argument-gated blocks. *Outside the streaming-only pilot envelope — needs a sandboxed model run.*

**P1 — Acquire an under-verified / feature-build coding corpus.** Needed to (a) give Family 7 a negative class on *more* datasets and (b) finally exercise Family 3 (Obligation Ledger), which is ~0-firing on every patch-style corpus. Candidates: interactive IDE-agent traces, greenfield "build a feature" benchmarks, or Claude Code session exports. This unblocks `obl_net_open_at_stop`, `todo_stub_ratchet`, `obl_stub_unclosed_after_n_edits`, and hardens `vd_*`.

**P2 — Acquire multi-package / monorepo traces** to validate Family 2 `scope_dirs`, `package_boundary_crossing`, `disconnected_components` — all currently collapsed to ~1 by single-checkout-root corpora. Use package/manifest-depth segmentation in the adapter (vs naive top-dir).

**P3 — Run the git-history lane pilot** (`reverted_commits` + BugSwarm) for net-state rules (Family 4 ratchets, `churn_net_zero_file_vs_head`) — cheap, large, but limited to commit granularity (§5).

**P4 — Synthesize / source multi-agent + cross-session traces.** Multi-agent (Families covering reservation/conflict) and cross-session (`xsr_*`, `session_*`) rules are structurally absent from all single-agent episode corpora. Either build a synthetic multi-agent harness replay or mine concurrent-agent session logs.

**P5 — Re-run coding pilots with `HF_TOKEN`** to harden against transient streaming resets, and bump n where a dataset has too few resolved trajectories (`swe_gym`: 15 resolved → underpowered; `agent_traj_4000`: 17 resolved).

### Reusable adapter specs (validated this round; standardize and keep)

- **Coding (OpenAI-chat / OpenHands / SWE-agent):** per assistant `tool_call`, `json.loads(function.arguments)` (it's a string!) with `<function=…>` / ```` ```bash ```` fallback. Editor sub-command dispatch: `view`→Read, `create`→Write, `str_replace`/`insert`→Edit, `undo_edit`→revert-event, `execute_bash`/`execute_ipython_cell`→Bash, `web_read`/`browser`→WebFetch, `finish`/`think`→drop. `toolOutcome=fail` on `Traceback`/`Error`/non-zero-exit markers in the paired `tool` observation (matched by `tool_call_id`). **Caveat: toolOutcome is heuristic regex over observation text** → `repeated_failing_command`/verify-detection carry classification noise.
- **Security MODE A (name-only, e.g. AgentHarm):** one synthetic `ToolEvent` per `target_function`, classify name into role (READ/SEARCH/EGRESS/WRITE_EXEC/EXEC). *Confirmed insufficient for argument-gated blocks — keep only for shape coverage.*
- **Security MODE B (to build):** parse `inspect_evals` `.eval` logs → `ToolCall` with real args → feed the actual Family-5 two-event CEP.
- **Single-payload (CIBER):** one ToolEvent per row → routes to single-step content scanners only, not CEP.
- **Outcome mapping (standard):** coding `resolved` 1/true→success, 0/false→fail, −1→drop; AgentDojo dedup by `(user_task, injection_task, attack)`; **do not** trust AgentDojo `label` as attack-success.

### Operational note (dogfood signal)

Every pilot hit the live harness's own gates while writing analysis scripts: Write-tool repo-confinement, bash-redirect-to-`.py` source gate, cyclomatic cap on Write content, floating-version pip blocks, and `pgrep`-kill blocks. Worked around via scratchpad heredocs / stdin-piped Python / pinned pip / the Monitor tool. This is itself evidence the security/quality gates fire on real workflows — and a backlog item to carve a sanctioned analysis-script path so validation work isn't fighting the harness.

---

## Counts

- **Datasets recon'd:** 9 (5 coding, 3 security, 1 git)
- **Empirical pilots actually run:** 8 (5 coding + 3 security; git lane recon-only)
- **Coding trajectories streamed:** ~1,000 (5 × 200) + 224 AgentDojo + 200 AgentHarm + 200 CIBER
- **Rules with measured evidence:** ~33 of 233 (Family 1 ×11 directional, Family 7 ×6, Family 9 ×2, Family 2 ×5 measured-non-predictive, Family 3 ×3 measured-null, Family 4 ×1 indirect, security ×5 shape/FP/content)
- **Security blocks validated discriminatively:** 0 of 10 (2 shape-exercised, 3 partial-seed, 5 no-substrate)
- **Direction reversals among instrumentable churn/verification signals:** 0