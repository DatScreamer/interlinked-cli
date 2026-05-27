# Trajectories as a First-Class Primitive

**Status:** Design synthesis (2026-05-27). Cross-cutting doc — names trajectory as the spine across local, async-cloud, multi-agent, and integrity tiers. Does not supersede prior tier-specific docs; defers to them for each tier's implementation contract and pins the trajectory primitive each tier consumes.

**Audience:** Future-you (or anyone) sitting down to think about why trajectory state matters across the harness, before diving into any one tier's implementation. Tier-specific work lives in the companion docs.

**Companions (this doc references; companions go deeper on one tier each):**
- [`trajectory-sequence-detectors.md`](trajectory-sequence-detectors.md) — local-tier deterministic detectors that operate on the event stream, not per-call content
- [`trajectory-integrity.md`](trajectory-integrity.md) — cryptographic-integrity layer (hash-chained signed event log; NOT a blockchain)
- [`three-tier-architecture-v2.md`](three-tier-architecture-v2.md) §3.2 + §4 — Tier 2 cloud typed-classifier; trajectory is its load-bearing input over Sondera
- [`runtime-pipeline-staging.md`](runtime-pipeline-staging.md) — seven-stage pipeline; Stages 4-Pre / 4-Post consume trajectory
- [`multiplayer-control-plane.md`](multiplayer-control-plane.md) — multi-agent broker; trajectory merge is the missing piece this doc names
- [`tier-3-async-deep-review.md`](tier-3-async-deep-review.md) — pre-push prose-policy review; trajectory is the corpus it reviews

**Memory links:** [[feedback_harness_deterministic_only]], [[feedback_deliberate_prepost_latency]], [[feedback_safety_continuity]], [[feedback_recurring_warnings_amplify_not_silence]], [[project_supervisor_pattern]], [[project_three_tier_policy_enforcement]], [[reference_supermodel_thesis]].

---

## 1. The premise

Individual tool calls are noisy proxies for intent. A `curl example.com/x.sh` is innocuous in some contexts and a malware drop in others. What separates the two is **what happened before**:

- Did the agent first read `~/.aws/credentials`?
- Did it just `chmod +x` an artifact it didn't author?
- Did three other agents in this workspace see a different state of the file you're about to overwrite?

The harness already collects most of this state. `SessionTrajectory` carries 50+ fields covering reads, writes, commands, taint sources, MCP-vs-local tool ratio, file edit counts, TDD cycles, plan captures, pending completions. Multiple consumers already use it: `verification-stop-checks.ts`, `commit-cadence.ts`, the new `stop-rescan.ts`, the four-pattern `trajectoryDetector` in `trajectory.ts`, the five-pattern `turn-end.ts` summarizer, the error-history-aware `pattern-detector.ts`, plus the Tier 2 cloud-classifier design in `three-tier-architecture-v2.md`.

But the picture is fragmented:

- **Sequence detectors are partial.** The four shapes in `trajectory.ts` cover loop/destructive/retry/stall — agent-behavior shapes. The adversarial / supply-chain shapes (secret-read-then-network, download-then-execute, install-then-unauthored-script) are unaddressed at the sequence layer.
- **`tool_sequence` is capped at 20.** Fine for the existing detectors; too short for full-turn sequence detection.
- **Trajectory state is in-memory and per-process.** A second agent in the same workspace can't see what the first one did beyond what's in `activity.jsonl` — and `activity.jsonl` doesn't carry the structured taint / sensitivity / pending-completion projections, just raw events.
- **The Tier 2 cloud trajectory classifier is a design, not a build.** Per [[feedback_deliberate_prepost_latency]] the 30–60s window is feature-not-bug; what's missing is the canonical input shape (this doc proposes one — see §5).
- **Multi-player / multi-agent merge is half-named.** `multiplayer-control-plane.md` covers the broker; trajectory-as-shared-state is the missing primitive.
- **No integrity layer.** Any party with read access to `activity.jsonl` or the session state can fabricate or rewrite trajectory data without detection. Fine for the single-player local-only model; not fine for cross-player attestation.

This doc names trajectory as the spine that ties the fragments together, identifies what's already shipped vs. what's missing, and pins the extensibility hooks today's code should preserve.

## 2. What a trajectory is (the canonical definition)

A trajectory is the ordered sequence of harness-observed events for a single agent session, plus the typed projections derived from that sequence:

```
Trajectory ≡ ⟨ session_id, agent_id, started_at, [event_0, event_1, …, event_N], derived_state ⟩
```

Where:

- **`event_i`** is a `HarnessEvent` (PreToolUse, PostToolUse, SessionStart, Stop, SkillEnter, SubagentStop, etc.) as observed on the Unix socket.
- **`derived_state`** is the typed projection the harness needs for fast lookups — what `SessionTrajectory` already is: files_read, files_written, tool_sequence, sensitivity_level, taint_sources, tdd_cycles, declared_plan, etc.

The event log is the source of truth; the derived state is a cache. This is the same contract `activity.jsonl` + `SessionTracker` already implements — naming it explicit makes the contract auditable.

**Trajectory ≠ session.** A session is one connection-id from the runner (Claude Code resets on `/clear`, Codex numbers them, etc.). A trajectory is the *observed behavior*, which can outlive a session (resumption / SessionEnd → SessionStart from the same agent on the same workspace) and can be assembled from append-only logs without an in-memory session.

The distinction matters for §5 (canonical signature) and §6 (extensibility).

## 3. Current state, mapped

| Primitive | File | Tier | Status |
|---|---|---|---|
| `SessionTrajectory` (in-memory, 50+ fields) | `session-state.ts` | Local | Shipped, rich |
| `tool_sequence` ring buffer (cap 20) | `session-state.ts` | Local | Shipped, narrow |
| `TrajectoryDetector` (4 detectors) | `trajectory.ts` | Local | Shipped — loop/destructive/retry/stall |
| `detectTurnPatterns` (5 patterns) | `turn-end.ts` | Local | Shipped — edit-without-test, thrashing, etc. |
| `getPatternWarnings` (4 patterns) | `pattern-detector.ts` | Local | Shipped — error-history-aware |
| `TaintTracker` (sensitivity + provenance flow) | `taint-tracker.ts` | Local | Shipped |
| `CapturedPlan` + `.interlinked/plans/*.jsonl` | `plan-capture.ts` | Local | Shipped — persisted |
| `LearnedRule` (cross-session) | `types/session.ts` | Local | Shipped scaffold |
| `stop-rescan.ts` `files_written` walk | `stop-rescan.ts` | Local | Shipped (current PR) |
| Tier 2 cloud trajectory classifier | `three-tier-architecture-v2.md` §4 | Cloud | Design |
| Pre/Post async pipeline | `pre-post-pipelined-cloud-checks-and-failure-recovery.md` | Cloud | Design |
| T3 prose-policy reviewer | `tier-3-async-deep-review.md` | Cloud | Design |
| Multi-agent broker | `multiplayer-control-plane.md` | Multi-player | Design |
| Activity event chain | `activity.jsonl` | Local + cloud sync | Shipped, unsigned |
| Sequence-pattern detector family (security shapes) | — | Local | **Not designed** — see [`trajectory-sequence-detectors.md`](trajectory-sequence-detectors.md) |
| Canonical trajectory signature | — | Cross-tier | **Not designed** — this doc §5 proposes |
| Hash-chained signed event log | — | Integrity | **Not designed** — see [`trajectory-integrity.md`](trajectory-integrity.md) |

## 4. Tier-by-tier use cases

### 4.1 Local / free CLI tier

The local tier is deterministic, sub-100ms per check, no model calls in the decision path (per [[feedback_harness_deterministic_only]]). Trajectory use cases:

**4.1.1 Sequence detectors (new family).** Patterns that fire on event-stream shape, not file content. See [`trajectory-sequence-detectors.md`](trajectory-sequence-detectors.md) for the catalog — twenty-three detectors across four families (sequence-shape security, cross-agent staleness, prompt-injection / exfiltration, quality). Headline examples:

- `lethal_trifecta_structural`: the central injection-defense detector — fires when the trajectory satisfies all three legs of the lethal trifecta (private data ∧ untrusted content ∧ external comms) → block. See §4.1.6 for framing.
- `secret_read_then_network_call`: agent read a sensitivity-tagged file, then issues outbound network on a non-local host → block (default) or warn (opt-in downgrade).
- `download_then_execute`: curl/wget produces an artifact, immediately followed by `chmod +x` or direct execution → block.
- `install_then_unauthored_execute`: package install, then execution of a script the agent never wrote → Stop warn.
- `subagent_diverged_edit`: parent agent has stale view of file X; subagent edited X; parent now edits X based on the stale view → Stop warn.
- `plan_vs_trajectory_drift`: agent declared a plan, ingested untrusted content, then drifted from the declared scope → warn. Novel injection signal that doesn't depend on detecting injection content. See §4.1.5.
- `regression_test_missing_after_fix` (quality): agent edited a file that failed checks earlier this session; no regression test added → Stop nudge. See §4.1.9 for the quality pack.
- `signature_change_callers_not_updated` (quality): agent changed an exported signature; importing files weren't touched this session → Stop nudge.

These extend the existing four-detector machinery in `trajectory.ts`, not replace it.

**4.1.2 Trajectory-aware Stop-event scan.** The pattern rescan over `session.files_written` (shipped in current PR) is a special case of "use trajectory state to drive end-of-turn checks." Generalizable: `stop-rescan.ts` ≈ "rerun detectors against current state for everything the trajectory says was touched."

**4.1.3 Trajectory inspection commands.** `interlinked trajectory show` for the current session; `interlinked trajectory replay --sequence '<events>'` to test sequence detectors offline. Not shipped; reserved.

**4.1.4 Taint flow as trajectory primitive.** `TaintTracker` is already trajectory-shaped (sensitivity ratchets up with each read; provenance flows). Make the link explicit so future detectors can ask `"did any sensitivity-tagged source flow into the current operation?"` without re-implementing the walk.

**Known propagation gap — web-fetching Bash CLIs.** `WebFetch` / `WebSearch` tool calls get `fetched_external` provenance, but Bash-routed equivalents (`gh issue view`, `gh pr view`, `gh api`, `glab issue view`, `curl <url>`, `wget`) don't — they fall through to `local_read`. Closing this is a small standalone change (PostToolUse parser-style extension, see [`trajectory-sequence-detectors.md`](trajectory-sequence-detectors.md) §10) and is a *prerequisite* for the prompt-injection-defense pack (§4.1.6) to actually catch the GitHub-issue / gist / web-CLI shapes.

**4.1.5 Plan-vs-trajectory drift.** `declared_plan` exists ([[project_three_tier_policy_enforcement]] Tier 1) but no detector currently fires when the trajectory deviates from the plan. Stop-event detector candidate: "you said 'edit src/auth/*' but your trajectory shows edits to src/billing/* with no plan update."

Specifically interesting for **injection defense**: drift after `fetched_external` ingestion is a behavior-change-after-untrusted-content signal that doesn't depend on detecting injection content itself. The full design is `plan_vs_trajectory_drift` in [`trajectory-sequence-detectors.md`](trajectory-sequence-detectors.md) §3.15 — two anchors required (plan-scope mismatch AND fetched_external between plan and drift) so routine plan evolution doesn't fire.

**4.1.6 The lethal trifecta as design framing.** Simon Willison's coinage: an agent becomes exfiltration-capable iff it has *all three* of (private data access × untrusted content exposure × external communication). Break any one leg, the attack fails.

Trajectory is the right primitive **specifically because the trifecta is definitionally a sequence property** — the three legs are three separate events; their conjunction only exists in time. Per-call checks can see each leg in isolation; only trajectory state can see their conjunction. The three legs map cleanly onto existing primitives:

| Leg | Primitive | Coverage |
|---|---|---|
| Private data access | `TaintTracker.sensitivity_level` + `taint_sources` | ✓ shipped |
| Untrusted content exposure | `TaintProvenance` (`fetched_external` / `mcp_remote` / `document_content` / `user_provided`) | ✓ shipped (with the gh/glab gap noted in §4.1.4) |
| External communication | Bash parser + `checkProvenanceTaintToExternalAction` | ✓ partial — provenance gate exists, but the *three-way* conjunction isn't its own check |

The structural trifecta detector is the missing intersection — see `lethal_trifecta_structural` (§3.11 of [`trajectory-sequence-detectors.md`](trajectory-sequence-detectors.md)). It blocks deterministically without ever judging whether content is malicious — only whether the structural shape is the trifecta. Partial-leg detectors (§3.5, §3.12, §3.13, §3.14, §3.15) catch the same attack chain earlier; defense in depth.

**4.1.7 Untrusted-context lockdown policy.** Not a detector — a config-driven mode. When the trajectory contains any `fetched_external` / `mcp_remote` taint source, the harness restricts the active tool set: no `Bash` to non-allowlisted destinations, no MCP-remote calls, no gist creation, no PR comments. The agent finishes the read-only portion of the task in the constrained mode, then escalates to operator if it needs broader tools.

This is the **architectural** version of the trifecta defense — break leg 3 (external comms) whenever leg 2 (untrusted content) is active, before any specific exfil shape needs to be detected. More robust than detector-based defense because it doesn't try to judge whether the fetched content is malicious; it just refuses to be the exfil channel. Trade-off: stricter than necessary in legitimate read-then-summarize workflows; opt-in for high-risk repos via `.interlinked/config.json`:

```jsonc
{
    "untrusted_context_lockdown": {
        "enabled": true,
        "triggers": ["fetched_external", "mcp_remote"],
        "restricted_tools": ["Bash", "WebFetch", "mcp__*", "Write"],
        "allowlist": ["Bash(npm test)", "Bash(tsc --noEmit)"]
    }
}
```

**4.1.8 Output egress filter (extension to existing scanner).** `OutputScanningConfig` in `types/taint.ts` already has `scan_bash_secrets` for catching secrets in Bash output. Extension: block POST/PUT/upload commands whose **body or query string** matches `secrets_detection` signatures (per `signatures.ts`). This is the exfil bookend — even if injection succeeds and the trifecta gate is bypassed (e.g., via a clever multi-step laundering), the egress filter catches the moment a secret-shaped payload tries to leave. Last line of defense; high precision (matching against the same signature corpus as the read-side scanner, so calibration is unified).

Not a sequence detector strictly — fires on a single PostToolUse output — but consumes trajectory state (sensitivity_level, taint_sources) for risk-adjusted threshold tuning. Implementation locus: extend the existing scanner in `evaluator/post-tool.ts`, gate on Bash patterns matching POST/PUT/`gh gist create` / webhook URLs.

**4.1.9 Quality sequence detectors — the dual-use.** The trajectory primitive isn't security-specific. Multiple already-shipped consumers of `SessionTrajectory` are quality-flavored:

- `turn-end.ts::detectTurnPatterns` — five turn-level patterns: `edit-without-test`, `repeated-failure`, `redundant-reread`, `write-without-read`, `file-thrashing`
- `pattern-detector.ts::getPatternWarnings` — four error-history-aware patterns: file-region hotspots, cross-file edit pairs, temporal, sequence
- `non_null_assertion_ratchet`, `as_any_ratchet` — count-baseline-then-flag-increase ratchets consuming trajectory state
- `verification-stop-checks.ts` — three Stop nudges (unverified code, UI not interacted, stubs introduced) reading `verification_observed` / `stubs_introduced`
- `commit-cadence.ts` — Stop nudge on too many uncommitted code-file edits

So trajectory-for-quality already works; it just wasn't named as such. [`trajectory-sequence-detectors.md`](trajectory-sequence-detectors.md) §3.16–§3.23 adds **eight new quality detectors** in the same framework as the security pack, completing the dual-use story:

| Detector | Phase | What it catches |
|---|---|---|
| `signature_change_callers_not_updated` | Stop | Renamed a function, didn't look at callers this session |
| `regression_test_missing_after_fix` | Stop | Bug-fix without a regression test for the same file |
| `magic_literal_cross_file_proliferation` | Stop | Same literal in ≥3 files — should be a constant |
| `stale_doc_sibling` | Stop (advisory) | Edited code, sibling doc untouched |
| `coverage_silent_regression` | Stop | Added code, no new tests, suite still green = coverage hole |
| `add_then_revert_loop` | PreToolUse warn | Same line range thrashed in opposite directions ≥3× |
| `unused_helper_introduced` | Stop | Exported a helper this session with zero callers anywhere |
| `plan_vs_trajectory_drift_quality` | PreToolUse warn | Scope drift without the `fetched_external` anchor (= scope creep, not injection) |

**Same primitive, two consumer families.** The trajectory framework's value comes from the **dual-use** — one mechanism (event-stream shape detection + session-state queries) serves both security and quality. The framework decisions (registry shape, phase contract, defer-marker convention, performance budget) live once; the detectors compose freely on either side.

**Local-first alignment.** All eight quality detectors fit `harness-system-diagrams.md`'s local-canonical substrate model — they read the same primitives (project graph, finding history, test-runtime ratchet, declared plan) the diagram-doc names as authoritative. None require cloud. Per-detector local-feasibility analysis is in [`trajectory-detectors-implementation-plan.md`](trajectory-detectors-implementation-plan.md) §6.

### 4.2 Cloud async tier

The cloud tier has a 30–60s budget per [[feedback_deliberate_prepost_latency]] — designed for multi-agent sync, not for fast-path checks. Trajectory is the load-bearing input.

**4.2.1 PostToolUse → next-PreToolUse async-feedback loop.** Exactly the contract in `runtime-pipeline-staging.md` §3 Stage 4-Post and `three-tier-architecture-v2.md` §5: PostToolUse fires, classifier is spawned with the trajectory, agent moves on, next PreToolUse polls for the verdict and attaches it to `additional_context`.

What this doc adds: **the trajectory canonical signature** (§5) is the input contract. Today's design hand-waves "the trajectory" as input; pinning the canonical form makes the schema explicit, enables prompt-cache hits across runs, and unblocks classifier-backend swaps.

**4.2.2 Cross-workspace trajectory cross-reference.** When the cloud has trajectory data from N sessions in the same workspace, it can answer questions local can't: "five agents touched `config.ts` in the last hour, all introducing similar bugs — should I warn this one?" Local can't, cloud can. Trajectory is the corpus.

**4.2.3 T3 pre-push prose review.** Per `tier-3-async-deep-review.md`, the pre-push reviewer reads the prose-policy artifacts AND the recent trajectory. Today's design references "recent trajectory" without pinning its shape — same canonical signature as §4.2.1.

**4.2.4 Recurrence aggregation across sessions.** The shipped `interlinked recurrence` aggregator counts repeating patterns across sessions per the CLAUDE.md spec. Today it joins on `(check_id, file)`. Trajectory-aware extension: join on `(sequence_pattern, workspace)` — "this sequence-shape recurs across agents in your workspace." Same JSONL substrate; new aggregation key.

**4.2.5 Local + cloud layered defense for prompt injection.** The two tiers play different roles in the injection-defense story:

- **Local (Tier 1, structural).** Detects the **structural trifecta** — legs are tagged, conjunction fires, block at the exfil step. Sub-millisecond, deterministic, no cloud dependency. The six injection-defense detectors at [`trajectory-sequence-detectors.md`](trajectory-sequence-detectors.md) §3.5, §3.11–§3.15 are this layer.
- **Cloud (Tier 2, semantic).** Detects the **semantic trifecta** — fetched content contains imperative-mood injection targeting the agent, even when the structural legs aren't all yet present. The Tier 2 typed classifier (`three-tier-architecture-v2.md` §4) returns labels (`Label::"InjectionAttempt"`, `Label::"InstructionsInData"`) that feed Cedar; Cedar's `@action_on_violation` decides what to do — bump sensitivity (so subsequent local checks fire earlier), inject context into the next PreToolUse, or (if explicitly opted in) halt the session.

The layers are **complementary, not redundant**. Local defense doesn't need cloud to fire (structural detection stands alone — matters for air-gapped / regulated use cases); cloud doesn't need local to fire (semantic detection catches cleverly-phrased content the structural pattern misses). When both fire, Cedar composes the signals into one decision via the v2 detection/decision separation.

This is also the answer to "is local pattern matching enough?" — no, content-shape pattern matching is bypassable (see §7); the structural trajectory detectors + the semantic cloud classifier together give defense in depth that no single layer provides.

### 4.3 Multi-agent tier

The fleet model: one player owns multiple agents; multiple players share a workspace.

**4.3.1 Cross-agent trajectory visibility.** Reservations already prevent simultaneous writes via the broker. Trajectory cross-agent visibility prevents stale-context edits:

- Agent A: `read(x.ts, content_hash = H_a)` at T1
- Agent B: `write(x.ts, content_hash → H_b)` at T2
- Agent A about to `write(x.ts, derived_from=H_a)` at T3

The harness should tell A: "x.ts changed since you read it, by agent B at T2."

This is one shape of the supervisor pattern ([[project_supervisor_pattern]]) at the workspace scale. The detection lives at agent A's local harness (fast); the data (agent B's write event) lives in the workspace event log (server-mediated, eventually-consistent).

**4.3.2 Trajectory merge.** When two agents on the same workspace both produce trajectories, the workspace has a *merged* trajectory: ordered union by real-time + per-agent monotonic seq. `multiplayer-control-plane.md`'s durable event log is the substrate; adding a trajectory-projection-by-agent gives us the merge view without inventing new storage.

**4.3.3 Fleet-level patterns.** Same player, multiple agents: all editing the same file in parallel. Detect: was the work mutually-aware (agent A's plan referenced agent B's output) or accidentally-parallel? Surface: "you have three agents on the same file, none of which references the others' plans." Stop-event warn at end-of-turn; this is a sequence detector at fleet scope rather than agent scope.

### 4.4 Cryptographic integrity tier (future)

See [`trajectory-integrity.md`](trajectory-integrity.md) for the full design. Headline:

- Append-only signed event log per session (Ed25519, key generated at SessionStart, fingerprint registered with the server)
- Each event carries `(seq, event_hash, prev_chain_hash, chain_hash, signature, key_fingerprint)`
- Tamper-evident: any rewrite of past events invalidates every subsequent chain hash
- Multi-agent consistency: agents publish chain-hash checkpoints; server tracks them; any divergence from a published checkpoint is detectable
- **NOT a blockchain.** We have a trusted server (the MCP server). Distributed ledger solves the no-trusted-third-party problem, which we don't have. See [`trajectory-integrity.md`](trajectory-integrity.md) §3 for the full critique.

## 5. The canonical trajectory signature

A trajectory signature is a **structured, hash-stable summary** of the trajectory at a point in time. It's what we'd:

- hash for crypto integrity (§4.4),
- send to the cloud classifier (§4.2.1),
- cache for prompt-cache hits (cross-version classifier stability),
- display in `interlinked trajectory show` (§4.1.3),
- merge in the multi-agent broker (§4.3.2).

**Proposed shape (v1, reserved for future implementation; NOT shipping today):**

```ts
interface TrajectorySignature {
    schema_v: 1;
    session_id: string;
    /** Distinct from session_id — stable across runner-session resets. See §6. */
    trajectory_id: string;
    agent_source: AgentSource;
    agent_name: string;
    started_at: string;            // ISO 8601
    computed_at: string;
    events_count: number;
    files_read: string[];          // sorted, canonicalized paths
    files_written: string[];       // sorted, canonicalized paths
    commands_run_normalized: string[];  // see §5.1
    verification_observed: string[];    // VerificationSignal values
    skills_invoked: string[];
    tdd_cycles_by_state: Record<TddCycleState, number>;
    taint_sources_summary: {
        max_level: SensitivityLevel;
        counts_by_provenance: Record<TaintProvenance, number>;
        flow_count_to_external: number;
    };
    pattern_findings: Array<{
        pattern: string;
        fired_at_event: number;
        severity: "info" | "warning" | "error";
    }>;
    sensitivity_at_signature: SensitivityLevel;
}
```

### 5.1 Command normalization

Commands need to be normalized so equivalent invocations hash to the same signature: collapse whitespace, sort orthogonal flags (`-l -a` and `-a -l` are the same), resolve paths to absolute form, drop trailing semicolons / `&&` chains. Same shape as the `recurrence.ts` aggregator already does for `harness_caught` joining.

### 5.2 Hash stability

The canonical form is deterministic JSON: sort keys, sort arrays where order is not semantic (taint sources, files), preserve order where it is (`pattern_findings` is ordered by `fired_at_event`). This is the input to:

- SHA-256 for the integrity hash chain
- HMAC-keyed hash for span IDs (per `three-tier-architecture-v2.md` §6.4 secret-safe-telemetry contract)
- Prompt-cache keys (same trajectory shape hits cache regardless of cosmetic event-log differences)

### 5.3 Delta signatures

For the Pre/Post async-classifier path, the input is often **the delta since the last classifier call** — not the whole trajectory every time. A delta signature is the same shape, but `events_count` / `files_*` / etc. cover only the events since `prev_signature.events_count`. The classifier composes the prior signature's prefix hash with the delta's content hash, which gives stable cache hits even as the trajectory grows.

This composes cleanly with the v2 `ClassifierResult.metadata` discriminated union (§4.4 round-5 patch): `{kind: "trajectory", prefix_hash, delta_hash, ...}` already expects this shape.

## 6. Today's extensibility — what to preserve

The user's instruction was *plan docs for further enhancements and for today's extensibility*. Audit of recent shipped code (this PR's stop-rescan, defer marker, pattern detectors) against the future-trajectory design:

| Candidate | Status | Notes |
|---|---|---|
| `PatternRescanFinding` per-line shape | ✓ OK | Future sequence findings get their own type; no conflict. |
| Defer marker per-line-per-check-id | ⚠ Limited | A sequence defer (acknowledge a 5-call pattern across files) wouldn't fit. Future: `// interlinked: defer-sequence <pattern-id>` is a separate marker; current spelling not contended. |
| `session.files_written: Set<string>` | ⚠ Limited | Set loses ordering. Future trajectory signature needs ordered files_written; the event log retains order, so Set stays as fast-membership cache. No code change today. |
| `tool_sequence` cap of 20 | ⚠ Limited | Future sequence detectors may want full-turn (capped by event count, not by 20). Today: 20 is enough for the existing four detectors. Future: introduce a parallel `recent_events: HarnessEvent[]` ring buffer of larger size; don't grow `tool_sequence` because it's a string projection. |
| `SessionTrajectory` has no `toJSON()` | ⚠ Limited | `Map` / `Set` fields lose info on JSON.stringify. The future canonical signature needs deterministic serialization. There's already `serializeSessionForSnapshot` in `session-state.ts:331` — extend it rather than building a new serializer. |
| Event log lacks per-session monotonic seq | ✗ Real lock-in candidate | `activity.jsonl` interleaves events across sessions. A future hash chain needs per-session seq. Two paths to fix: (a) add `trajectory_seq?: number` to `HarnessEvent` and populate from `SessionTracker` on receipt, OR (b) derive from `activity.jsonl` ordering at chain-construction time. (b) is cheaper to defer; (a) is one-line to add when needed. Defer to integrity-doc implementation. |
| `trajectory_id` separate from `session_id` | ⚠ Optional today | Runner-provided session_id is not under our control. For stable trajectory identity across resumptions, we'd mint our own. Not blocking; reserve in §5 design. |
| Existing `trajectoryDetector` already in `SessionTrajectory` | ✓ Good | The optional `trajectoryDetector?` field already signals "trajectory-aware machinery plugs in here." New sequence detectors can attach via the same field shape. |

**Action items from this audit today:** none. The shape preservation is automatic — current code doesn't lock anything in. The two "real lock-in candidates" (event-log seq, trajectory_id) are both cheap to retrofit later; reserving them today buys nothing concrete.

**What this doc itself ships today:** the design memos. The next conversation that picks up trajectory work should be able to land sequence detectors (per [`trajectory-sequence-detectors.md`](trajectory-sequence-detectors.md)) without re-litigating the framing.

## 7. Risks and non-goals

**Trajectory data is more sensitive than code.** An agent's full event log reveals architecture, secrets, project structure, working style, and probably which files contain the operator's API keys. Cloud-side trajectory storage needs the same encryption-at-rest + tenant-isolation guarantees as `activity.jsonl`, and the redaction contract from `three-tier-architecture-v2.md` §6.4 applies before any trajectory leaves the local machine.

**Sequence detectors can over-fire.** Multi-step refactors legitimately read many files. The "low FP via shape match" stance for content detectors doesn't translate directly — sequence detectors need anomaly-vs-routine framing, not just shape. Initial detectors must be very conservative (high-precedent-to-fire shapes only); see [`trajectory-sequence-detectors.md`](trajectory-sequence-detectors.md) §3 for the catalog.

**Content-pattern detection is bypassable.** The existing `signatures.ts` corpus catches lazy prompt-injection patterns (ignore-instructions, role-manipulation, system-override) by regex. Any competent attacker can paraphrase past those. The published literature (Greshake et al. on indirect prompt injection, Anthropic's spotlighting paper, DeepMind's CaMeL) is consistent: content-shape detection is necessary-but-insufficient. Defense weight goes on **structural** detectors that don't depend on the attack's wording — the lethal-trifecta detector (§4.1.6), untrusted-context lockdown (§4.1.7), plan-vs-trajectory drift (§4.1.5), output egress filter (§4.1.8). Pattern matching stays as a cheap low-precision layer.

**The signed log is NOT a trust replacement.** A compromised agent (key stolen, runtime suborned) can sign whatever it wants. The chain proves consistency, not benevolence. See [`trajectory-integrity.md`](trajectory-integrity.md) §5.

**NOT a blockchain.** The server is the consensus authority. See [`trajectory-integrity.md`](trajectory-integrity.md) §3.

**NOT a substitute for the deterministic-only stance at local tier.** Even cloud-LLM trajectory classification produces typed labels that feed Cedar (per `three-tier-architecture-v2.md` §2's detection/decision separation); the decision boundary stays deterministic.

**Tension with [[reference_supermodel_thesis]] graph-as-authoritative-state.** Supermodel argues the deterministic graph is more reliable than a probabilistic narrator. Trajectory-as-primitive doesn't contradict — graph captures *static structure* of the codebase, trajectory captures *dynamic behavior* of the agent. They're complementary axes: structure × behavior. A graph + a trajectory together give us what neither does alone.

## 8. Open questions (carry forward)

1. **Per-session event-log persistence.** `activity.jsonl` interleaves all sessions in one file. Trajectory-signature computation is easier with per-session logs (e.g., `.interlinked/sessions/<id>.events.jsonl`). Trade-off: more files vs. structurally cleaner. Probably worth doing when we ship the integrity layer.

2. **trajectory_id stability across runner resets.** When Claude Code resets session_id on `/clear`, is the trajectory a new one or a continuation? Heuristic: same workspace + same agent_name + < N minutes gap = continuation. Need to pin this before multi-session trajectory unification.

3. **Cloud opt-out granularity.** Some workspaces (regulated, air-gapped) will never opt into cloud trajectory submission. The classifier-feedback loop must degrade cleanly to local-only mode. Confirm the local-tier sequence detectors stand on their own without the cloud layer — they do, by construction (§4.1).

4. **Multi-player trust model.** Within one player's fleet: trust your own agents. Between players: need attestation. Two players who collaborate on the same workspace by mutual consent shouldn't need the full Ed25519 dance. Tier the trust model — probably at workspace-level config.

5. **Trajectory as agent-CI artifact.** When a PR review is gated on a cloud reviewer, the reviewer's input includes the trajectory. Should the signed trajectory be a first-class PR artifact (committable to `.interlinked/trajectories/<pr>.json`, attachable to a PR comment)?

6. **Subagent trajectories — parent or independent?** A subagent fires its own SessionStart/Stop. Today the harness treats it as a separate session with `parent_session_id` linkage. Trajectory-merge question: should the parent's signature include the subagent's events, or just a hash reference to the subagent's signature? Probably the latter (composable, smaller) — but the linkage primitive needs to exist.

7. **Replay determinism.** If we re-run the local detectors against a stored trajectory, do they produce the same findings? For shape-match detectors yes, but `trajectoryDetector` uses real-time windows (e.g., 60s for tool_loop), which won't re-derive from a stored trajectory without per-event timestamps. Confirm timestamps survive serialization.

---

## TL;DR

Trajectory is already the de-facto spine of the harness — `SessionTrajectory` has 50+ fields and six families of consumers. Naming it as a first-class primitive lets us close the gaps:

- Local sequence detectors (security shapes, not just agent-behavior shapes) — see [`trajectory-sequence-detectors.md`](trajectory-sequence-detectors.md)
- Async cloud feedback into next PostToolUse — already designed at `three-tier-architecture-v2.md` §5, this doc adds the canonical signature §5
- Multi-agent trajectory merge in the broker — adds the missing primitive to `multiplayer-control-plane.md`
- Cryptographic integrity (hash chain, NOT blockchain) — see [`trajectory-integrity.md`](trajectory-integrity.md)

Nothing in today's shipped code blocks the direction. No code change required this session — the design itself is the deliverable.
