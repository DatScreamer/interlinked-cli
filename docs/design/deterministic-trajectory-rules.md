<!-- Generated 2026-06-27 by an 11-family multi-agent generate -> adversarial-FP-audit -> synthesize workflow (250 generated, 249 survived FP audit). Design catalog; not yet implemented. Companion to .interlinked/qwen-train/scripts/autolabel.py. -->

# Deterministic Cross-Tool-Call Trajectory Rules — Merged Catalog

## Framing: trajectory analysis *is* deterministic sequence analysis

Every rule below treats the agent's tool-call stream as an event log and decides
with **no model inference** — it is **complex-event processing (CEP)** +
**runtime verification** + **obligation accounting**, three lenses on one
substrate. CEP supplies the *followed-by / not-followed-by / within-window*
operators that join a Read to a later Bash, an Edit to a later revert, an
export-removal to an unupdated caller. Runtime verification supplies the
*invariant / ratchet* lens: a monotone property (`secret-count==0`,
`coverage non-decreasing`, `cyclomatic ≤ cap`) that each per-edit gate enforces
*locally*, and that these trajectory monitors re-assert *globally* across the
whole session (the conjunction of local non-regressions does **not** imply
global non-regression — oscillation, cross-file shuffles, and slew-walking all
defeat it). Obligation accounting supplies the *ledger* lens: an OPEN event
(stub, skip, conflict marker, dangling ref, type error) that must be matched by
a later CLOSE, with the residual surfaced at Stop. All three reduce to counting,
grouping, hashing, and graph reachability over events the harness already joins
by `tool_use_id` and `content_sha256` — deterministic by construction, per the
"no LLM-as-judge in the aggregator" rule.

The action gradient is the FP-safety model. **Nudge is the default verdict**;
`block` is reserved for fully-deterministic, near-zero-FP *harm* (live secret,
remote-script execution, git-hook backdoor, committing red), and `silent_metric`
is the home for any signal whose separation of true-positive from legitimate
pattern is fuzzy — it feeds the auto-labeler and Stop-reflection but never
interrupts. The gradient lets a noisy-but-real detector ship at `silent_metric`,
earn calibration, and only graduate to `nudge` (or, rarely, `block`) once its
guard provably separates the classes. Because non-progress, scope-spread, and
taste signals are *not* deterministic harm, they are pinned at nudge/metric — a
blocked legitimate bisection or refactor is a real workflow break and fails the
low-FP bar. Composition is the strongest FP guard in the set: most high-confidence
rules fire only when an independent deterministic signal co-occurs (graph
prediction **and** a proven downstream check; churn **and** literal-revert;
secret-read **and** egress).

## How to read the tables

Columns: **Act** = B(lock) / N(udge) / M(etric); **Sev** = H/M/L; **FP** =
low-FP confidence (H/M/L); **Now** = implementable with current data (Y/N).
"Span" is the CEP window / accumulation scope. Detect+signal are combined; the
*exact deterministic trigger* is bolded-by-predicate in each row.

---

## Family 1 — Churn / Thrash (non-progress loops)

Core substrate: per-file ordered `content_sha256` list after each successful
edit + per-anchor value sequences + per-command normalized-failure map +
per-file "edits since green" counter. Anchor = hash of unchanged prefix+suffix
of `old_string` (content-anchored, survives line drift).

| id | detects / exact signal | span | Act/Sev | FP guard | Now |
|---|---|---|---|---|---|
| `churn_sha_cycle_revisit` | new edit produces a `content_sha256` already in F's list at index i<len-1 → closed loop | per-file session sha list | N/M | ≥2 distinct revisits OR a failing intervening check; exclude whitespace-only cycle delta | Y/H |
| `churn_literal_edit_revert` | strict exact-undo: `E.old===P.new && E.new===P.old` with line-range intersection | per-file edit pairs | N/M | surface strict variant only; substring matches → metric | Y/M |
| `churn_undo_war_value_toggle` | per-anchor value seq contains A,B,A (current==value-2-ago ≠ value-1-ago) | per-(file,anchor) | N/H | fire on 2nd toggle; suppress if a Bash test/build ran between toggles (measuring=bisection) | Y/M |
| `churn_edits_without_green` | per-file `edits_since_green` reset on clean check; emit at 5, escalate 8/12 | per-file counter | N/M | only count files with a resolvable green; exempt config/docs/data/type-only | Y/M |
| `churn_repeated_failing_bash` | normalized command matches a prior failing run + current also fails; ≥2 (3rd run) | per normalized cmd | N/M | reset on intervening edit; exempt flaky/network verbs (curl/ping/nc/git fetch) | Y/H |
| `churn_rerun_failing_test_no_source_change` | test/build re-run after a same-**family** failure with zero successful edits between | per tool-family | N/M | reset on install/checkout/env-set; allow 1 confirmation re-run | Y/H |
| `churn_net_zero_file_vs_head` | current sha == git HEAD blob sha AND ≥3 edits this session | per-file vs HEAD | N/M | soften wording (revert-to-HEAD often correct); suppress whitespace-only delta | Y/H |
| `churn_worktree_state_cycle` | combined snapshot hash of sorted (file,sha) tuples revisits a prior tuple | whole-worktree | M/L | surfaces only w/ per-file sha-cycle on ≥2 files; labeler input | Y/H |
| `churn_import_add_remove_thrash` | import specifier removed-after-added (or vice-versa); 2nd flip | per-(file,import) | M/L | nudge only when paired w/ sha-cycle or literal-revert | Y/M |
| `churn_symbol_rename_oscillation` | symbol name value-toggle A,B,A dragging caller edits | per-symbol name seq | N/M | ≥2 caller files dragged; suppress if no green/test between (naming exploration) | Y/M |
| `churn_check_finding_reintroduced` | per-(file,check,line-anchor) outcome seq fixed→reappears→fixed | per-(file,check) | N/M | require line-anchor keying; no anchor → metric | Y/M |
| `churn_comment_uncomment_toggle` | pure comment-marker toggle reversing a prior toggle on same anchor | per-anchor direction | M/L | comment-toggle = debugging; nudge only if left toggled at Stop | Y/M |
| `churn_same_anchor_rewrite_count` | overlapping anchor, distinct `new_string`, rewrite_count≥4 | per-(file,line-range) | N/M | require lines_removed>0, no green between rewrites | Y/M |
| `churn_full_rewrite_repeat` | full-content Write to F ≥2× this session | per-file write count | M/L | promote only when re-hits prior sha or file is large | Y/H |
| `churn_time_since_green_slope` | `green_gap` non-decreasing across last K=10 edits AND > 3× median inter-green | time-series | M/L | inline surface Stop-only, never mid-trajectory | Y/H |
| `churn_revert_after_check_fail_combo` | **E1 fails check → literal-revert of E1 → E3 re-applies E1**, ≤6 edits, no green between (labeler's top combo) | per-file CEP | N/H | suppress if other file passed a check between; suppress if install/env/git intervened; require byte-identical re-apply | Y/M |
| `churn_downstream_block_revert_combo` | edit triggers downstream/import-resolution block → revert → re-apply, no dependent edited between | per-file CEP | N/H | grace window: defer if a named dependent is edited within next few calls | Y/M |
| `churn_repeated_command_loop_silent` | one normalized command ≥3× in last-20 window (any outcome) | rolling window | M/L | pure metric; routes outcome distribution to failing-bash rule | Y/H |
| `churn_oscillating_check_severity_trend` | per-file open-finding-count sign sequence has ≥2 sign changes | per-file time-series | M/L | Stop-reflection only | Y/H |
| `churn_cross_session_recurring_thrash` | on any churn hit, prior churn hit on same (file,anchor-hash) in another session → escalate wording | cross-session log | N/M | only escalates an already-firing in-session rule; content-anchored matching | Y/H |
| `churn_open_obligation_reopened` | ledger entry satisfied→open because a later edit deleted the satisfying code | obligation ledger | N/M | suppress if subject removed in same/adjacent edit or satisfier re-added | Y/M |
| `component_oscillation` *(absorbs `churn_two_file_pingpong`)* | alternations between two dependency-disconnected clusters: regex `(A B){3,}` / ≥4 alternations in 8-call window, neither green | union-find over edits | N/L→M | merge same-dir / import-edge / shared-domain pairs into "connected" before counting | Y/M |

*Merged here:* `churn_undo_war_block` (its own FP guard downgrades the hard block
→ folded into `churn_undo_war_value_toggle` as the loud-nudge escalation naming
both flapping values). `churn_diff_added_removed_balance` → see
`net_vs_gross_churn_divergence` (identical gross-vs-net metric). `churn_two_file_pingpong`
→ generalized into `component_oscillation`.

---

## Family 2 — Scope-Creep / Focus (off-task drift)

Substrate: SEED = first 1–3 distinct edited files (frozen). Seed import-closure
(fwd+rev, depth-cap 4). Per-subsystem edited counts, union-find over edited-file
graph, blast-radius distribution precomputed once per session.

| id | detects / exact signal | span | Act/Sev | FP guard | Now |
|---|---|---|---|---|---|
| `seed_graph_distance` | edit to F with min undirected graph distance to SEED == INF (BFS cap 4) | per-edit vs SEED | N/L | only when F has ≥1 resolved edge to *something* (isolated node → suppress) | Y/M |
| `disconnected_components` | edit-set forms ≥2 graph components, off-component holds ≥2 CODE files | union-find | N/M | merge components sharing dir depth≥2 or shared symbol | Y/M |
| `subsystem_breadth` | distinct top-level subsystems crosses 4 (nudge) / 7 (stronger) | accumulated set | N/L | auto-detect segment depth; skip if <4 top-level source dirs | Y/M |
| `cardinality_growth_slope` | newfile_rate≥0.7 across two consecutive windows AND edit_set doubled | sliding W=10 | M/L→N | only nudge when fan-out co-occurs w/ revert or check-block in window | Y/H |
| `seed_abandonment` | all seeds cold (≥8 calls) + ≥4 non-seed edited + a seed still carries OPEN obligation | per-seed last-edit idx | N/M | obligation must be testable CODE not covered by any whole-project verifier run | Y/M |
| `fanout_without_verification` | ≥6 code files edited AND unverified-fraction ≥0.5 | edited∖verified | N/M | count IDE getDiagnostics/MCP typecheck as verification; map glob args to closure | Y/M |
| `new_toplevel_dir` | Write under a top-level dir absent from session-start `TOPDIRS0` snapshot | one fs snapshot | N/L | suppress greenfield + conventional dirs (test/docs/scripts) | Y/M |
| `high_blastradius_offtask` | edit to F outside SEED-closure with `blast_radius(F)` ≥ P90 | precomputed dist | N/M | require BOTH high fan-in AND another off-task signal (outside read-set, no shared-symbol) | Y/L |
| `package_boundary_crossing` | edit's package ∉ SEED_PKGS; fire at 3-package crossing | nearest-manifest walk | N/L | honor workspaces aliases; disabled in single-package repos | Y/M |
| `config_build_drift` | SEED ≥80% CODE then ≥3 distinct CONFIG/MANIFEST *units* edited | category classifier | N/L | collapse manifest+lockfile into one unit | Y/L |
| `rename_cascade_sprawl` | same (old,new) token swap across ≥8 files spanning ≥3 subsystems | per-pair file count | M/L→N | single info-nudge per pair; survive session resume | Y/H |
| `seed_closure_exit_ratio` | focus_ratio<0.5, total≥8, monotone non-increasing over last 4 new files | running ratio | M/L | add shared-symbol edges to closure | Y/H |
| `opportunistic_whitespace_churn` | ≥3 cosmetic-only edits to files outside SEED-closure | per-file cosmetic set | N/L | suppress IDE/pre-commit/formatter-config-matched diffs | Y/L |
| `subsystem_entropy_rise` | Shannon entropy ≥ log2(4) AND rising over last 3 new-subsystem edits | per-subsystem dist | M/L | cap escalation below ~8 substantive edits | Y/H |
| `netnew_file_ratio_climb` | new/(new+modify) ≥0.6, total≥10, seed was a MODIFY | new vs modify counts | M/L | suppress decomposition (split into small new modules) | Y/H |
| `edit_set_diameter_growth` | approx graph-diameter rose on ≥3 of last 4 new-file edits AND ≥5 | edit-set graph | M/L | treat disconnected pairs as graph-incomplete, not sentinel | Y/H |
| `unrelated_symbol_bugfix` | ≥3 edits whose enclosing symbols have no call-graph path (≤3) to SEED symbols | symbol call-graph | M/L | require also no shared-name + no same-dir; exclude small utils | Y/L |
| `ownership_zone_breadth` | distinct CODEOWNERS owner-sets crosses 4 | CODEOWNERS match | N/L | only with CODEOWNERS; count distinct owner sets | Y/M |
| `read_broad_edit_far` | ≥4 of last 6 edits have read_locality=false (edited, never read, graph-far) | READSET vs edits | M/L | count any tool-result appearance as "read" | Y/H |

---

## Family 3 — Obligation Ledger (open-loops, unfinished work)

Substrate: session ledger map M over OPEN kinds (TODO/FIXME, stub/throw,
test skip/only, tsc error, missing-symbol, deleted-symbol-with-callers, conflict
marker, unconsumed config key, suppression). CLOSE on inverse-diff or passing
re-check. Residual surfaced at Stop.

| id | detects / exact signal | span | Act/Sev | FP guard | Now |
|---|---|---|---|---|---|
| `obl_net_open_at_stop` | at Stop, openSet = session-opened obligations not later closed; fire if non-empty | whole session→Stop | N/M | session-opened only; suppress ticket/author-tagged; framed as inventory not failure | Y/H |
| `obl_stub_unclosed_after_n_edits` | OPEN stub (throw-not-impl/TODO body) then ≥N=4 edits to *other* files, still open | CEP followed-by-without | N/M | suppress abstract/interface members, TDD test added for stub, class being built | Y/M |
| `obl_only_focus_false_green` → **merged into `vd_only_in_tree_at_commit`** | `.only` added → "passing" test run is false-green | — | (see VD) | — |
| `obl_skipped_test_never_reenabled` → **merged into `vd_disabled_test_open_at_stop`** | session skip still present at Stop | — | (see VD) | — |
| `obl_type_error_carried_across_edits` | tsc/mypy error keyed (file,error-anchor) survives ≥2 later edits or to Stop | join check-results | N/M | ≥2-edit grace for batch refactors; dedup cascades to root; Stop/commit only | Y/M |
| `obl_red_test_never_green` | test-runner fail, no later pass of same-or-superset target by Stop | CEP not-followed-by | N/H | red target must intersect files-touched; soften TDD-red wording | Y/M |
| `obl_missing_symbol_ref_unresolved` | added ref/import to a symbol with no exporter/def in graph, unresolved ≥2 edits | symbol graph | N/M | in-repo only; skip node_modules/type-only; ≥2-edit grace (largely tsc's job) | Y/M |
| `obl_conflict_marker_persisted` | `^(<{7}\|={7}\|>{7})( \|$)` added, survives a later edit to same file | per-file CEP | N/H | anchor to exact 7-char runs; exempt md fences/fixtures/docs/@codegen-data | Y/H |
| `obl_disabled_test_then_sut_edited` | test for SUT M disabled → later edit to M with lines_added>0, still disabled | two OPEN streams | N/H | session-opened skip; suppress if a new test for SUT added between | Y/M |
| `obl_commented_out_code_block_persisted` | ≥6 contiguous comment lines parsing as code, persists to Stop | per-block | N/L | code-token heuristic; exempt md/fixtures; suppress "kept for…" rationale | Y/M |
| `obl_suppression_outlives_its_error` | (a) tsc reports unused `@ts-expect-error`; (b) suppression unjustified at Stop | per-suppression | N/L | path (a) proven near-zero-FP; gate on session-added + same tsconfig | Y/H |
| `obl_open_count_slope_metric` | netOpen non-decreasing over W=8 AND Δ≥3 | time-series | M/L | weak labeler feature only | Y/H |
| `obl_count_threshold_midsession` | netOpen crosses N=5 upward first time | latched | N/M | latch once/session; weight toward high-signal kinds | Y/M |
| `obl_stop_with_unaddressed_blocking_check` | latest check-result on a touched file is block/error, no later outcome=fixed | per-file latest | N/M | proven (fully_deterministic) checks only; outcome=ignored counts addressed | Y/M |
| `obl_test_block_deleted_sut_unchanged` | test edit removes a full it()/assert block, no SUT edit in ±3-edit window | companion mapping | N/M | suppress if total test-case count held; defer to coverage-baseline ratchet | Y/M |
| `obl_reachable_stub_in_exported_path` | stub ∩ (enclosing fn exported AND callers≠∅) | stub ∩ graph | N/H | exclude unreachable/exhaustive/assert throws; throw must be primary stmt | Y/M |
| `obl_obligation_oscillation_metric` | a sig OPEN→CLOSE→OPEN ≥2 reopen cycles | per-sig transitions | M/L | labeler weights only w/ churn+literal-revert | Y/H |
| `obl_cross_session_carryover_at_start` | new session first edits a file carrying a persisted prior-session open obligation | persisted ledger | N/L | re-validate anchor against live tree; once/session info nudge | Y/M |
| `obl_config_key_added_unconsumed` | config/schema key K added, no later read `.K`/`['K']` | per-key | M/L | exempt pure type/interface + dynamic-key modules | Y/H |
| `obl_todo_added_with_feature_ship` | TODO added AND file's session lines_added≥30 at a verification step/Stop | per-file accum | N/L | suppress ticket-tagged TODOs; exclude @codegen-data from line count | Y/M |
| `obl_guard_bypassed_obligation_open` | tool ran under `INTERLINKED_DISABLE_*` bypass, condition not remedied by Stop | per-bypass | M/M | audit record, not a nudge (bypass was deliberate); re-validate at Stop | Y/H |

---

## Family 4 — Invariant Ratchets (global non-regression vs per-edit gates)

The headline: per-edit ratchets enforce a **local** non-regression; their
conjunction does **not** imply a **global** one. Each rule snapshots V0 at first
touch (from baseline JSON / `Edit.old_string` pre-image / git HEAD blob) and
re-asserts the session-level invariant.

| id | detects / exact signal | span | Act/Sev | FP guard | Now |
|---|---|---|---|---|---|
| `cumulative_coverage_regression` | Σ(C[f]−C0[f]) over touched files < 0 though each per-edit gate passed | per-file covered-line counts | N/M | compute on ratio over surviving lines; suppress pure removal | **N**/M |
| `cumulative_cyclomatic_creep` | a function present at start rose ≥6 CC (3× per-edit tolerance) still ≤cap | per-fn AST CC | N/M | Stop-only; suppress switch-dominant/dispatch shapes; suppress if falls back | Y/M |
| `public_api_surface_growth` | net new exports with zero callers ≥ threshold | export index | M/L | weakest member; exempt entrypoint pkgs + type-only | Y/L |
| `disabled_test_set_growth` | cumulativeAdded−cumulativeRemoved ≥1 of skip/only set vs D0 | disabled-set diff | N/H | track by stable test-identity not position; ticket/flaky suppression for .skip | Y/M |
| `dependency_count_ratchet` | net new deps (by name across deps+devDeps) ≥3 | manifest multiset | N/M | dedupe names; exempt @types/* + workspace:/file: ; greenfield/allowlist suppression | Y/M |
| `lines_over_cap_count_ratchet` | offenderSet grows (new file crosses cap, not blocked by per-edit gate) | offender set | N/L | reuse isCappableFile; Stop-only; suggest @codegen-data | Y/H |
| `session_secret_persistence` | high-confidence secret introduced this session still live at edit | per-(file,secret-hash) | **B**/H | block ONLY PEM headers / AKIA+40-char pair / checksum-valid GitHub PAT | Y/M |
| `as_any_cumulative_ratchet` | net `as any` rose ≥2 vs A0 | per-.ts AST-lite | N/L | exempt test/.d.ts/generated; same-line `//` justification suppresses | Y/H |
| `non_null_assertion_cumulative_ratchet` | net postfix `!` rose ≥3 | per-.ts token count | N/L | exempt tests/generated; same-block guard suppression | Y/M |
| `magic_literal_cumulative_ratchet` | net magic-literal-in-conditional delta | per-file metric | M/L | exempt @codegen-data/config/test | Y/H |
| `suppression_directive_ratchet` | net unjustified ts-ignore/eslint-disable/biome-ignore ≥1 | per-file count | N/M | nudge only for UNJUSTIFIED; reason → metric; exempt @ts-nocheck/generated | Y/H |
| `todo_stub_ratchet` *(absorbs `fr_open_todo_accretion`)* | net TODO/FIXME/stub-throw/empty-exported-body ≥2 | per-file accum | N/L | Stop or every K=20 edits; suppress ticket-tagged; diff-aware net-new only | Y/M |
| `console_debug_ratchet` | net debug-print ≥1 at Stop | per-file (non-test/CLI) | N/L | Stop-only; exempt scripts/examples/bin/*cli*/logger; suppress tagged prints | Y/M |
| `import_cycle_count_ratchet` → **merged into `gcb_import_cycle_across_edits`** | cycle count rose | — | (see GCB) | — |
| `check_failure_population_ratchet` | distinct failing check-id population exceeds pop0, new ids not at start | join check-results | N/M | require id failing on 2 most-recent results; diff-aware; Stop/every-K | Y/M |
| `untested_file_floor_ratchet` | new source file raises zero-coverage population, no session-written companion test | coverage index | N/M | exempt no-executable files; any referencing test counts as companion | **N**/M |
| `ratchet_metric_oscillation` | ratcheted metric dips then recovers to ~prior within W=6, 5-min window | per-(metric,file) | M/L | recovery must touch same region + ≥2 oscillations; escalate only w/ independent signal | Y/M |
| `ratchet_satisfying_line_revert` | line added to clear a finding (outcome=fixed) later removed; finding now silently re-open | fixLines set | N/M | re-run originating check; suppress if still passes / guarded code removed | Y/M |
| `net_vs_gross_churn_divergence` *(absorbs `churn_diff_added_removed_balance`)* | gross(added+removed) ≥4× net-vs-HEAD AND editCount≥4 | per-file accum | M/L | metric-only; composes with another firing signal | Y/H |
| `crap_max_ratchet` | a fn with CR0<30 reaches ΔCRAP≥10 still under cap | per-fn CRAP | N/M | recompute after fresh coverage; Stop; name dominant driver | **N**/M |
| `breaking_export_removal_ratchet` → **merged into `gcb_high_fanin_export_removed`** | exported symbol w/ live callers removed | — | (see GCB) | — |
| `fanin_blast_radius_ratchet` | fanIn(f) crosses absolute coupling threshold (>25) AND rose this session | dependency graph | M/L | only threshold-crossing nudges; exempt shared/types/barrel modules | Y/H |
| `cumulative_vs_per_edit_divergence_meta` | at Stop/every-K=25, assemble regressionVector over all ratcheted metrics; fire ONE nudge | all-metrics meta | N/M | include a metric only if its own refined rule fired; exclude low-confidence members | Y/M |

---

## Family 5 — Security Exfil / Self-Blinding (CEP)

The only family where `block` is common — each block path is a deterministic
two-step with a structured, near-zero-FP trigger. Substrate: ring of last-K
Reads tagged SECRET by structured-credential path; per-session TAINT set of
prefix-structured tokens; egress-verb Bash parser; sanctioned-bypass allowlist.

| id | detects / exact signal | span | Act/Sev | FP guard | Now |
|---|---|---|---|---|---|
| `sec_read_secret_then_egress` | SECRET-path Read then Bash egress verb (curl/wget/nc/scp/…) to non-local host within K=12 | Read-ring → Bash | N/H | drop bare `token`/`secret` substring; structured cred paths only; host allowlist | Y/M |
| `sec_secret_literal_flows_to_command` | prefix-structured token (ghp_/sk-/AKIA/xox/JWT) from Edit content appears verbatim in Bash egress arg | TAINT taint-flow | **B**/H | remove generic base64 arm from block; structured-prefix tokens only | Y/M |
| `sec_env_add_then_git_commit` | secret added to tracked .env/config then `git add/commit` of that path | PENDING_SECRET_WRITE | **B**/H | exclude FOREIGN_KEY/PRIMARY_KEY/PUBLIC_KEY etc.; skip fixtures; run real scanner | Y/M |
| `sec_authcheck_removed_then_test_disabled` | auth/verify branch removed → its test deleted/skipped, no surviving control | CEP within session | N/H | require no surviving def/caller + true suppression + no equivalent control added | Y/M |
| `sec_install_then_run_unallowlisted` | unallowlisted pkg installed then its bin executed | INSTALLED set | M/M | redundant with install guard; the common legit action → metric | Y/L |
| `sec_history_rewrite_then_force_push` | rebase/amend/reset/filter → force-push to same branch, no clean push between | CEP | N/M | non-protected-branch suppression; lease<force weighting | Y/M |
| `sec_harness_disable_then_guarded_op` | kill/rm harness sock / strip hook / grow disabled_rules → guarded op | DISABLE event | **B**/H | treat documented `INTERLINKED_DISABLE_*` + `harness stop/restart`/`clean` as sanctioned | Y/M |
| `sec_credential_staging_fanin` | ≥3 distinct SECRET reads in W=300s then tar/zip/cat fan-in over ≥2 | K-of-N → aggregation | N/H | drop substring arm; aggregation must reference ≥2 structured-cred paths | Y/M |
| `sec_fetch_remote_script_then_execute` | external curl/wget to *.sh/.py/… file then `sh/bash/python <path>` (or chmod+x then run) | download → exec | **B**/H | allowlist official installer hosts (rustup/docker/deno/bun/astral/brew) | Y/M |
| `sec_egress_code_written_then_run` | edit injects fetch/POST to external host then Bash runs that file | code → run | M/H | "wrote net code then ran it" = normal dev; metric, promote only w/ secret-taint | Y/L |
| `sec_tls_verify_disabled_then_egress` | rejectUnauthorized:false / NODE_TLS_REJECT=0 / `curl -k` then external request | TLS_OFF → egress | N/M | extend loopback/RFC1918 to internal/staging + *.local/.internal/.test | Y/M |
| `sec_persistence_install_chain` | write to cron/launchd/systemd/profile then activate it | PERSIST_WRITE → activate | N/H | allowlist nvm/pyenv/rbenv/conda/direnv/starship init idioms | Y/M |
| `sec_git_hook_backdoor` | write `.git/hooks/*` with exec/egress sink then git verb triggers it | HOOK_WRITE → git op | **B**/H | require exec/egress sink AND triggering op; narrow `node -e` arm to net/decode payload | Y/M |
| `sec_lifecycle_script_added_then_install` | pre/postinstall (or build.rs/setup.py) gains net/eval sink then install runs | SCRIPT_ADD → install | N/H | require net/eval sink; expand benign-token list (tsc/prisma generate) | Y/M |
| `sec_untrusted_fetch_to_source` | web-fetched bytes written verbatim into source/config (overlap ratio high) | fingerprint → write | M/M | needs WebFetch response capture; suppress docs/examples/fixtures dests | **N**/L |
| `sec_encode_obfuscate_then_egress` | SECRET path base64/gzip/xxd/openssl-enc then encoded blob egressed in W=120s | ENCODE → egress | N/H | input must be SECRET path; external-host test suppresses legit uploads | Y/M |
| `sec_recon_grep_secrets_then_egress` | repo-wide credential-pattern Grep/Glob (≥1 hit) then external egress in W=180s | RECON → egress | M/M | corroborating feature; promote only w/ an actual SECRET Read in-window | Y/H |
| `sec_ssh_authorized_keys_inject` | append `ssh-(rsa\|ed25519\|ecdsa)` to ~/.ssh/authorized_keys; escalate w/ keygen/chmod | single write + follow-up | **B**/H | real-$HOME-only confinement (exclude project/tmp fixtures + CI bootstrap) | Y/M |
| `sec_log_history_tamper_after_guarded` | after RISKY_DONE, clear shell history / rm .interlinked/*.jsonl | RISKY → erase | N/H | restrict RISKY to destructive/egress/secret-commit/block (not install); suppress log rotation | Y/M |
| `sec_dns_exfil_burst` | after SECRET Read, ≥3 dig/nslookup to one base domain w/ distinct ≥20-char high-entropy labels in W=120s | SECRET → DNS burst | N/H | CDN/hashed-host allowlist; hex fixed-length suppression | Y/H |
| `sec_env_dump_to_file_then_read_egress` | `env/printenv/set > file` then that exact path egressed in W=180s | ENVDUMP → egress | N/H | same-path linkage (egressed path == dump target) | Y/M |
| `sec_perm_escalation_then_execute` | file written → chmod +x/setuid → executed | write → chmod → run | M/M | plain +x-then-run → metric; nudge/block only for setuid/setgid | Y/L |
| `sec_proxy_redirect_then_egress` | export HTTP(S)_PROXY/ALL_PROXY or /etc/hosts→external IP then network op while active | REDIRECT → net-op | N/H | loopback/RFC1918 + corporate-proxy allowlist; honor existing git http.proxy | Y/M |

---

## Family 6 — Graph Coherence / Blast-Radius

Substrate: session symbol-ledger keyed by fully-qualified id; incremental import
DAG with union-find/reachability; impact-analysis caller/importer sets;
barrel/re-export maps; body-hash for rename/move detection. The whole family's
edge is detecting breaks the single-file lint *cannot* see (cross-edit, barrel
indirection, interface→implementor).

| id | detects / exact signal | span | Act/Sev | FP guard | Now |
|---|---|---|---|---|---|
| `gcb_intrasession_dangling_caller` | ref to S added → S's def deleted later, no re-define | symbol-ledger | N/H | reference must resolve BY GRAPH to deleted def node; strip comments | Y/M |
| `gcb_broke_self_created_import` | session-created `import {X} from m` then later edit removes X export from m | session_created_imports | N/H | re-check importer's current specifier set at fire time | Y/H |
| `gcb_public_symbol_thrash` | export lifecycle ≥3 transitions; terminal=removed w/ live external importers | per-symbol state log | M/L→N | nudge only if live importers + no @deprecated + no replacement body-hash | Y/H |
| `gcb_import_cycle_across_edits` *(absorbs `import_cycle_count_ratchet`)* | new import edge u→v where v already reaches u (DFS) | incremental DAG | N/M | fire only on module-top-level eager use (real TDZ risk); exclude type-only | Y/M |
| `gcb_blast_radius_session_accumulation` | ∪ transitive-dependents crosses budget (25) AND unvisited-fraction >0.6 | blast_set vs visited | M/M | nudge only if no tsc/test ran AND unvisited-high AND budget crossed | Y/M |
| `gcb_single_edit_blast_spike` | signature/removal edit to S with ≥K=8 direct dependents, 0 visited | per-edit ∩ session | N/M | breaking deltas only (arity↑/param removed/return narrowed); suppress if clean tsc/test ran | Y/M |
| `gcb_orphaned_new_export` *(absorbs `obl_new_module_unwired`)* | export added, by Stop importers==0 AND callers==0; ≥3 orphans | session_added_exports | M/L | ≥3 multiplicity; exempt entrypoint/plugin/registry/config-referenced | Y/M |
| `gcb_rename_callsites_unupdated` | def_removed[S] + def_added[S'] body-hash match; stale callers of S unedited | rename CEP | N/H | high body-sim + name-edit proximity; suppress if alias for old name exists | Y/M |
| `gcb_signature_change_caller_drift` | breaking arity delta, caller files unedited / still passing old arg count | sig node ∩ callers | N/H | breaking only (required↑/removed/reorder); skip spread/dynamic args; defer to tsc | Y/M |
| `gcb_barrel_reexport_dangling` | barrel `export {X} from m` survives while X's export removed from m | reexport_map | N/H | re-check barrel still re-exports X at fire time; weight by importers(barrel) | Y/H |
| `gcb_incomplete_cross_file_move` | def removed from A + added to B (body-hash), importers of A not repointed | move CEP | N/M | confirm S no longer in A (move≠copy); suppress re-export shim | Y/M |
| `gcb_test_references_removed_sut_symbol` | test imports/calls S from SUT, later edit removes S, test unedited | companion graph | N/H | companion-SUT only; suppress if test edited; defer to PostToolUse test fail | Y/H |
| `gcb_import_oscillation_thrash` | import edge add→remove→add (≥2 sign changes) | per-edge op-seq | M/L | metric/labeler only; exempt conflict-resolution; raise w/ literal-revert | Y/H |
| `gcb_public_surface_unreachable` | post-diff: exported S reachable from no entrypoint, no external importer; ≥2 | reachability closure | M/L | needs complete entrypoint decls; multiplicity≥2; exclude dynamic-registry | **N**/L |
| `gcb_high_fanin_export_removed` *(absorbs `obl_deleted_symbol_live_callers`, `breaking_export_removal_ratchet`)* | export removed/renamed w/ K importers, ≥3 unfixed; block-candidate only on proven downstream import-resolution fail | baseline importer set | N/H | recompute unfixed textually at fire; block ONLY w/ proven downstream check fail | Y/H |
| `gcb_interface_impl_drift` | interface/abstract required-member set changed, implementors unedited | implements edges | N/H | required-member changes only; inferred edges → metric; defer to tsc | Y/H |
| `gcb_enum_member_removed_consumers_live` | enum/union member removed, switch/case consumers unupdated | type node + consumers | N/M | graph-resolved/switch-discriminant refs only, never textual; else metric | **N**/M |
| `gcb_import_to_deleted_file` | `rm`/empty-Write/node-removal of module m, importers not repointed | deletion + import graph | N/H | statically-resolvable single-file deletes only; recompute importers at fire | Y/H |
| `gcb_export_then_private_with_interleaved_importer` | export_added → importer wired (other file) → export_removed, importer unedited | 3-state CEP | N/M | confirm interleaved import is cross-module | Y/H |
| `gcb_ghost_refactor_net_zero_def_callers_changed` | ≥2 caller-shape changes to S while S's def byte-identical to baseline, arity-incompatible | def-hash + caller edits | N/M | provably arity-incompatible only; skip dynamic/spread; retract on clean tsc | Y/M |
| `gcb_blast_then_downstream_check_combo` | high-blast edit then PostToolUse check FAIL on a file in predicted blast set (≠edited file) | edit ∩ check-results | N/H | both legs required; limit join to same/next-K tool_use_id; failure must be NEW | Y/H |
| `gcb_reexport_shim_left_then_consumers_drift` | session-added shim deleted while consumers still resolve through it | session_added_shims | N/M | session-added shims only; recompute remaining consumers at fire | Y/H |
| `gcb_cross_session_recurring_broken_edge` | a (importer→symbol) edge broke in ≥N=3 prior sessions, breaks again | recurrence log | N/M | never standalone; time-decay; require prior breaks confirmed | Y/H |

---

## Family 7 — Verification Discipline

Substrate: session counters C(code edits)/T(test touches); verifier-verb regex
on Bash; companion-test resolution; assertion-token + matcher-specificity diffs;
`lastVerify={ts,exit}`; staged-diff scan at commit boundary.

| id | detects / exact signal | span | Act/Sev | FP guard | Now |
|---|---|---|---|---|---|
| `vd_code_to_test_edit_ratio` | session C vs T ratio | two counters | M/L | exclude generated/vendored from C; full-suite run weighted higher | Y/H |
| `vd_orphan_code_edit_no_companion_test_touch` | ≥5-line edit to F (exports callable), companion Tf never read/run/edited | per-(F,Tf) obligation | N/M | any bare full-suite run discharges all; window ~10 calls | Y/M |
| `vd_read_companion_test_but_never_ran` | Read(Tf) + later Edit(F) + zero verifier run referencing Tf by Stop | per-(F,Tf) | N/L | broaden verifier regex (npm run/make/just/nx/turbo); resolve package test script | Y/M |
| `vd_assertion_removed_near_covered_code` | assertion-count delta<0 on Tf + F edited + session-net assertion decrease | token diff | N/M | drop `should`/`chai`; require call-form `expect(`/`assert(` | Y/M |
| `vd_assertion_matcher_weakened` | matcher on same expect-target drops ≥2 specificity ranks + F edited | matcher rank diff | N/M | suppress regex/toMatch/calledWith; suppress if comment added | Y/M |
| `vd_code_edit_streak_no_verify` | editsSinceVerify≥8 AND linesSinceVerify≥60 | reset on verifier | N/M | active watcher = continuous reset; only languages w/ a configured verifier | Y/M |
| `vd_commit_no_verify_this_session` | `git commit/push` + verifier-count==0 + C≥3 | session | N/H | downgrade push block→nudge ("no verifier OBSERVED" ≠ harm) | Y/L |
| `vd_commit_while_last_verify_red` | commit/push while non-stale lastVerify.exit≠0 | per-commit | **B**/H | block only if red post-dates last code edit to failing set; needs stdout capture | **N**/M |
| `vd_red_to_green_by_test_weakening` | R0(fail)→R1(pass), only test edits between, net assertion↓ or new .skip/.only | verifier-run CEP | N/H | do NOT auto-escalate to block on following commit; weakened assertion must target changed code | **N**/M |
| `vd_skip_only_introduced_on_covered_test` | new .skip/.only/xit token on Tf covering edited F | token diff | N/M | split severity (.only/fit high); demote it.todo out; defer to Stop reconcile | Y/M |
| `vd_only_in_tree_at_commit` *(absorbs `obl_only_focus_false_green`)* | staged test-file diff has net-added live `.only/fit/fdescribe` | staged diff | **B**/H | real test files only (framework import); exclude fixtures; method-call on runner ident | Y/H |
| `vd_disabled_test_open_at_stop` *(absorbs `obl_skipped_test_never_reenabled`)* | session-introduced skip/only/todo/commented-it still in tree at Stop | obligation | N/M | session-introduced only; suppress justification/issue-linked; require commented-`it(` import check | Y/H |
| `vd_snapshot_churn_metric` | snapLines/codeLines ratio | session | M/L | exclude first-time snapshot creation | Y/H |
| `vd_snapshot_update_outpaces_code` | snap update where snapLines>3×codeLines or codeLines==0 | per-update | N/L | exempt snapshot file creation; attribute cascade to serializer/formatter edit | Y/M |
| `vd_verify_fail_then_unrelated_edit` | verifier fail (parse paths E) then next ≥3-4 edits avoid E + its companions/importers | stdout-parsed | N/M | treat transitive deps/shared type-decl/fixture as on-task; needs stdout capture | **N**/M |
| `vd_verification_cadence_decay` | inter-verify gaps strictly increasing AND g_n>2×g_{n-2} | last-3 gaps | M/L | needs ≥4 verifier runs; ≤1 soft nudge/session | Y/H |
| `vd_new_export_no_test_reference` | new exported callable, no test references identifier by Stop | export delta ∩ tests | N/M | resolve via namespace/re-export chains; exclude command/route registration | Y/M |
| `vd_branch_change_no_test_adjustment` | changed if/switch/&&/comparison/boundary-literal in F, no covering-test edit in W=8 | control-token diff | N/M | discharge on full-suite run; skip value-preserving (De Morgan) changes | Y/M |
| `vd_test_expected_matched_to_emitted_value` | expected literal X_new appears in F's new_string + git -S shows X_new session-new | literal diff + git pickaxe | N/M | nudge never block; soften (can't prove intent vs rubber-stamp) | Y/M |
| `vd_test_thrash_oscillation` | Tf edited ≥3× AND expected-literal value oscillates, no covering code edit between | sha + literal history | N/M | require ≥3 edits AND true value oscillation, not formatting; single A→B→A excluded | Y/M |
| `vd_net_negative_test_lines_at_commit` | staged: testNet>0 (deletion) AND codeNet≥0 | staged diff | N/M | downgrade push block→nudge; suppress if assertion COUNT non-decreasing | Y/L |
| `vd_coverage_floor_file_touched_no_test` | edit to a file in coverage-baseline(<floor)/untested-baseline, no test added/run | baseline lookup | N/L | gate on ≥3-line callable change; discharge on net-deletion/comment-only; Stop-only | Y/H |
| `vd_mock_of_sut_then_assert_on_mock` | Tf mocks F itself + assertions reference only the mock (no real F dataflow) | mock specifier ∩ SUT | N/M | resolve mock to F's own module; exempt importActual/spy-with-real | Y/M |

---

## Family 8 — Multi-Agent Coordination

Substrate: `loadRecentWorkspaceEvents(cwd, window)` joined to files-touched
(`content_sha256`, `agent_name`, deltas); ReservationManager `applyTransition`
state + `replayTransitions(reservation-events.jsonl)`; cohort `LOST_TIMEOUT_MS`.

| id | detects / exact signal | span | Act/Sev | FP guard | Now |
|---|---|---|---|---|---|
| `sha_revert_to_prior_other_agent` | B writes X back to a sha that predates A's intervening write | per-file sha history | N/M | B not re-read X after A's write; non-trivial (>N lines) | Y/M |
| `concurrent_region_edit_overlap` | B's old_string shares ≥20-char run w/ A's new_string, or A's edit post-dates B's last read | W=15min | N/M | raise threshold; require ≥1 non-whitespace identifier token; suppress if B re-read | Y/M |
| `duplicate_export_added_cross_agent` | two agents add an export of same name | Map<exportName,agents> W=30min | M/L | metric first; require different modules that import each other / share barrel | Y/M |
| `delete_depended_symbol_other_agent` | B removes export E while A's recent file still imports E | export delta + importers | N→B/H | demote to nudge default; BLOCK only w/ proven tsc missing-symbol on disk | Y/L |
| `reservation_conflict_write_nudge` | B writes X actively reserved (granted) by A | ReservationManager state | N/M | lost/idle suppression + auto-expiry; region-awareness when available | Y/H |
| `reservation_evict_then_immediate_write` | B evict_remote(X) then writes X in W=2min | replay reservation log | M/L | cohort signal → recurrence; no escalation w/o idle-owner check | Y/H |
| `ownership_ping_pong` | collapsed author seq for X has ≥4 alternations between two agents, distinct shas | W=20min @Stop | N/M | Stop-phase; suppress if later shas show forward progress (not returning to earlier) | Y/H |
| `cross_agent_overwrite_drops_added_lines` | B's write missing a line A added since B's last read | needs sha→blob cache | N/H | needs blob cache; report exact dropped lines | **N**/L |
| `divergent_shared_manifest_edit` | both agents edit same SHARED_COORDINATION path, B not re-read since A's edit | curated path set W=10min | N/M | fire only when same top-level section/key touched | Y/H |
| `duplicate_dependency_added_cross_agent` | both agents add same {ecosystem,name} dep | W=30min | N/L | only same manifest/workspace pkg; surface both versions | Y/H |
| `symbol_rename_divergence` | A renames N→M, B keeps N or renames N→P | body-overlap>0.8 W=15min | N/M | needs firm rename pairing; identifier len≥4; N unresolved post-rename | **N**/L |
| `delete_file_other_agent_active` | B `rm`/`git rm`/empties X another agent wrote within W=5min | parsed destructive op | N/H | exempt generated/tmp/dist/node_modules; suppress rename pairs | Y/H |
| `same_recurrence_signature_two_agents` | one harness_caught signature attributed to ≥2 agents | recurrences.jsonl | M/L | feed `recurrence propose`; gate on rare signatures | Y/H |
| `cross_agent_check_failure_inherited` | B builds on X where A left an unresolved proven (tsc) failure, B not fixing/reading it | join check-results | N/M | proven [fully_deterministic] only; suppress if A still active or region edited after fail | Y/M |
| `concurrent_codemod_double_apply` | both agents run same normalized MUTATE_MANY command in W=10min | full normalized cmd | N/M | match full args; exempt idempotent formatters (prettier/biome/rustfmt) | Y/H |
| `cross_agent_import_of_unwritten_export` | B imports {foo} from m where m lacks foo + m owned/edited by other agent | graph + ledger W=15min | N/M | suppress if B edited m; refresh graph; fire at Stop only if still open | Y/M |
| `cross_agent_format_churn_war` | both agents make format-only edits to X w/ differing shas | token-multiset diff W=20min | M/H | needs token-multiset diff; real signal = formatter-config disagreement | **N**/H |
| `abandoned_reservation_handoff` | B edits X reserved by idle A (now−last_event > LOST_TIMEOUT_MS) | explicit suppression companion | M/L | suppresses `reservation_conflict_write_nudge`; reuses cohort timeout | Y/H |
| `duplicate_test_same_sut_cross_agent` | two agents edit test files w/ same resolved SUT | companion W=30min | M/L | category-aware (unit vs e2e); de-dup hint only, never nudge | Y/H |
| `cross_agent_blast_radius_collision` | A changed M's export surface, B edits a caller of M without re-reading M's new surface | export delta + graph @Stop | N/M | breaking surface changes only; F must reference the specific changed symbol | Y/M |
| `reservation_bypass_after_conflict` | B got `conflict` for (B,X) then wrote X with no grant between | replay reservation log | N/M | suppress if A released between; suppress transient server-error conflicts | Y/M |
| `cross_agent_oscillating_value` | line range buffer shows ≥3 alternating-agent entries returning content_hash to prior value | ring buffer + agent | N/M | true hash-return A→B→A; both agents distinct; non-trivial range; confident mapping | Y/M |
| `multi_agent_uncommitted_pileup` | ≥3 uncommitted files each touched by ≥2 agents, no commit since both wrote | git diff ∩ author set @Stop | N/L | Stop-phase coordinate-nudge (not push gate); exclude generated/lockfile/snapshot | Y/H |

---

## Family 9 — Read / Edit Balance (acting on unseen content)

Substrate: readSet, writeCreatedSet, merged readWindows[file] intervals (folding
grep-hit lines as pseudo-reads), readSha[f], callIndex. Most are blind-edit
variants distinguished by *which* orientation signal is absent.

| id | detects / exact signal | span | Act/Sev | FP guard | Now |
|---|---|---|---|---|---|
| `reb_blind_edit_unread_file` | Edit to existing file ∉ readSet ∧ ∉ writeCreatedSet | PreToolUse | N/M | grep-hit covering the range = pseudo-read; suppress 1-line unique old_string | Y/M |
| `reb_blind_full_overwrite_existing` | Write to existing nonempty file ∉ readSet, content not prefix-superset | PreToolUse | B→N/H | downgrade block→nudge (full-overwrite of unread tracked file often legit) | Y/M |
| `reb_edit_outside_read_window` *(absorbs `reb_edit_distance_from_nearest_read_window`)* | edit span overlaps no readWindow ±S=10 lines | per-edit vs windows | N/M | fold grep-hit lines into windows; widen slack ≥15; skip single-page files | Y/M |
| `reb_partial_read_full_rewrite` | reads cover only prefix [1..k], k<EOF (cov<0.6), then truncating Write drops unread tail | partial-read → write | N/M | dropped lines must be non-blank real code, in no window, not moved to sibling | Y/M |
| `reb_stale_read_edit_sha_changed` | f read, sha changed since, edit w/o re-read | Read→change→Edit | N/H | fire ONLY when change attributable to a DIFFERENT origin (other agent/external git) | Y/H |
| `reb_read_recency_decay_edit` | gap>M=40 calls AND interveningUnrelated/gap>0.7 | per-edit vs lastReadIndex | M/L | metric for calibration; reset on grep returning file; weight only | Y/H |
| `reb_read_storm_no_edit` | run of ≥K=10 distinct Reads, dependency density<0.15, no edit | maximal run | M/L | downgrade to metric; raise K for large repos | Y/M |
| `reb_grep_storm_no_convergence` | ≥6 searches, query Jaccard<0.2 (drifting) AND hits non-narrowing, no edit | window | M/L | metric (hard to separate thorough vs flailing); keep BOTH conditions | Y/M |
| `reb_glob_no_followthrough` | search result set R (≤20), 0 of R read/edited in next L=8 | output→targets | M/L | tag confirmation greps out; metric only | Y/H |
| `reb_read_edit_ratio_anomaly` | rolling reads/(edits+1) outside per-agent baseline band | N=20 window | M/L | metric only; min sample before trusting baseline; wide cold band | Y/H |
| `reb_high_fanin_edit_without_dependent_read` | edit to exported symbol, fanin≥8, 0 dependents read | edit ∩ read history | N/M | edited span overlaps exported def AND non-additive diff | Y/M |
| `reb_breaking_signature_edit_without_caller_read` | accumulated diff changes export contract, 0 call-sites read | diff ∩ read history | N/M | dedup vs pending tsc; suppress if call-sites edited; orientation framing | Y/M |
| `reb_oscillating_read_edit_same_region` | Read,Edit alternation ≥3 cycles on same region, net diff small | per-region | N/M | require small-net-diff; exclude cycles where a check flipped block→allow | Y/M |
| `reb_blind_edit_then_revert` | blind edit E1 then E2.new trim-equals E1.old | composite | M/L | metric; escalate only if recurs ≥2× same region | Y/H |
| `reb_multi_file_coordinated_edit_underread` | ≥4 connected files edited, readFraction<0.4 | edit burst | M/L | downgrade to metric (normal sequenced refactor); count writeCreatedSet as known | Y/M |
| `reb_cold_start_first_edit_zero_reads` | first Edit to existing file, totalReads==0 ∧ totalSearches==0 | one-shot | N/L | suppress compaction/continuation marker + verbatim user patch | Y/M |
| `reb_grep_match_edit_without_reading_match` | grep flags f@L, edit >G=25 lines from every match, f unread | grep-hit → edit | N/L | combine w/ blind-edit; fold match lines into windows; far case only | Y/M |
| `reb_import_added_without_reading_module` | import of local module m, m ∉ readSet ∧ ∉ writeCreatedSet, not barrel-covered | import-edit | M/L | metric; promote only w/ a subsequent tsc import-resolution fail; exempt node_modules | Y/H |
| `reb_search_breadth_low_read_depth` | surfaced≥30 files, opened/surfaced<0.1 at first edit | pre-edit aggregate | M/L | metric only; per-repo calibration | Y/H |
| `reb_unrelated_read_fanout_no_dependency_edges` | last R=12 reads induce subgraph connectivity<0.1 | windowed | M/L | metric; combine w/ read_storm for stronger "lost" | Y/H |

---

## Family 10 — Future Readability (cumulative maintainability drift)

Mostly `silent_metric` by design — taste signals that accrete across edits.
Substrate: complexity-pulse AST stash (before/after per fn), per-file
line/comment counts, normalized literal/identifier tracking, layer config.

| id | detects / exact signal | span | Act/Sev | FP guard | Now |
|---|---|---|---|---|---|
| `fr_cap_creep_cumulative` | file crosses DEFAULT_MAX_LINES via many small edits (max single add <cap*0.25) | per-file lineCount | N/M | suppress non-logic-heavy additions (@codegen-data shape); Stop-surface | Y/M |
| `fr_cyclomatic_session_slew` | fn edited ≥3 calls, Σpos≥6, final CC>12 still ≤cap | per-fn AST | N/M | exempt switch-dispatch arms; name+arity+start-line match | Y/M |
| `fr_naming_convention_drift` | new symbols deviate from ≥85% file casing majority, ≥3 deviating | first-edit baseline | M/L | pure taste → metric; exempt boolean/handler/useX/onX | Y/L |
| `fr_undocumented_export_burst` | ≥5 new exports w/ no doc comment | per-file | M/L | demote to metric; exempt typed type/interface exports | Y/L |
| `fr_doc_comment_decay` | R<0.5×R0 AND codeLines grew≥30 | ratio time-series | M/L | metric only, drop nudge; exclude commented-out code from numerator | Y/M |
| `fr_magic_literal_proliferation` | same literal added ≥3× across edits, no named const | per-literal | N/L | numerics also ≥3; exempt HTTP codes/powers-of-2/time units; same-file cross only | Y/M |
| `fr_cross_layer_coupling_accretion` | 2nd distinct new cross-boundary import target from one source file | layer config | N/M | per target module not statement; exempt type-only/test; require explicit layer config | Y/M |
| `fr_stale_comment_after_rename` | later edit removes/renames X, a comment still names absent X | comment scan | N/M | suppress migration-shaped comments; X multi-segment, not common English | Y/M |
| `fr_file_local_synonym_split` | two new identifiers normalize equal (userId/user_id), same file, diff calls | normalize-key | M/L | most FP-prone → metric; require both value bindings in same fn | Y/L |
| `fr_param_count_creep` | fn param count grows ≤3→≥5 over ≥2 edits | AST stash | N/L | exempt options-object/destructured/constructor; required params only | Y/M |
| `fr_long_function_emergence` | fn crosses 80 lines, grew ≥20 this session | AST line-span | M/L | metric; escalate only w/ high CC(>10) or nesting(≥4) | Y/M |
| `fr_barrel_export_sprawl` | barrel re-export count +8/session or ≥40 total | per-barrel | M/L | metric only; drop absolute-total trigger if noisy | Y/H |
| `fr_doc_removed_on_live_export` | edit removes `/** */` block before a still-exported symbol, not relocated | export surface | N/M | broaden relocation suppression to same-session; exempt commented-out-code blocks | Y/M |
| `fr_duplicated_policy_constant_trajectory` | later edit adds bare literal == an earlier-session DEFAULT_*/_CAP/_THRESHOLD value | same-file caps | N/L | policy-shaped name + non-trivial value; exempt test files | Y/M |
| `fr_nesting_depth_creep` | fn max control-nesting reaches ≥5, rose this session | AST | N/L | control-flow nesting only (not callback/JSX/object); exempt JSX/data builders | Y/M |
| `fr_untyped_boundary_accretion` | net `: any`/`as any`/`Record<string,any>`/`: object` ≥3 in one file | per-file | M/L | metric (global ratchet owns enforcement); align w/ unvalidated_json_boundary; exempt tests | Y/M |
| `fr_abbreviation_rename_regression` | clear ident → opaque (len<0.6×, ≤2 chars / non-dictionary) | rename | M/L | subjective → metric; allowlist ctx/req/res/db/id/url/cb/fn/acc/el | Y/L |
| `fr_cohesion_drop_unrelated_exports` | export prefix-cluster count +≥2 AND total exports≥8 | leading-token clusters | M/L | weak proxy → metric, never nudge | Y/M |
| `fr_module_doc_absent_on_growth` | cumulative add≥100, first non-shebang line not a comment, public file | per-file | M/L | demote to metric; only where project uses module headers elsewhere | Y/L |
| `fr_copy_paste_block_accretion` | ≥5-line normalized-hash block added in ≥2 places, no helper extracted | per-hunk hash | N/M | keep identifiers in hash (placeholder canonicalization too aggressive) | Y/L |

---

## Family 11 — Cross-Session Recurrence

Substrate: `git log -S/-G/-L` pickaxe + blame; revert-pair message parsing;
recurrence.jsonl (harness_caught/missed, outcome markers, distinct_sessions);
cross-session blocked-action / baseline-block indices; edit-triple hashes.

| id | detects / exact signal | span | Act/Sev | FP guard | Now |
|---|---|---|---|---|---|
| `xsr_reintroduce_reverted_line` | added line L: `git log -S"L"` ≥2 commits AND most-recent is a net-removal of L; absent now | git pickaxe | N/M | exclude revert/temporary/release removal commits; suppress if L exists in another file | Y/M |
| `xsr_resurrect_deleted_export` | new export N previously declared-then-removed in history, absent now | export delta + `git log -G` | N/M | require body/signature similarity; exclude revert commits | Y/M |
| `xsr_repeat_blocked_command` | normalized Bash matches a guard-block from a prior session | cross-session block index | N/L | info nudge restating prior block reason+date; suppress if rule no longer fires | Y/H |
| `xsr_regress_past_fix_line` | edited line last set by a fix-message commit; new content closer to pre-fix than current | blame + diff | N/M | drop severity; require Levenshtein margin >30%; tighten message classifier to bug/CVE | Y/M |
| `xsr_recommit_reverted_hunk` | history has revert-pair (X,R); session added-line set Jaccard>0.6 w/ X | revert-pair parse | N/M | precise machine-format messages; raise floor for boilerplate; surface both SHAs | Y/H |
| `xsr_recurring_harness_missed_signature` | new content matches a `harness_missed` signature w/ distinct_sessions≥2 | recurrence.jsonl | N/M | operator-controlled precision; suppress if promoted to registered check; scope by flagged glob | Y/H |
| `xsr_check_oscillation_fixed_then_broken` | check C fires on F whose most-recent prior recurrence in another session was agent_fixed | recurrence outcome seq | M/L | metric until 2nd oscillation; key on (check,file,context-hash) | Y/H |
| `xsr_reopen_closed_obligation` | edit recreates opening-predicate fingerprint of a prior-session CLOSED obligation | obligation ledger | N/M | re-run closing predicate; stay silent if already satisfiable | Y/H |
| `xsr_file_sha_pingpong_across_sessions` | current sha appears under an earlier session_id w/ a distinct sha between | files-touched timeline | M/L | exclude codegen/generated; cross-session {churn+revert} labeler feed | Y/H |
| `xsr_constant_value_flipflop` | const NAME RHS == a prior-commit value AND ≥3 historical assignment commits | `git log -S/-G` | M/L | scope to exact declaration site; ≥3-change floor | Y/H |
| `xsr_recurring_blocked_package_install` | install/manifest dep matches a prior-session supply-chain block, still not allowlisted | block index + parser | N/M | live-allowlist re-check; adds context to existing block | Y/H |
| `xsr_resurrect_removed_lint_suppression` | suppression directive previously present-then-removed, removing commit touched same region | `git log -S` + `-L` | N/M | region-scoped + suppressions-unjustified still demands a reason | Y/H |
| `xsr_reintroduce_removed_import_edge` | import edge A→B previously existed-then-removed, absent in pre-edit graph | import delta + `git log -G` | N/L | only fire when removed edge crosses a layer boundary; distinguish type-only | Y/M |
| `xsr_recurring_check_failure_escalation` | (check,file) distinct_sessions≥3 and C fires again on F | recurrence aggregation | N/M | augments an already-firing check w/ cross-session count + propose-action | Y/H |
| `xsr_resurrect_deleted_test` | test block w/ title + body-Jaccard>0.7 matching a prior-deleted block | `git log -G` on title | M/L | metric (thrash report); never mid-edit | Y/H |
| `xsr_undo_other_agent_committed_change` | edited line last set by a different agent's commit, edit moves toward its pre-image | blame + agent attribution | N/M | nudge never block; recent commit only; suppress on squash/rebase ambiguity | Y/M |
| `xsr_handwritten_revert_of_generated_artifact` | hand-edit to a currently-generated file w/ ≥2 prior regenerate-revert commits | codegen marker + history | N/L | live codegen marker only; nudge points at generator command | Y/H |
| `xsr_flipflop_region_thrash_metric` | `git log -L` range has ≥3 alternations between two content hashes | range history | M/L | metric, never blocks; exclude generated + whitespace-only | Y/H |
| `xsr_recurring_todo_resurrection` | TODO message-tail previously add-then-removed, currently absent | `git log -S` | M/L | metric; message tail length≥12 | Y/H |
| `xsr_undo_label_combo` (`xsr_label_combo_cross_session_baddedit`) | cross-session literal-revert AND the reverted prior edit had a block/check-fail | composes two detectors | M/M | metric → labeler; nudge only when (b) was security/error-severity block | Y/H |
| `xsr_reintroduce_migrated_away_api` | new_string introduces a token removed project-wide (≥3 files) in one migration commit, 0 current occurrences | migrated-away set | N/M | distinctive/qualified token; removal commit must also add a replacement | Y/M |
| `xsr_identical_edit_replayed_across_session` | sha256(file\|old\|new) matches an Edit from an earlier session | edit-triple hash | M/L→N | nudge only at ≥2 prior sessions; exclude trivial/template edits | Y/H |
| `xsr_reintroduce_scrubbed_secret` | secret literal previously removed in history, currently absent, re-added | secret detector + `git log -S` | **B**/H | highest-confidence tier only (AKIA/ghp_/gho_/xox/PEM); never generic entropy | Y/M |

---

## Top 25 to build first

Ranked by **catch-value × low-FP-confidence × implementable-with-current-data**.
The cluster leans security-block (deterministic harm) + proven-composition graph
combos + Stop-time obligation inventories — all `low_fp:high`, all `Now:Y`.

| # | id | family | why first (catch × FP × data) |
|---|---|---|---|
| 1 | `xsr_reintroduce_scrubbed_secret` | xsr | re-adding a history-purged structured secret = proven harm, block, near-zero FP |
| 2 | `session_secret_persistence` | ratchets | live structured secret survives session; block on PEM/AKIA-pair/valid-PAT only |
| 3 | `sec_git_hook_backdoor` | sec | hook-write-with-sink + triggering git op; double-gated block |
| 4 | `sec_ssh_authorized_keys_inject` | sec | authorized_keys append, $HOME-confined; persistent backdoor, block |
| 5 | `sec_fetch_remote_script_then_execute` | sec | download external script then run; allowlist installers; block |
| 6 | `sec_secret_literal_flows_to_command` | sec | prefix-structured token from edit → egress arg; taint block |
| 7 | `sec_env_add_then_git_commit` | sec | secret added then committed; real-scanner-gated block |
| 8 | `sec_harness_disable_then_guarded_op` | sec | self-blinding vs sanctioned bypass allowlist; block |
| 9 | `vd_only_in_tree_at_commit` | vd | staged live `.only` = false-green; deterministic block, low FP |
| 10 | `obl_conflict_marker_persisted` | obl | 7-char marker run survives an edit; near-zero FP nudge |
| 11 | `sec_dns_exfil_burst` | sec | SECRET-read + high-entropy distinct-label DNS burst; high-sev, low FP |
| 12 | `gcb_high_fanin_export_removed` | gcb | export removed w/ K unfixed importers; block-escalates only on proven downstream fail |
| 13 | `gcb_blast_then_downstream_check_combo` | gcb | graph prediction confirmed by a proven check — strongest empirical combo |
| 14 | `gcb_barrel_reexport_dangling` | gcb | barrel re-exports a deleted symbol; lint-invisible, low FP |
| 15 | `gcb_test_references_removed_sut_symbol` | gcb | SUT symbol removed, test unedited — disables the safety net |
| 16 | `gcb_import_to_deleted_file` | gcb | static single-file delete leaves unrepointed importers |
| 17 | `gcb_broke_self_created_import` | gcb | session-created import broken by a later same-session edit |
| 18 | `churn_repeated_failing_bash` | churn | exact failing command re-run ≥3×; resets on edit; low FP |
| 19 | `churn_rerun_failing_test_no_source_change` | churn | family re-run with zero source change → guaranteed same result |
| 20 | `churn_revert_after_check_fail_combo` | churn | fail→literal-revert→re-apply, the labeler's top bad-edit shape |
| 21 | `obl_net_open_at_stop` | obl | one-shot Stop inventory of session-opened obligations; framed as list |
| 22 | `reb_stale_read_edit_sha_changed` | reb | edit after a DIFFERENT-origin sha change; high-confidence staleness |
| 23 | `xsr_repeat_blocked_command` | xsr | re-issuing a prior-session-blocked command; info nudge, no new FP |
| 24 | `xsr_recurring_check_failure_escalation` | xsr | (check,file) chronic across ≥3 sessions; augments an already-firing check |
| 25 | `churn_sha_cycle_revisit` | churn | file returns to an earlier session sha; ≥2 revisits/failing-check gate |

---

## Appendix — Needs new instrumentation (12)

Not buildable on current data; each names the missing capture.

| id | family | missing instrumentation |
|---|---|---|
| `cumulative_coverage_regression` | ratchets | incremental coverage index live + post-tool covered-line recompute |
| `crap_max_ratchet` | ratchets | per-edit overlay coverage (fresh coverage at edit time, not lagged) |
| `untested_file_floor_ratchet` | ratchets | coverage index + cross-tier companion-test resolution at new-file write |
| `vd_commit_while_last_verify_red` | vd | verifier stdout/exit capture + freshness join (red post-dates last edit) |
| `vd_red_to_green_by_test_weakening` | vd | paired verifier-run capture (R0 fail → R1 pass) with exit codes |
| `vd_verify_fail_then_unrelated_edit` | vd | verifier-stdout path parsing (tsc/vitest/pytest failing-file extraction) |
| `sec_untrusted_fetch_to_source` | sec | WebFetch response-body capture + content fingerprint/shingle set |
| `gcb_public_surface_unreachable` | gcb | reliable complete entrypoint declarations + reachability closure |
| `gcb_enum_member_removed_consumers_live` | gcb | precise enum/union consumer resolution (graph-resolved, not textual) |
| `cross_agent_overwrite_drops_added_lines` | multi | sha→blob content cache to reconstruct another agent's version |
| `symbol_rename_divergence` | multi | firm cross-agent rename-pairing (body-overlap + post-rename non-resolution) |
| `cross_agent_format_churn_war` | multi | token-multiset diff to classify format-only edits + formatter-config disagreement |

---

## Counts & notable merges

- **Input rules:** 244 across 11 families.
- **Surviving rules:** 233 (11 folded via dedup).
- **By action (survivors):** 10 `block` (all security/commit-gate proven-harm), ~150 `nudge`, ~73 `silent_metric`. Several nudges carry a *conditional* block-escalation gated on an independent proven check (`gcb_high_fanin_export_removed`, `delete_depended_symbol_other_agent`).
- **Implementable now:** 221 / 233; 12 deferred (appendix).

**Notable merges (kept the best-specified):**
1. `churn_undo_war_block` → `churn_undo_war_value_toggle` (hard block fails the low-FP bar per its own guard; survives as the loud value-naming nudge).
2. `churn_two_file_pingpong` → `component_oscillation` (graph-disconnect generalizes the 2-file case).
3. `churn_diff_added_removed_balance` → `net_vs_gross_churn_divergence` (identical gross-vs-net thrash metric).
4. `import_cycle_count_ratchet` → `gcb_import_cycle_across_edits` (the GCB version names both edges + adds the top-level-eval TDZ guard).
5. `obl_only_focus_false_green` → `vd_only_in_tree_at_commit` (same `.only` false-green, the commit-gate has the deterministic staged-blob block).
6. `obl_skipped_test_never_reenabled` → `vd_disabled_test_open_at_stop` (same Stop-time still-disabled inventory).
7. `obl_deleted_symbol_live_callers` + `breaking_export_removal_ratchet` → `gcb_high_fanin_export_removed` (one canonical export-removal-with-live-importers rule; GCB has importer-count scaling + proven-downstream block path).
8. `obl_new_module_unwired` → `gcb_orphaned_new_export` (GCB adds the ≥3-multiplicity gate that fixes the in-progress-scaffold FP).
9. `reb_edit_distance_from_nearest_read_window` → `reb_edit_outside_read_window` (the distance metric is the continuous form of the same window check).
10. `fr_open_todo_accretion` → `todo_stub_ratchet` (both net-TODO counting; the ratchet member owns enforcement).

Two cross-session/in-session sha-loop rules (`churn_cross_session_recurring_thrash`, `xsr_file_sha_pingpong_across_sessions`) were **kept separate**: the first is an escalation *wrapper* on an already-firing in-session churn rule; the second is the standalone cross-session-boundary detector feeding the labeler.