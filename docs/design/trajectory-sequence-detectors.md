# Trajectory Sequence Detectors (local tier)

**Status:** Design / not yet implementation (2026-05-27). Concrete near-term proposal for the local-tier sequence-detector family.

**Audience:** The next engineer (likely future-me) sitting down to extend the local trajectory machinery. Companion to [`trajectories-as-primitive.md`](trajectories-as-primitive.md) (master synthesis).

**References:**
- `trajectory.ts` — existing four-detector machinery; this doc extends, doesn't replace
- `turn-end.ts` — existing five turn-pattern detectors
- `pattern-detector.ts` — error-history-aware patterns
- `taint-tracker.ts` — sensitivity flow primitive sequence detectors consume
- `check-registry/index.ts` — where new detectors register
- `stop-rescan.ts` — Stop-event pattern rescan (already shipping); sequence detectors are a sibling family at the same Stop hook

**Memory:** [[feedback_harness_deterministic_only]], [[feedback_recurring_warnings_amplify_not_silence]], [[feedback_safety_continuity]].

---

## 1. The gap

The existing trajectory machinery covers four shapes in `trajectory.ts` (loop / destructive_sequence / unbackedoff_retry / silent_stall) and five turn-shapes in `turn-end.ts` (edit-without-test / repeated-failure / redundant-reread / write-without-read / file-thrashing). All nine are **agent-behavior shapes** — useful for catching agents that are spinning, retrying, or thrashing.

What's missing: detectors that fire on **how the trajectory looks from a security review perspective**. The shapes Anthropic's security-guidance plugin (intake: `docs/external-pulse/claude-code-security-guidance.md`) catches at end-of-turn via a model review, we want to catch via deterministic patterns at PreToolUse (block-time) or Stop (warn-time), with no model call.

This is the "individual tool call passes all our local checks but the sequence is suspicious" gap the user named.

## 2. Pattern grammar

A sequence detector is a pure function over `(SessionTrajectory, candidate event)`:

```ts
interface SequenceDetector {
    id: string;
    description: string;
    phase: "pre_block" | "pre_warn" | "stop";
    /** Returns zero or more matches for the (trajectory, candidate) pair. */
    fn(trajectory: SessionTrajectory, candidate: HarnessEvent): SequenceMatch[];
    /** Default state; user can override via .interlinked config. */
    default_enabled: boolean;
}

interface SequenceMatch {
    /** How many prior trajectory events anchor the match. */
    prior_event_count: number;
    /** Human-readable summary of the prior events that anchor the match. */
    prior_summary: string;
    /** Human-readable summary of the triggering candidate event. */
    trigger_summary: string;
    /** Up to 3 truncated, quoted snippets that are the basis for the finding. */
    evidence: string[];
}
```

**Phase contract:**

- `pre_block`: PreToolUse, fully-deterministic, low-FP, blocks by default. Agent gets a clear reason and an actionable next step. Same bar as `pre_block` content detectors.
- `pre_warn`: PreToolUse, deterministic, warn-only. Stderr-visible per the per-runner capability matrix; never blocks.
- `stop`: Stop-event scan, runs after-the-fact alongside `stop-rescan.ts`. Surfaces in a `[interlinked:sequence-rescan]`-style warning block.

**Detection vs. decision.** Detectors emit typed signals; they don't directly produce final decisions. The decision is whether the phase blocks or warns (per phase contract). Same shape as the content detectors at `check-registry/`. Cedar / GuardRule remains the decision point for any future config-driven override.

**Determinism contract.** Sequence detectors are `fully_deterministic` (per the determinism tag classifier in `quality-checks.ts::classifyDeterminism`) — they match on event-stream shape, not on inferred intent. They tag as `[proven]` in stderr-surfaced warnings.

## 3. Initial catalog (twenty-three detectors, four families)

The bar for each: **shape is unambiguous; FP rate measured against legitimate workflows is low; the harm-shape is well-documented elsewhere.** Ordered by severity tier within each family.

Four loosely-grouped families (the numbering is flat; the groupings are a reading aid):

- **Sequence-shape security** (§3.1, §3.2, §3.3, §3.7, §3.8, §3.9): supply-chain, environment injection, repetition shapes
- **Cross-agent staleness** (§3.4, §3.6, §3.10): multi-player state coordination
- **Prompt-injection / exfiltration** (§3.5, §3.11–§3.15): the lethal-trifecta pack — §3.11 is the central structural block; §3.5, §3.12, §3.13, §3.14, §3.15 are partial-leg detectors that catch the shape earlier in the attack chain. See the composition note after §3.15.
- **Quality** (§3.16–§3.23): coverage, doc drift, refactor hygiene, plan adherence. Most are `stop` phase (advisory or nudge); two are pre_warn (`add_then_revert_loop`, `plan_vs_trajectory_drift_quality`). Proof that trajectory-as-primitive is dual-use — same mechanism, two consumer families. See [`trajectories-as-primitive.md`](trajectories-as-primitive.md) §4.1.9 for the framing.

### 3.1 `secret_read_then_network_call` (pre_block)

**Fires when:** the session has any taint source with `level >= "Confidential"` (already tracked by `TaintTracker`), AND the candidate event is a network-capable Bash command (`curl|wget|fetch|nc|ssh|scp|rsync|http`) targeting a non-local host, AND no intervening explicit user-permission acknowledgment.

**Why pre_block:** the exfiltration pattern is unambiguous; FP rate against legitimate workflows is low (production deploys do `kubectl` / `aws` / authed APIs, not bare `curl`).

**Implementation hook:** already half-shipped — `checkProvenanceTaintToExternalAction` in `evaluator/taint-guards.ts` does an adjacent check using provenance. This detector adds the *sensitivity* axis to that check.

**Defer escape hatch:** standard `// interlinked: defer secret_read_then_network_call -- <reason>` on the file containing the network call (or above the line).

### 3.2 `download_then_execute` (pre_block)

**Fires when:** a recent (last 10 events in `tool_sequence`) Bash invocation downloaded an artifact (curl/wget producing a writeable file at `-o <path>` or `> <path>`), AND the candidate event is execution of that artifact path (Bash with `bash <path>` / `./<path>` / `python <path>` / `chmod +x <path>` adjacent).

**Why pre_block:** download-and-run is among the highest trust-violation shapes in supply-chain compromise. If the agent legitimately needs to install via `curl | bash`, the existing package-allowlist gate at `src/harness/evaluator/package-install-guard.ts` is the proper path.

**FP-controlling caveat:** explicit allow path for `.interlinked/`-internal artifacts and known-safe install scripts (`get.docker.com`, `sh.rustup.rs`) — these are already-allowlisted via `package-allowlist`. The detector should query the allowlist before firing.

### 3.3 `install_then_unauthored_execute` (stop)

**Fires when:** the session contains a package-install command (any ecosystem — npm/pip/cargo/gem/go via the parser at `package-install-parser.ts`), AND a subsequent execution of a script file that was NOT created by the agent (no `Write`/`Edit` event for it in this session, AND no `Read` event for it before execution).

**Why stop (not pre_block):** the `--ignore-scripts`-aware pre-install gate already catches post-install scripts via `builtin-npm-no-ignore-scripts`. This detector covers the orthogonal "script lands on disk via install, agent then runs it without reading first" shape — Stop-event because the harm is the cumulative pattern across a turn, not a single call.

### 3.4 `stale_read_then_write` (pre_warn)

**Fires when:** the candidate is a Write/Edit to file X, AND `activity.jsonl` shows a write to X by another agent (different `agent_name`, same workspace) after this session's last read of X, AND this session has not re-read X since.

**Why pre_warn (not block):** the operator may have intentionally accepted the other agent's edit. Warning gives the agent a chance to re-read before overwriting.

**Cross-session implementation:** requires bounded read of `activity.jsonl` — outside the per-session in-memory model. Implementation note: only the last N events (capped, e.g., 500) need to be loaded; bounded I/O. Cache the load across calls within a Stop turn.

### 3.5 `network_after_user_input_url_match` (REMOVED 2026-06-26)

**Status:** removed. The shipped implementation sourced its URL set *solely* from
the user's own prompt (`session.recent_user_urls`, populated at
`UserPromptSubmit`), so it fired only when the agent made a network call to a
host the **user had explicitly named** — an authorized destination, never the
indirect-injection shape it advertised. As written it was a pure
false-positive generator (it flagged e.g. `git clone <url-the-user-pasted>`),
and the spec above already conceded that "use this URL the user gave me" is
legitimate. The fetched-content half it was *meant* to cover was never built:
taint sources carry `<WebFetch-response>` pseudo-paths, not the hosts named
inside the fetched body.

**The correct version (future work):** track hosts that appear in *untrusted
fetched output* (WebFetch / WebSearch / MCP-remote response bodies) as a
distinct suspicion set, fire when a non-local network call targets one of those
hosts, and treat *user-named* hosts as a **suppressing authorization allowlist**
(the inverse of the old polarity). Until that extraction exists, the adjacent
real shapes are covered by §3.11 `lethal_trifecta_structural`, §3.12
`fetched_external_then_secret_read`, §3.13 `github_issue_body_then_action`, and
§3.15 `plan_vs_trajectory_drift`.

### 3.6 `subagent_diverged_edit` (stop)

**Fires when:** a `SubagentStop` event indicates a subagent wrote file X, AND the parent agent's `files_read_at[X]` is older than the subagent's write timestamp, AND the parent has subsequently edited X without re-reading.

**Why stop:** prevents the "parent applies stale edits over subagent's work" pattern. Cleanly addressed by either re-reading or trusting the subagent's intent.

**Implementation hook:** `SessionTracker` already tracks `file_read_at` and `file_write_times`. The subagent linkage already exists via `resolveParentSessionId` in `lifecycle-events.ts`.

### 3.7 `env_modification_then_bash` (pre_warn)

**Fires when:** the candidate Bash command's environment includes a modified-this-session variable (LD_PRELOAD, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES, PATH-prepend, PYTHONPATH, NODE_OPTIONS, RUBYOPT) AND that modification was made via Edit/Write to a shell init file or via an explicit `export` Bash earlier in the session.

**Why pre_warn:** library-injection / shim shapes. Legitimate tool setup (e.g., `nvm`, `pyenv`) is the dominant FP path — but they don't usually edit profile files mid-session.

**Implementation hook:** `DANGEROUS_ENV_VARS` already exists in `types/env-vars.ts`; cross-reference with `session.commands_run` for shell-init Edit/Write events.

### 3.8 `npm_run_then_curl_to_localhost` (pre_warn)

**Fires when:** session contains `npm run <something>` / `pnpm <task>` / `yarn <task>` / `bun <task>` / `vite` / `next dev` / similar dev-server-launching command, AND candidate Bash is curl/wget against localhost on a non-standard port.

**Why pre_warn:** the dev-server-probing pattern — usually legitimate (the agent is testing its work), occasionally a vulnerability scan or credential probe. The existing `curl_localhost_count` field already tracks this; the sequence detector adds the "after a dev server started" anchor so the FP rate is lower than blanket localhost-curl warning.

**Why not a block:** dev-server probing is a normal-frequency agent activity in web workflows.

### 3.9 `same_command_thrice_no_observe` (pre_warn)

**Fires when:** the candidate is the third identical (normalized via §5.1 of master doc) Bash invocation in a row with no intervening Read of its output, no `PostToolUseFailure` (which would route through `unbackedoff_retry` instead), and no observable state change between attempts.

**Why pre_warn:** generalization of the existing `unbackedoff_retry` shape, but for *successful* repeats — agent is re-running without consuming the previous result. Conservative threshold (3, not 2) to avoid breaking legitimate flake-handling workflows.

**Relationship to existing detectors:** complements `tool_loop` (which fires on Edit/Write loops) and `unbackedoff_retry` (which fires on failure retries). This covers the success-but-pointless-repeat gap.

### 3.10 `file_overwrite_after_other_agent` (pre_warn)

**Fires when:** the candidate is a Write to file X, AND `activity.jsonl` shows another agent (different `agent_name`, same workspace) wrote to X in the last hour, AND this session has not read X at all.

**Why pre_warn:** strict superset of `stale_read_then_write` (§3.4) — fires even when the parent never read X, just is about to overwrite what someone else just wrote.

**Why warn vs. block:** legitimate when the operator deliberately starts a new agent to overwrite stale work. Block would create a friction wall around multi-agent collaboration.

### 3.11 `lethal_trifecta_structural` (pre_block)

The central injection-defense detector. Fires when the trajectory satisfies all three legs of Simon Willison's lethal-trifecta framing simultaneously:

- **Leg 1 — Private data access:** `session.sensitivity_level >= "Confidential"` OR any `taint_sources` entry at that level.
- **Leg 2 — Untrusted content exposure:** any `taint_sources` entry with provenance ∈ {`fetched_external`, `mcp_remote`, `document_content`, `user_provided`}.
- **Leg 3 — External communication:** candidate event is a network-capable operation targeting a non-local host (Bash `curl|wget|fetch|nc|ssh|scp|rsync|http`, gist creation, webhook POST, etc.).

**Why pre_block:** the conjunction *is* the exfiltration trigger. Each leg in isolation is innocuous; together they are the textbook trifecta. FP rate is provably low because all three legs are deterministically tagged by existing primitives (`TaintTracker`, `TaintProvenance`, Bash parser). Crucially, this detector **does not depend on detecting injection content** — only on its consequences.

**Implementation hook:** strict superset of `secret_read_then_network_call` (§3.1) — same network-call detection, additional constraint that fetched/mcp_remote/document/user-provided taint is also active.

**Defer escape hatch:** `// interlinked: defer lethal_trifecta_structural -- <reason>` on the trigger line. Legitimate use case: operator deliberately needs to post processed data to an authed endpoint while the trajectory includes an attacker-irrelevant public README read.

### 3.12 `fetched_external_then_secret_read` (pre_warn)

**Fires when:** the trajectory contains a `fetched_external` taint source (WebFetch / WebSearch / `gh issue view` / `gh pr view` / `gh api` — provided the Bash-output provenance gap is closed; see §10), AND the candidate event is a Read of a sensitivity-tagged file (`level >= "Confidential"`).

**Why pre_warn (not block):** legitimate "fetch a README, then check local config to interpret the install instructions" workflows exist. Warn gives the agent room to reconsider; the operator can re-acknowledge.

**Composes with:** §3.11 (when the trifecta then completes, the block fires); §3.1 (when the secret-read is followed by a network call, the block fires regardless of fetched_external).

### 3.13 `github_issue_body_then_action` (pre_warn)

**Fires when:** the session contains output from `gh issue view`, `gh pr view`, `gh gist view`, `gh api`, or similar attacker-controllable GitHub surfaces (provided their output is tagged `fetched_external` — see §10), AND the candidate event would alter agent behavior in a way that aligns with content in that output (network call to a URL named in the fetched content, file Read of a path named in it, command execution of a string from it).

**Why pre_warn:** "use this URL/path/command the user gave me via gh CLI" is sometimes legitimate, but executing instructions extracted from a GitHub issue body is the textbook indirect-injection-via-credibility-signaling shape. The harness can detect the destination-matches-content shape deterministically; whether the content is *intended* as an instruction is for the operator to confirm.

**Relationship to §3.5:** §3.5 was removed (it only ever fired on user-named hosts; see its entry). The general "network call to a host named in WebFetch/WebSearch output" path it was meant to cover is unbuilt. This detector covers the gh-CLI path, which today doesn't get a WebFetch-style provenance tag (see §10).

### 3.14 `exfil_to_public_writeable` (pre_block on deterministic surfaces, pre_warn on ambiguous)

**Fires when:** the session has any taint source with `level >= "Confidential"`, AND the candidate event writes to a public-writeable surface.

**Deterministic-decidable surfaces (pre_block):**

- `gh gist create` (gists default to public on most installs)
- `gh gist create --public` (explicit)
- POSTs to known sink hostnames (telegram bot API, discord webhook, pastebin.com, transfer.sh, dpaste, ix.io, …)
- Direct curl/wget to any non-allowlisted external host (already covered by §3.1; this detector adds the explicit gist/webhook surfaces and the `--public` flag check)

**Undecidable-locally surfaces (pre_warn):**

- `gh pr comment` / `gh issue comment` — private vs public repo not knowable without an API call
- `gh release create` — depends on the destination repo's visibility
- File writes inside the working tree that may or may not be committed to a public branch

**Why split:** the deterministic cases are unambiguous exfiltration shapes; the undecidable cases include legitimate workflows (PR comments to private repos are normal). Block deterministic, warn on ambiguous. Operators can escalate-deny via config if the undecidable cases need to be enforced.

### 3.15 `plan_vs_trajectory_drift` (pre_warn)

**Fires when:** the session has a `declared_plan` (`session.declared_plan`, populated by `plan-capture.ts`), AND the candidate event is incompatible with the plan's declared scope, AND a `fetched_external` taint source was ingested between the plan capture and the candidate event.

**Why pre_warn:** novel injection signal that *doesn't depend on detecting the injection content itself* — behavior drift after untrusted-content ingestion IS the signal. The plan tells us what the agent declared it would do; the trajectory tells us what it's doing now; `fetched_external` between the two is the candidate cause.

**FP-controlling caveat:** plans drift naturally as work proceeds (discovery, scope evolution). The detector fires only when (a) the candidate touches different files/paths than the plan scope OR uses different tool categories (plan said "Edit src/auth", candidate is a `Bash` network call), AND (b) the `fetched_external` anchor exists between plan and drift. Both anchors required — drift alone is normal; drift after untrusted-content ingestion is the signal.

**Implementation hook:** `declared_plan` already exists; `taint_sources` already tracks provenance + `at_step`. The detector is a join across the two existing primitives.

### Composition note — the injection-defense pack

§3.11 (`lethal_trifecta_structural`) is the central structural block; §3.5, §3.12, §3.13, §3.14, §3.15 are partial-leg detectors that surface earlier in the attack chain or catch shapes §3.11 can't see (semantic-injection-via-credibility, plan drift). The composition is intentional defense-in-depth: each detector catches the shape *before* the trifecta completes, with §3.11 as the final structural gate. An attacker bypassing one earlier detector must bypass the others; bypassing all of them requires bypassing every leg of the trifecta at once. None of these detectors require detecting the injection content itself — they consume trajectory state directly.

### 3.16 `signature_change_callers_not_updated` (stop)

**Fires when:** an exported function / type / class signature changed in file A this session (detectable via comparing pre-edit and post-edit `export_surface`), AND files importing from A (per the project graph) have not been edited or read this session.

**Why stop:** prevents the "renamed a function, broke callers, didn't notice" pattern. Per-file `impact-analysis.ts` already exists; the trajectory anchor (did the agent at least look at the callers this session?) is what makes the detector deterministic instead of advisory.

**Implementation hook:** consume `pending_completions` (already populated when export surface changes) + `session.files_read` / `files_written` / `file_read_at`. The detector asks "for every entry in `pending_completions`, are all `affected_files` in `files_read ∪ files_written`?".

### 3.17 `regression_test_missing_after_fix` (stop)

**Fires when:** agent edited a file with a `failed_files` entry from earlier this session (any check failure), AND no test file was edited / created that exercises the fixed code path.

**Why stop:** bug-fix without regression test is one of the most common quality gaps. The trajectory anchor (which file failed earlier this session) makes the detector deterministic rather than heuristic. Distinguishes from generic edit-without-test by requiring the prior-failure anchor.

**FP-controlling caveat:** "test exercises the fixed code path" is approximated as "sibling test file edited / created in same session" (e.g., `src/foo.ts` failed → `src/foo.test.ts` was edited). Strict path-sibling check avoids the "any test file was edited" FP.

**Implementation hook:** `session.failed_files`, `assertion_counts` deltas, `tdd_cycles` state machine — all already shipped.

### 3.18 `magic_literal_cross_file_proliferation` (stop)

**Fires when:** the same non-trivial literal (string ≥8 chars OR number outside common `-1..256` range, excluding well-known constants like HTTP status codes) was introduced in ≥3 distinct files this session.

**Why stop:** the per-file `magic_literal_in_conditional` advisory detector exists but is blind to cross-file repetition. Trajectory is what ties them — the same magic value spread across files should be a constant.

**Implementation hook:** add a session-scoped `Map<literal_hash, Set<file>>` populated at PostToolUse from each newly-introduced literal in `files_written`. Stop-phase emit when any entry's `Set.size >= 3`. Aggregation is incremental — extract literals on each edit, check threshold at Stop.

### 3.19 `stale_doc_sibling` (stop, advisory)

**Fires when:** agent edited `src/foo.ts`, AND sibling doc file exists (`docs/foo.md`, `foo.types.ts`, co-located `README.md` in the same dir, or `src/foo.d.ts`), AND the sibling was not edited or read this session.

**Why stop (advisory):** doc drift catches at the moment of writing, not as a deferred sweep. Advisory because plenty of edits don't warrant a doc update (type-only changes, internal refactors); the bar for opening a doc finding is lower than for code findings.

**Implementation hook:** path heuristics + `fs.stat` + `session.files_read` / `files_written` set membership. Sub-ms per touched file.

### 3.20 `coverage_silent_regression` (stop)

**Fires when:** agent added > 20 lines of executable code (excluding imports, type declarations, JSDoc) to source files this session, AND no test files were edited or created, AND existing tests still passed at session end (per `session.test_runs`).

**Why stop:** stricter than the existing `edit-without-test` turn pattern. Catches the specific "tests still pass after adding code" coverage-hole signal — code landed, no new tests, suite still green, which means new code is unverified. Threshold (20 lines) tunable per workspace.

**Implementation hook:** lines-added via existing diff-aware machinery in `diff-aware-checks.ts`; test-file detection via path heuristic; test green status via `session.test_runs: Map<string, { status, at_step }>`. All three primitives already shipped.

### 3.21 `add_then_revert_loop` (pre_warn)

**Fires when:** the same line range in the same file was edited 3+ times in opposite directions this session (add → remove → add OR change-to-X → change-to-Y → change-back-to-X), based on content-hash comparison of the range's pre-edit state.

**Why pre_warn:** line-precise version of the existing `file-thrashing` turn pattern (which is file-coarse). Catches AI-hallucination cycling where the agent keeps revising the same logic without converging.

**Implementation hook:** new session-state field `recent_line_edits: Map<file, RingBuffer<{ range, content_hash, at_step }>>` capped at ~20 entries per file. O(1) insert at PostToolUse; constant-time hash-match check at PreToolUse. Same shape as the existing `tool_sequence` ring buffer — extended from per-session to per-file with line-range precision.

### 3.22 `unused_helper_introduced` (stop)

**Fires when:** an exported function / class was added to a file in this session (no prior export with the same name), AND no callers were added in this session (no other `files_written` imports from the new export), AND no existing callers are present in the project graph.

**Why stop:** "wrote a helper, never used it" is a refactor-tail smell. Adjacent to `dead_exports` (already shipped) but with a trajectory anchor — fires the same turn the helper was written, rather than waiting for the next dead-code sweep.

**Implementation hook:** `dead_exports` already does the project-graph caller lookup. The trajectory anchor is "was this export new this session?" — diff query against pre-session content for the file in `files_written`.

### 3.23 `plan_vs_trajectory_drift_quality` (pre_warn)

**Fires when:** the session has a `declared_plan` (`session.declared_plan`, populated by `plan-capture.ts`), AND the candidate event is incompatible with the plan's declared scope (different files / paths / tool categories), AND there is *no* `fetched_external` taint source between the plan capture and the candidate event.

**Why pre_warn (quality flavor):** same detector shape as the security-flavored §3.15, but interpretation differs. With no `fetched_external` anchor, the drift is most likely scope creep rather than injection-induced — warn at a quality level, "you've drifted from the declared plan; update it or refocus."

**Relationship to §3.15:** §3.15 fires when drift coincides with untrusted-content ingestion (potential injection); §3.23 fires when drift happens without that anchor (likely scope creep). Same detection shape, two interpretation tracks — implement once, gate the message and severity on the `fetched_external` presence.

### Composition note — the quality pack

§3.16–§3.23 are the quality-flavored family of trajectory detectors. They consume the same trajectory state as the security detectors (files_read, files_written, failed_files, declared_plan, tool_sequence, taint_sources) but answer different questions — coverage, doc drift, helper utility, refactor hygiene, plan adherence. Most are `stop` phase because quality FPs hurt less than security FPs (warn vs block); the two pre_warn detectors (§3.21, §3.23) fire on shapes the agent can fix immediately. Together with the already-shipped `turn-end.ts::detectTurnPatterns` (5 patterns), `pattern-detector.ts::getPatternWarnings` (4 patterns), `non_null_assertion_ratchet`, `as_any_ratchet`, and `verification-stop-checks.ts` (3 nudges), the quality pack is **proof that trajectory-as-primitive is dual-use** — same mechanism, two consumer families. See [`trajectories-as-primitive.md`](trajectories-as-primitive.md) §4.1.9 for the framing.

## 4. Wiring

Same registry pattern as the content detectors (per the agent-quality checks convention pinned in CLAUDE.md):

1. **Implementation** in `src/harness/sequence-checks/<family>.ts` (new dir; mirror `checks/<family>.ts`). One family per security shape: `supply-chain.ts`, `exfiltration.ts`, `cross-agent-staleness.ts`, etc.
2. **Registry entries** in `src/harness/check-registry/entries-warnings.ts` (for `pre_warn` / `stop`) or `entries-errors.ts` (for `pre_block`).
3. **Phase contract:** extend `CheckPhase` in `check-registry/types.ts` if a `trajectory_*` variant proves cleaner; otherwise reuse existing phase ids and discriminate via a `kind: "sequence"` field on the registry entry. Lean toward the latter — fewer phase variants is better.
4. **Metadata** in `src/harness/check-metadata/sequence.ts` (new file; same shape as `check-metadata/generic.ts`).
5. **Test pattern:** ≥3 negative cases (legitimate sequences that must NOT fire) and ≥3 positive cases per detector (per the agent-quality checks convention). Sequence tests need fixture sessions, not file content — pattern: build a `SessionTrajectory` fixture, feed events one at a time, assert which call fires the detector.

## 5. Configuration

```jsonc
// .interlinked/config.local.json
{
    "sequence_detectors": {
        "enabled": true,
        "disabled_ids": ["plan_vs_trajectory_drift"],
        "block_to_warn_downgrade": ["secret_read_then_network_call"]
    }
}
```

- **Default-on.** Per [[feedback_recurring_warnings_amplify_not_silence]], we don't silence by default.
- **Per-id disable.** Per-pattern disable, not category-wide — matches the per-pattern controls already exposed for content detectors.
- **Per-id downgrade.** A `pre_block` detector can be downgraded to `pre_warn` via config. This is the **only** allowed config direction; never upgrade a local warn to a local block, because that would amplify FP-prone patterns past the harness's deterministic-confidence bar.

## 6. Stop-event integration

Stop-event sequence detectors (Phase `stop`) run after `verification-stop-checks.ts` and `commit-cadence.ts`, and alongside `stop-rescan.ts`. They share the same defer-marker contract:

- `// interlinked: defer <detector-id> -- <reason>` on the trigger line (or above it) acknowledges the finding
- Two output groups in the Stop warning block: **unaddressed** (warns loudly) and **acknowledged-deferred** (logged but not amplified) — identical to the current `stop-rescan.ts` output split

For multi-event sequence findings where there's no single "trigger line" (e.g., `install_then_unauthored_execute` spans an install command and a later execution), the defer marker attaches to the **trigger** event's file/line (the execution, in this example), not the prior event.

## 7. Performance budget

Sequence detectors run on every PreToolUse and Stop. Per [[feedback_hook_latency_budget]], the harness budget is sub-100ms for the full PreToolUse pipeline. Per detector:

- **PreToolUse detectors (`pre_block` / `pre_warn`):** target < 1ms per detector. About fourteen detectors fire at PreToolUse (the four `pre_block` plus the ten `pre_warn` shapes across all four families); 14 × 1ms = 14ms slice (well under the sub-100ms pipeline budget). Means: linear scan over `tool_sequence` (cap 20) and `taint_sources` (typically O(10)), no regex compilation per call (compile-once at module load), no fs I/O on hot path. The trifecta detector (§3.11) is three constant-time predicates over already-computed session state — trivially cheap. The quality pack's `add_then_revert_loop` (§3.21) is a per-file ring-buffer hashmap lookup — also trivially cheap.
- **Stop detectors:** about nine detectors fire at Stop (mostly the quality pack §3.16–§3.20, §3.22 plus the cross-agent stop ones). Target < 50ms total. The heaviest is `magic_literal_cross_file_proliferation` (§3.18) — its `Map<literal_hash, Set<file>>` aggregation is incremental (populate at each PostToolUse, check threshold at Stop), so per-Stop cost is just the map walk, not a re-scan.
- **Stop detectors with cross-session I/O:** §3.4, §3.10 (cross-agent staleness) need to load `activity.jsonl` — cache the load across the Stop turn — single bounded read of the trailing N events. §3.16, §3.22 (signature-change-callers, unused-helper-introduced) need a project-graph query — cache via the existing `ProjectGraph` machinery.

## 8. What this doc explicitly does NOT do

- **Does NOT propose changing the existing four detectors in `trajectory.ts`.** They're working; extend, don't refactor.
- **Does NOT propose ML / heuristic / anomaly scoring.** All twenty-three initial detectors are deterministic shape-matches over trajectory state. The Tier 2 cloud classifier (`three-tier-architecture-v2.md`) covers the semantic side (e.g., "this fetched content contains imperative-mood instructions targeting the agent") — that's complementary, not redundant. See [`trajectories-as-primitive.md`](trajectories-as-primitive.md) §4.2.5 for the local + cloud layered defense framing.
- **Does NOT propose per-pattern auto-tuning.** Per [[feedback_recurring_warnings_amplify_not_silence]], we amplify recurring warnings, not silence them. Tuning happens via PR-reviewed code, not via runtime adaptation.
- **Does NOT propose any cloud submission.** These detectors are pure local — no events leave the machine. Cloud trajectory submission is a separate decision in `three-tier-architecture-v2.md` §6.4.
- **Does NOT replace `stop-rescan.ts`.** Sequence detectors are sibling-family at the same Stop hook. Both run; both contribute to the Stop warning block.

## 9. Rollout sequence

If/when this lands, ship in five PRs (per the convention of small, separable PRs). The detailed plan with per-PR LoC budgets, test-fixture strategy, and phasing rationale lives in [`trajectory-detectors-implementation-plan.md`](trajectory-detectors-implementation-plan.md); the summary here:

1. **PR1: scaffolding + Bash-CLI provenance fix + trajectory inspection commands.** New `sequence-checks/` dir, `SequenceDetector` interface, registry wiring, no detectors. Plus the §10 provenance fix (tag `gh` / `glab` / `wget` / `curl` Bash output `fetched_external`). Plus `interlinked trajectory show` / `interlinked trajectory replay` diagnostic commands so PR2+ have a testing surface. One placeholder detector that always returns `[]`. Get the wiring + provenance + commands through CI and the verify pipeline.
2. **PR2: quality pack as the framework's beachhead.** Ship §3.16–§3.23. Quality detectors are mostly stop-phase / pre_warn so the FP cost of getting the framework wrong is low — they're the right first set to validate the scaffolding end-to-end. Each with ≥3 positive + ≥3 negative tests.
3. **PR3: sequence-shape security pre-block / pre-warn.** Ship §3.1 (`secret_read_then_network_call`), §3.2 (`download_then_execute`), §3.8 (`npm_run_then_curl_to_localhost`), §3.9 (`same_command_thrice_no_observe`). Pre-block tier — FP rate matters; framework is already battle-tested from PR2.
4. **PR4: stop + cross-agent detectors.** Ship §3.3 (`install_then_unauthored_execute`), §3.4 (`stale_read_then_write`), §3.6 (`subagent_diverged_edit`), §3.7 (`env_modification_then_bash`), §3.10 (`file_overwrite_after_other_agent`). The cross-session ones (§3.4, §3.10) require the bounded-read `activity.jsonl` helper — that's the load-bearing infra in this PR.
5. **PR5: prompt-injection defense pack.** Ship §3.11 (`lethal_trifecta_structural`) as the central block, plus §3.5 (`network_after_user_input_url_match`), §3.12 (`fetched_external_then_secret_read`), §3.13 (`github_issue_body_then_action`), §3.14 (`exfil_to_public_writeable`), §3.15 (`plan_vs_trajectory_drift`). Ship together so the defense-in-depth story is coherent at landing — each detector catches a different stage of the attack chain, and a single PR keeps the composition note (after §3.15) testable as a unit.

Each PR ≤ ~600 LoC including tests. Run the existing `e2e-protocol-suite.mjs` probe after PR2 and again after PR5 to confirm no regression in the block-allow-warn split.

**Rationale for quality-first (PR2 before PR3–5):** the security pack ships block-tier detectors where FP rate matters; the quality pack is all warn/advisory. Shipping quality first means we validate the scaffolding under low-stakes conditions before any block-tier detector goes live. If the framework has a subtle bug (event ordering, fixture-replay mismatch, registry-discovery race), it surfaces against a non-blocking pack first.

**Non-detector primitives shipped separately:** the master doc names two non-detector primitives that consume trajectory state — `untrusted_context_lockdown` (§4.1.7) and `output_egress_filter` (§4.1.8). Neither is in the rollout above because they don't use the sequence-detector framework. Estimated: a separate small PR each (~200–300 LoC + tests), schedulable in parallel with PR2–PR5.

## 10. Non-detector prerequisite — provenance tagging for web-fetching Bash CLIs

Several detectors in the injection-defense pack (§3.5, §3.12, §3.13, §3.14) depend on output from web-fetching CLIs being tagged `fetched_external`. Today the provenance tagging fires on `WebFetch` / `WebSearch` tool calls but not on Bash-routed equivalents — so `gh issue view` returns attacker-controllable content with the wrong (`local_read`) provenance, and the detectors silently underperform.

Closing the gap is a small standalone change: a parser-style extension that recognizes web-fetching CLI verbs and tags their stdout/stderr `fetched_external` at PostToolUse. Initial pattern table:

| Command shape | Tag |
|---|---|
| `gh issue view` / `gh pr view` / `gh gist view` / `gh api` | `fetched_external` |
| `glab issue view` / `glab mr view` | `fetched_external` |
| `curl <url>` / `curl https://...` (any non-localhost URL) | `fetched_external` |
| `wget <url>` | `fetched_external` |
| `http <url>` / `https <url>` (httpie) | `fetched_external` |
| `npm view <pkg>` / `pip show <pkg>` (queries the registry) | `fetched_external` |
| `aws s3 cp s3://...` (external bucket) | `fetched_external` |

**Why this is non-trajectory work:** it's a provenance-propagation change in the PostToolUse evaluator, not a sequence detector. But it's a *prerequisite* for §3.5 / §3.12 / §3.13 / §3.14 to actually catch what they're designed to catch. Ship in PR1 alongside the scaffolding.

---

## TL;DR

Twenty-three deterministic sequence detectors across four threat families:

- **Sequence-shape security** (§3.1, §3.2, §3.3, §3.7, §3.8, §3.9): supply-chain, environment injection, repetition shapes
- **Cross-agent staleness** (§3.4, §3.6, §3.10): multi-player state coordination
- **Prompt-injection / exfiltration** (§3.5, §3.11–§3.15): the lethal-trifecta pack — §3.11 (`lethal_trifecta_structural`) is the central structural block; §3.5, §3.12, §3.13, §3.14, §3.15 are partial-leg detectors
- **Quality** (§3.16–§3.23): coverage, doc drift, refactor hygiene, plan adherence — proof that trajectory-as-primitive is dual-use

Plus one non-trajectory prerequisite (§10): tag web-fetching Bash CLIs (`gh`, `wget`, `curl`, …) with `fetched_external` provenance, without which the injection-defense pack underperforms.

Pre-block where the FP rate is provably low; pre-warn for the rest. Stop-event scan for after-the-fact shapes. Same registry pattern as content detectors; same defer-marker contract as `stop-rescan.ts`. No model calls, no cloud, no auto-tuning. None of the prompt-injection detectors require detecting the injection content itself — they all consume trajectory state directly.

Five-PR rollout, quality pack first (PR2) as low-stakes scaffolding validation, security packs after. Full implementation plan in [`trajectory-detectors-implementation-plan.md`](trajectory-detectors-implementation-plan.md).
