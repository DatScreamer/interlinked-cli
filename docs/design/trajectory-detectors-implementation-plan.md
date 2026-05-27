# Trajectory Detectors — Implementation Plan

**Status:** Implementation plan (2026-05-27). Companion to [`trajectories-as-primitive.md`](trajectories-as-primitive.md) (master synthesis), [`trajectory-sequence-detectors.md`](trajectory-sequence-detectors.md) (catalog), [`trajectory-integrity.md`](trajectory-integrity.md) (crypto future), and [`harness-system-diagrams.md`](harness-system-diagrams.md) (kernel diagrams).

**Audience:** The engineer (likely future-me) who picks up the build. This doc answers the **how** and **when**; the design docs answer the **what** and **why**.

**Scope:** the full local trajectory implementation — 23 sequence detectors across four families, 4 non-detector primitives, 1 framework-coexistence decision, the Bash-CLI provenance fix, the trajectory inspection commands, and the session-state extensions any of them require. Five-PR rollout; two non-detector primitives ship in parallel small PRs.

**Memory:** [[feedback_harness_deterministic_only]], [[feedback_hook_latency_budget]], [[feedback_recurring_warnings_amplify_not_silence]], [[feedback_safety_continuity]], [[feedback_taste_enforcement]].

---

## 1. Scope

### 1.1 Sequence detectors (23 total)

Already cataloged in `trajectory-sequence-detectors.md` §3. Family breakdown:

| Family | Detectors | Count | Severity mix |
|---|---|---|---|
| Sequence-shape security | §3.1, §3.2, §3.3, §3.7, §3.8, §3.9 | 6 | 2 pre_block, 3 pre_warn, 1 stop |
| Cross-agent staleness | §3.4, §3.6, §3.10 | 3 | 2 pre_warn, 1 stop |
| Prompt-injection / exfiltration | §3.5, §3.11–§3.15 | 6 | 2 pre_block (one split), 4 pre_warn |
| Quality | §3.16–§3.23 | 8 | 6 stop (one advisory), 2 pre_warn |
| **Total** | | **23** | **4 pre_block, 11 pre_warn, 8 stop** |

### 1.2 Non-detector primitives (4 total)

These don't use the sequence-detector framework but consume the same trajectory state. Spec'd in `trajectories-as-primitive.md`:

| Primitive | Spec | Implementation locus | Est. LoC |
|---|---|---|---|
| Bash CLI provenance fix | sequence-detectors §10 | `evaluator/post-tool.ts` | ~150 + tests |
| Trajectory inspection commands | master §4.1.3 | `src/commands/trajectory.ts` | ~250 + tests |
| Untrusted-context lockdown policy | master §4.1.7 | `evaluator/pre-tool.ts` + new policy module | ~300 + tests |
| Output egress filter (extension) | master §4.1.8 | `evaluator/post-tool.ts` + `OutputScanningConfig` | ~200 + tests |

### 1.3 Framework decision (1 total)

**The existing-consumer coexistence call.** `turn-end.ts::detectTurnPatterns` (5 patterns) and `pattern-detector.ts::getPatternWarnings` (4 patterns) already consume trajectory state. The sequence-detector framework is a generalization. Three options:

- (a) **Refactor:** port both files into `sequence-checks/`. Cleanest end-state; biggest day-1 cost.
- (b) **Parallel:** leave both in place forever; new detectors go in `sequence-checks/`. Zero refactor; permanent fragmentation.
- (c) **Defer:** ship new framework alongside; refactor after PR2 proves the framework. Lowest near-term risk.

**Recommendation: (c) defer.** Ship the new framework, validate via PR2 (quality pack, low-stakes), then schedule a refactor PR after the framework is battle-tested. The refactor doesn't have to ship in the initial 5-PR rollout — it can land as PR6 or as part of a later cleanup pass. See §3 for the migration sketch.

---

## 2. Prerequisites (PR1)

Everything in this section ships in PR1 — without these, every subsequent PR has to invent its own scaffolding or work around missing infra.

### 2.1 Sequence-detector framework

**New module:** `src/harness/sequence-checks/`. Mirror the layout of `src/harness/checks/` (one family per file).

**New interfaces in `check-registry/types.ts`:**

```ts
interface SequenceDetector {
    id: string;
    description: string;
    family: "security-shape" | "cross-agent" | "injection" | "quality";
    phase: "pre_block" | "pre_warn" | "stop";
    /** Returns zero or more matches for the (trajectory, candidate) pair. */
    fn(trajectory: SessionTrajectory, candidate: HarnessEvent): SequenceMatch[];
    /** Default enabled state; user can override via .interlinked config. */
    default_enabled: boolean;
    /** Determinism tag — sequence detectors are always fully_deterministic. */
    determinism: "fully_deterministic";
}

interface SequenceMatch {
    prior_event_count: number;
    prior_summary: string;
    trigger_summary: string;
    evidence: string[];
}
```

**Registry-shim decision:** add a `kind: "sequence"` discriminator to the existing `CheckRegistryEntry` rather than introducing a parallel registry. Same `check-registry/entries-warnings.ts` / `entries-errors.ts` files; entries with `kind: "sequence"` are dispatched to the sequence-detector codepath at PreToolUse / Stop.

**Evaluator dispatch:** in `evaluator/pre-tool.ts`, after the existing per-call checks complete, walk all enabled `kind: "sequence"` detectors with phase ∈ {pre_block, pre_warn} and emit matches. In Stop-event handling (`server/lifecycle-events.ts::buildStopWarnings`), do the same for phase == "stop".

**Test fixture infra:** `src/harness/__tests__/sequence-fixtures.ts` exports `buildTrajectoryFixture(events: HarnessEvent[]): SessionTrajectory` that replays events through `SessionTracker.recordEvent` and returns the final state. Pattern already used in `stop-rescan.test.ts::makeSession()`; generalize and export.

**Placeholder detector:** one `sequence-checks/_placeholder.ts` that always returns `[]`. Wired into the registry but disabled by default. Confirms the dispatch plumbing without false-firing.

**Est. LoC:** ~400 LoC (interface + dispatch wiring + registry hook + fixture infra + placeholder + tests).

### 2.2 Bash CLI provenance fix

Per `trajectory-sequence-detectors.md` §10. Tag Bash output from web-fetching CLI verbs as `fetched_external` at PostToolUse.

**Implementation locus:** `evaluator/post-tool.ts` — new helper `classifyBashCommandProvenance(command: string): TaintProvenance | null` that pattern-matches the verbs from §10's table.

**Wired into:** the existing taint-tracking codepath in `post-tool.ts` that records `taint_sources` for Read events. Add a parallel Bash-output codepath that calls the classifier and tags taint when the command matches.

**Patterns to recognize (initial set, expandable):**

| Pattern | Tag | Notes |
|---|---|---|
| `gh issue view` / `gh pr view` / `gh gist view` / `gh api` | `fetched_external` | Attacker-controllable issue / PR / gist content |
| `glab issue view` / `glab mr view` | `fetched_external` | GitLab equivalent |
| `curl <url>` / `curl https://...` (non-localhost) | `fetched_external` | Generic HTTP fetch |
| `wget <url>` | `fetched_external` | Same |
| `http <url>` / `https <url>` (httpie) | `fetched_external` | Same |
| `npm view <pkg>` / `pip show <pkg>` | `fetched_external` | Registry queries |
| `aws s3 cp s3://<external-bucket>/...` | `fetched_external` | Cross-tenant bucket read |

**Tests:** ≥3 positive cases (each verb shape) + ≥3 negative cases (`curl localhost`, `gh auth status` (no fetch), `wget` to allowlisted URL).

**Est. LoC:** ~150 + tests.

### 2.3 Trajectory inspection commands

Per master doc §4.1.3. Two new subcommands of `interlinked`:

```bash
interlinked trajectory show                    # current session, all fields
interlinked trajectory show --session <id>     # historical session
interlinked trajectory show --json             # machine-readable

interlinked trajectory replay <events.jsonl>   # feed events through detectors, dry-run
interlinked trajectory replay --check <id>     # only this detector
```

**Why ship in PR1:** PR2+ test sequence detectors by building `SessionTrajectory` fixtures and running detectors over them. `replay` is the production-grade version of the same thing — it lets a developer paste a real session's event log and see what each detector would say. Without it, debugging FPs in PR3+ requires building unit-test fixtures by hand for every reproduction.

**Implementation locus:** `src/commands/trajectory.ts` (new file), wired into `src/index.ts` like other commands.

**Output format:** JSON for `--json`; tabular ANSI for default. Use existing `lib/formatter.ts` patterns.

**Est. LoC:** ~250 + tests (mostly integration tests against fixture sessions).

### 2.4 PR1 total

| Component | Est. LoC + tests |
|---|---|
| Sequence-detector framework | ~400 |
| Bash CLI provenance fix | ~150 |
| Trajectory inspection commands | ~250 |
| **PR1 total** | **~800 LoC** |

This is the largest PR in the rollout. Worth landing as one PR because all three pieces are prerequisites for PR2 — splitting them across PRs creates dependency churn.

---

## 3. Existing-consumer coexistence (the framework decision)

### 3.1 Today's state

| Consumer | File | Patterns | Current shape |
|---|---|---|---|
| `detectTurnPatterns` | `turn-end.ts` | 5 turn-level shapes | Pure function `(SessionTrajectory) → string[]` |
| `getPatternWarnings` | `pattern-detector.ts` | 4 error-history-aware shapes | Pure function `(ErrorRecord[], file, SessionTrajectory, editLine?) → string[]` |
| `trajectoryDetector` | `trajectory.ts` | 4 anti-pattern shapes (tool_loop, etc.) | Stateful class with `observe(event) → findings` |
| `verification-stop-checks.ts` | `verification-stop-checks.ts` | 3 stop nudges | Returns `string | null` formatters |
| `commit-cadence.ts` | `commit-cadence.ts` | 1 stop nudge | Same |
| `non_null_assertion_ratchet`, `as_any_ratchet` | `checks/ratchets.ts` | 2 metric ratchets | Per-file `Check` interface |

### 3.2 Migration sketch (when we do it)

The `SequenceDetector` interface (§2.1) generalizes the `detectTurnPatterns` shape — same `(trajectory) → matches` contract, just with structured `SequenceMatch` instead of `string`. The migration:

1. Wrap each existing `detectTurnPatterns` entry as a `SequenceDetector` with `phase: "stop"`, `family: "quality"`.
2. Same for `pattern-detector.ts::getPatternWarnings` (their existing FP-handling stays).
3. `trajectoryDetector` already has its own state machine — wrap as a `SequenceDetector` with `phase: "pre_warn"`, `family: "quality"` (or split, since some are security-shape).
4. `verification-stop-checks.ts` formatters — wrap as stop-phase detectors emitting structured matches.
5. `commit-cadence.ts` — same.
6. Ratchets are different (per-file, not sequence-level) — leave in place; not part of the migration.

**When:** PR6 or later. Not in the initial five-PR rollout. The recommendation is to ship the new framework, let it bake through PR2–PR5, then unify.

**Risk if we don't migrate:** trajectory consumers fragment across `turn-end.ts`, `pattern-detector.ts`, `trajectory.ts`, and `sequence-checks/`. New maintainers have four places to look. Documentation churn. The unification PR gets harder the longer we wait.

**Risk if we migrate too early:** big refactor on day one, before the new framework has proven the FP / perf / test-fixture story. If the framework needs interface revisions after PR2, the refactor has to be redone.

**Recommendation: schedule PR6 (post-PR5 cleanup) as the migration**, and document the temporary fragmentation in the master doc §3 mapping table.

### 3.3 What the framework decision means for PR1

PR1's interface choice (`SequenceDetector` in §2.1) needs to be **forward-compatible with the migration**. Specifically:

- `SequenceDetector.fn` returns `SequenceMatch[]` — the existing `detectTurnPatterns` returns `string[]`. The wrapper at migration time has to translate `string` → `SequenceMatch` with placeholder fields. Means: `SequenceMatch` shouldn't have any fields that *require* a richer source than a string (e.g., `prior_event_count` should be optional).
- `SequenceDetector.family` includes `"quality"` from the start — even though PR1's placeholder is family-neutral, the enum admits the existing turn-end patterns at migration time without a schema change.
- `SequenceDetector.phase` includes `"stop"` from the start — all turn-end patterns and stop nudges are stop-phase.

Adjusted `SequenceMatch` shape (slight revision of §2.1):

```ts
interface SequenceMatch {
    /** Optional — for detectors that operate on multiple prior events */
    prior_event_count?: number;
    /** Optional — human-readable summary of prior events */
    prior_summary?: string;
    /** Required — the message the user sees */
    message: string;
    /** Optional — quoted snippets that are the basis for the finding */
    evidence?: string[];
}
```

The required field is just `message`. Everything else is optional. Migration wrappers populate only `message`; new sequence detectors populate the richer fields.

---

## 4. Detector phasing — the five-PR rollout

### 4.1 PR1: prerequisites (see §2)

~800 LoC. Ships the framework + Bash provenance + inspection commands + one placeholder detector.

### 4.2 PR2: quality pack (§3.16–§3.23)

**Why this is PR2 (before any security pack):**

- All quality detectors are warn / advisory — FP cost is low (annoying message, not blocked tool call).
- Validating the framework against low-stakes detectors first means a subtle framework bug surfaces against an annoying warning, not a blocked production deploy.
- Quality detectors share infra dependencies (project-graph queries, diff-awareness, plan-capture) with the security detectors that come later — exercising those code paths first surfaces integration bugs.

**Detectors:** §3.16, §3.17, §3.18, §3.19, §3.20, §3.21, §3.22, §3.23. Eight total.

**Session-state extension needed:** `recent_line_edits: Map<file, RingBuffer<{range, content_hash, at_step}>>` for §3.21. Add to `SessionTrajectory` type + `SessionTracker.recordEvent`. ~50 LoC.

**Est. LoC:** ~80 LoC × 8 detectors + ~100 LoC × 8 tests + ~50 LoC session-state extension = **~1500 LoC**.

⚠ This is over the ~600-LoC-per-PR guideline. Two options:

- **Split PR2 across two PRs (PR2a stop-only detectors, PR2b pre_warn detectors):** PR2a = §3.16–§3.20, §3.22 (six stop detectors, ~1000 LoC). PR2b = §3.21, §3.23 (two pre_warn detectors + ring-buffer extension, ~500 LoC). Cleaner.
- **Trim tests-per-detector from ≥3 + ≥3 down to ≥2 + ≥2 for PR2:** mechanically halves the test LoC. Trade-off: weaker initial coverage. Not recommended.

**Recommendation: split PR2 into PR2a + PR2b.** Numbering becomes 6 PRs total: PR1, PR2a, PR2b, PR3, PR4, PR5.

### 4.3 PR3: sequence-shape security (§3.1, §3.2, §3.8, §3.9)

**Why PR3:** pre_block tier. Framework is battle-tested from PR2; ready for FP-intolerant block detectors.

**Detectors:** §3.1 (secret_read_then_network_call), §3.2 (download_then_execute), §3.8 (npm_run_then_curl_to_localhost), §3.9 (same_command_thrice_no_observe). Four total.

**Why not §3.3 / §3.7 here:** §3.3 (install_then_unauthored_execute) is stop-phase; group with PR4's stop detectors. §3.7 (env_modification_then_bash) is pre_warn but needs the env-tracking infra that goes with cross-agent work in PR4.

**Est. LoC:** ~80 LoC × 4 + ~100 LoC × 4 = **~720 LoC**. Within budget.

### 4.4 PR4: stop + cross-agent (§3.3, §3.4, §3.6, §3.7, §3.10)

**Detectors:** §3.3, §3.4, §3.6, §3.7, §3.10. Five total.

**Load-bearing new infra in this PR:** bounded-read `activity.jsonl` helper for cross-session detection (§3.4, §3.10). This is the cross-agent staleness primitive. Implementation: a `loadRecentWorkspaceEvents(cwd, sinceTimestamp): Promise<HarnessEvent[]>` helper in `src/harness/cross-session.ts` (new file). Caches per Stop turn.

**Est. LoC:** ~80 LoC × 5 + ~100 LoC × 5 + ~150 LoC cross-session helper + tests = **~1050 LoC**. Over budget.

**Recommendation: split PR4 too:** PR4a = cross-session infra + §3.4, §3.10 (the two cross-agent detectors that need the helper). PR4b = §3.3, §3.6, §3.7 (stop and pre_warn detectors that don't need cross-session I/O).

Updated count: 7 PRs total: PR1, PR2a, PR2b, PR3, PR4a, PR4b, PR5.

### 4.5 PR5: prompt-injection defense pack (§3.5, §3.11–§3.15)

**Why ship together:** the composition note (after §3.15) is the defense-in-depth story. Shipping the trifecta block (§3.11) without the partial-leg warns (§3.12–§3.15) means agents bypass the structural block via the gaps. Shipping the partial-leg warns without §3.11 means there's no final structural gate. All six land in one PR for narrative coherence.

**Detectors:** §3.5, §3.11, §3.12, §3.13, §3.14, §3.15. Six total. §3.14 has split severity (pre_block on deterministic destinations, pre_warn on ambiguous).

**Est. LoC:** ~80 LoC × 6 + ~100 LoC × 6 = **~1080 LoC**. Over budget.

**Recommendation: split PR5 by severity tier:** PR5a = §3.11 + §3.14-deterministic (the two pre_block detectors). PR5b = §3.5, §3.12, §3.13, §3.14-ambiguous, §3.15 (five pre_warn detectors).

Final count: 8 PRs total: PR1, PR2a, PR2b, PR3, PR4a, PR4b, PR5a, PR5b. Plus PR6 (migration) post-rollout.

### 4.6 Non-detector primitive PRs (schedulable in parallel)

These don't block the detector rollout and can ship interleaved:

| PR | Primitive | Est. LoC | Depends on |
|---|---|---|---|
| PR-N1 | Untrusted-context lockdown policy | ~400 | PR1 (uses trajectory state) |
| PR-N2 | Output egress filter (extension to OutputScanningConfig) | ~250 | none — independent |

PR-N1 and PR-N2 can ship between any two detector PRs. Recommendation: PR-N2 after PR1 (independent infra, easy win); PR-N1 after PR5a (after the trifecta block lands, since lockdown is the architectural complement to the trifecta detector).

### 4.7 Rollout summary

| PR | Contents | LoC | Phase mix |
|---|---|---|---|
| PR1 | Framework + Bash provenance + inspection commands + placeholder | ~800 | infra |
| PR-N2 | Output egress filter (parallel-ok) | ~250 | post |
| PR2a | Stop quality detectors (§3.16, §3.17, §3.18, §3.19, §3.20, §3.22) | ~1000 | stop |
| PR2b | Pre-warn quality + ring-buffer extension (§3.21, §3.23) | ~500 | pre_warn |
| PR3 | Pre-block / pre-warn security shapes (§3.1, §3.2, §3.8, §3.9) | ~720 | pre |
| PR4a | Cross-session infra + cross-agent (§3.4, §3.10) | ~600 | pre_warn |
| PR4b | Stop + pre_warn (§3.3, §3.6, §3.7) | ~450 | mix |
| PR5a | Trifecta block + deterministic exfil (§3.11, §3.14 part) | ~500 | pre_block |
| PR-N1 | Untrusted-context lockdown policy (parallel-ok, after PR5a) | ~400 | pre |
| PR5b | Pre-warn injection (§3.5, §3.12, §3.13, §3.14 part, §3.15) | ~700 | pre_warn |
| PR6 | Existing-consumer migration | ~600 | refactor |

**Total estimated LoC:** ~6500 (with tests). **Total PRs: 11** (including the two parallel non-detector PRs and the post-rollout migration).

---

## 5. Per-PR LoC and test budget

### 5.1 Per-detector accounting

| Component | Typical LoC |
|---|---|
| Detection logic (regex compile + match + match-to-finding) | 30–60 |
| Module-level constants / pattern tables | 10–30 |
| Registry entry (entries-warnings.ts or entries-errors.ts) | 5–10 |
| Metadata entry (check-metadata/sequence.ts) | 5–10 |
| Unit tests (≥3 positive + ≥3 negative + edge cases) | 80–150 |
| **Per-detector total** | **~130–260** |

Pre_block detectors lean toward the higher end (require negative-case tests for the legitimate workflows they must not break). Stop / pre_warn detectors lean toward the lower end.

### 5.2 Test coverage convention (already pinned in CLAUDE.md)

Each detector ships with:

- ≥3 positive cases (trajectory + candidate that MUST fire the detector)
- ≥3 negative cases (legitimate sequences that MUST NOT fire)
- Edge-case checks (empty trajectory, malformed events, ring-buffer boundary)

For split-severity detectors like §3.14, add positive cases for each severity tier.

### 5.3 Performance regression test

PR1 ships a benchmark test that runs all enabled detectors against a 1000-event synthetic trajectory and measures total wall-clock. Threshold: p99 < 50ms across the full detector pack. Every detector PR re-runs this benchmark; threshold-busting PRs need optimization before landing.

---

## 6. Performance budget validation

### 6.1 PreToolUse pipeline budget

Per [[feedback_hook_latency_budget]] and `harness-system-diagrams.md` §1, the PreToolUse INSTANT band is < 50ms. Sequence detectors compete with the existing checks in that band.

**Worst-case PreToolUse detector count after full rollout:**

- 4 pre_block: §3.1, §3.2, §3.11, §3.14 (deterministic)
- 10 pre_warn at PreToolUse: §3.4, §3.5, §3.7, §3.8, §3.9, §3.10, §3.12, §3.13, §3.14 (ambiguous), §3.15, §3.21, §3.23 — total 12 actually

Total PreToolUse: ~16 detectors. Per-detector budget 1ms = 16ms slice. **Within the 50ms INSTANT band.**

**Per-detector validation:** each detector is constant-time over already-computed session state:

- Set / Map membership: O(1)
- Linear scan over `tool_sequence` (cap 20): O(20)
- Linear scan over `taint_sources` (typically O(10)): O(10)
- Project-graph lookup (cached): O(1) amortized

No detector requires regex compilation per call (compile-once at module load), no fs I/O, no spawn. The 1ms budget is realistic.

### 6.2 Stop budget

Per `harness-system-diagrams.md` §2, Stop allows "seconds tolerable." Stop detectors:

- 8 quality stop: §3.16, §3.17, §3.18, §3.19, §3.20, §3.22 (and the two pre_warn quality detectors don't count here)
- 4 security stop: §3.3, §3.4, §3.6, §3.10

Total Stop: ~12 detectors.

**Worst-case per detector:**

| Detector | Heaviest op | Cost |
|---|---|---|
| §3.18 magic_literal_cross_file | `Map<literal, Set<file>>` walk over session-bounded set | O(N_literals) typically <100 |
| §3.4, §3.10 cross-agent | Bounded `activity.jsonl` read (cached) | ~5–20ms (one fs read per Stop) |
| §3.16, §3.22 | Project-graph queries (cached) | ~1–5ms amortized |
| Others | Set / Map membership | <1ms |

**Total Stop budget consumed:** ~50ms worst case (one cache-miss for cross-session reads). Well under the "seconds tolerable" ceiling.

### 6.3 Validation strategy

Per §5.3, PR1 ships the benchmark. Each PR's CI runs it. If a detector ever crosses 5ms p99, that's a regression worth fixing (most detectors should be sub-1ms).

---

## 7. Test-fixture strategy

### 7.1 The fixture shape

```ts
// src/harness/__tests__/sequence-fixtures.ts

export function buildTrajectoryFixture(
    events: Array<Partial<HarnessEvent>>,
    overrides?: Partial<SessionTrajectory>,
): { session: SessionTrajectory; lastEvent: HarnessEvent } {
    const tracker = new SessionTracker();
    let last: HarnessEvent | null = null;
    for (const partial of events) {
        const ev = { ...DEFAULT_EVENT, ...partial } as HarnessEvent;
        tracker.recordEvent(ev);
        last = ev;
    }
    const session = tracker.get("test-session")!;
    Object.assign(session, overrides ?? {});
    return { session, lastEvent: last! };
}

const DEFAULT_EVENT: HarnessEvent = {
    hook_event: "PreToolUse",
    session_id: "test-session",
    agent_source: "claude",
    agent_name: "tester",
    timestamp: "2026-05-27T00:00:00.000Z",
};
```

This generalizes the `makeSession()` pattern already used in `stop-rescan.test.ts`. Tests pass an array of partial events; the fixture function fills in defaults and runs them through `SessionTracker.recordEvent` so the resulting `SessionTrajectory` has the same shape as a real session.

### 7.2 Test-pattern template

```ts
describe("secret_read_then_network_call", () => {
    it("fires on .env read followed by curl to remote host", () => {
        const { session, lastEvent } = buildTrajectoryFixture([
            { tool_name: "Read", tool_input: { file_path: ".env" } },
            { tool_name: "Bash", tool_input: { command: "curl https://example.com" } },
        ]);
        const matches = detectSecretReadThenNetworkCall(session, lastEvent);
        expect(matches).toHaveLength(1);
        expect(matches[0]?.message).toMatch(/secret.+network/i);
    });

    it("does NOT fire on .env read followed by Edit", () => {
        // ... legitimate workflow ...
    });
});
```

Same shape as the existing `stop-rescan.test.ts` tests. The fixture builds the trajectory; the detector is called directly; assertions check `matches.length` and `message`.

### 7.3 Replay-based debugging

The `interlinked trajectory replay` command (§2.3) is the production-grade version of the fixture pattern. Real-session debugging:

```bash
# Capture a real session's events
cat .interlinked/activity.jsonl | jq -c 'select(.session_id == "s-xyz")' > /tmp/session.jsonl

# Replay through one detector
interlinked trajectory replay /tmp/session.jsonl --check secret_read_then_network_call --verbose
```

This is what makes debugging FPs in PR3+ tractable.

---

## 8. Session-state extensions

### 8.1 `recent_line_edits` (PR2b for §3.21)

```ts
// In types/session.ts
interface SessionTrajectory {
    // ... existing fields ...
    recent_line_edits?: Map<string, Array<{
        range: { start: number; end: number };
        content_hash: string;  // sha256 of pre-edit content in range
        at_step: number;
    }>>;
}
```

Capped at ~20 entries per file (drop oldest on overflow). Populated at PostToolUse from `Edit` / `Write` events. Consumed by `add_then_revert_loop` (§3.21) at PreToolUse to check whether the candidate edit reverts a recent change.

**Snapshot serialization:** include in `serializeSessionForSnapshot` (line 331 of `session-state.ts`) and `readSessionFromSnapshot` for cross-process consistency.

### 8.2 `literal_occurrences` (PR2a for §3.18)

```ts
interface SessionTrajectory {
    // ... existing fields ...
    literal_occurrences?: Map<string /* literal hash */, Set<string /* file */>>;
}
```

Populated at PostToolUse via the existing `magic_literal_in_conditional` detector's extraction logic — same literal-extraction code, populates this map as a side effect. Consumed at Stop by `magic_literal_cross_file_proliferation` (§3.18) via `Set.size >= 3` threshold.

### 8.3 `recent_user_urls` (PR5b for §3.5)

```ts
interface SessionTrajectory {
    // ... existing fields ...
    recent_user_urls?: Set<string /* hostname or full URL */>;
}
```

Populated at SessionStart / UserPromptSubmit by scanning the prompt body for URLs. Consumed at PreToolUse by `network_after_user_input_url_match` (§3.5).

### 8.4 What does NOT need extension

All other detectors compose existing fields:

- `files_read` / `files_written` / `file_read_at` — already shipped
- `failed_files` — already shipped
- `taint_sources` / `sensitivity_level` — already shipped
- `declared_plan` — already shipped via `plan-capture.ts`
- `test_runs` — already shipped
- `assertion_counts` — already shipped
- `pending_completions` — already shipped
- `tool_sequence` — already shipped (cap 20 is fine; §3.21's per-file ring buffer is separate)

---

## 9. Detector-to-modality mapping

Per `harness-system-diagrams.md` §5's sixteen-modality table. Most sequence detectors don't fit cleanly into the existing modalities because the table is per-file-shaped; sequence detectors are temporal. The cleanest mapping:

| Detector | Closest modality | Mapping kind |
|---|---|---|
| §3.1, §3.5, §3.11, §3.14 (network/exfil) | #14 Dependency checking | Extension along the trajectory axis |
| §3.2, §3.3, §3.7 (supply-chain shapes) | #14 Dependency checking | Same |
| §3.4, §3.6, §3.10 (cross-agent) | #10 Codebase graph | Trajectory layer over the per-file graph |
| §3.8, §3.9 (Bash patterns) | — | New modality candidate |
| §3.12, §3.13, §3.15 (injection partials) | — | New modality candidate |
| §3.16, §3.22 (signature/helper) | #2 Dependency structure | Trajectory layer over impact-analysis |
| §3.17, §3.20 (test/coverage) | #1 Test coverage + #7 Unit testing | Trajectory layer |
| §3.18 (magic literal cross-file) | #9 Automated testing (general) | Cross-file aggregation |
| §3.19 (stale doc) | #11 Knowledge graph | Companion-presence check |
| §3.21 (line revert loop) | — | New modality candidate |
| §3.23 (plan drift quality) | — | New modality candidate |

**Proposed addition: modality #17 "Trajectory-aware sequence patterns."** Catches the detectors that don't fit existing modalities. Where it fires: PreToolUse INSTANT band + Stop. Local? Yes. The diagram doc's §5 table updates with this row when the framework lands.

---

## 10. The TrajectorySignature decision

Per master doc §5, the canonical `TrajectorySignature` is a stable, hash-friendly projection of `SessionTrajectory` — needed for the cloud tier (Tier 2 classifier input) and the integrity layer (chain commitment). Decision for the local detectors:

**Option A: detectors consume raw `SessionTrajectory` directly.**

- Pros: cheap (no canonicalization), in-memory, fast, all existing fields directly accessible.
- Cons: detectors get coupled to the in-memory shape; if `SessionTrajectory` changes incompatibly, every detector breaks.

**Option B: detectors consume canonical `TrajectorySignature` projection.**

- Pros: stable across versions, hash-friendly, ready for cloud tier reuse.
- Cons: canonicalization cost on every detector call (or every PreToolUse, if cached); detectors lose access to fields the signature doesn't carry.

**Recommendation: A.** Canonicalization is expensive; we don't need it for local-only deterministic checks; the cloud tier and integrity layer build the projection on demand from the same raw `SessionTrajectory`. Reserve B for the cloud-side codepath; local stays raw.

**One small mitigation:** detector functions take `SessionTrajectory` typed as `Readonly<SessionTrajectory>` so they can't accidentally mutate the trajectory. Compiler-enforced.

---

## 11. Risks and open questions

### 11.1 Risks

**Framework migration drag.** If we ship PR1–PR5b without ever doing PR6 (the existing-consumer migration), the codebase has trajectory consumers in four places. Documentation churn, maintainer confusion, FP-handling drift. Mitigation: explicitly schedule PR6 as part of the rollout planning, not "someday."

**Detector composition surprises.** Multiple detectors firing on the same trajectory may produce conflicting messages or noisy multi-line warnings. Mitigation: PR2's quality pack will surface this first (cheap to debug); the composition note pattern (one per family) handles deliberate composition; orthogonal detectors emit independently.

**Performance creep.** Each new detector adds ~1ms to the PreToolUse / Stop budget. After 23 detectors, the budget is consumed for sequence work alone — other PreToolUse / Stop work has less headroom. Mitigation: §5.3 benchmark catches it; we can downgrade or skip-by-default if the budget squeezes.

**Cross-session I/O cost.** §3.4, §3.10 do bounded `activity.jsonl` reads. If `activity.jsonl` is large (long-running project), the bounded-read helper needs careful indexing. Mitigation: cap by trailing-N-events read, not by date range; cache per Stop turn.

### 11.2 Open questions

1. **Should the framework support detector dependencies?** E.g., §3.11 (lethal_trifecta_structural) is a superset of §3.1 (secret_read_then_network_call). Should §3.1 not fire when §3.11 has already fired? Current proposal: both fire; the dedup logic lives in the rendering layer. May want to revisit if the output gets noisy.

2. **How does the framework handle detector failures?** A detector that throws should not break the harness. Current proposal: `try/catch` around each detector call; failures logged and skipped. Same pattern as `quality-checks.ts`.

3. **Detector versioning.** When a detector's logic changes meaningfully (FP shape changes), should the change be marked? For ratchets we already version metric IDs. For sequence detectors: same approach — bump a `version` field on the registry entry when the detection shape changes.

4. **Cross-detector tests.** §5 covers per-detector tests. We may also want integration tests that exercise multiple detectors on the same fixture trajectory to catch cross-detector interactions (e.g., does §3.11 firing suppress §3.1 if we add dedup?). Add to PR1's benchmark suite.

5. **The recently-edited-line ring buffer for §3.21 — what's the right cap?** ~20 entries per file is a guess. May want telemetry on real sessions before committing. Initial: 20; revisit after PR2b lands.

6. **Stop-event ordering vs `stop-rescan.ts`.** Both fire at Stop. Order matters for the warning block presentation. Current `stop-rescan.ts` writes one block; sequence detectors will write another. Decide: separate blocks, merged block, or interleaved? Probably separate blocks (clear provenance for each finding type).

7. **Defer marker scope.** Quality detectors have the same defer-marker semantics as security detectors per the §6 Stop-event integration note. But for sequence detectors with no single trigger line (e.g., §3.18 cross-file literal proliferation), the defer marker has to apply to the *family* or the *file set*, not a specific line. Need to specify the defer marker grammar for multi-event findings.

---

## 12. Done definition

The full rollout is "done" when:

- All 23 detectors are merged and live by default (or default-on with config override)
- The Bash CLI provenance fix tags `gh` / `glab` / `wget` / `curl` output `fetched_external`
- `interlinked trajectory show` / `replay` commands are documented in `docs/generated/`
- The performance benchmark (§5.3) passes with all detectors enabled
- The existing-consumer migration (PR6) has merged, with `turn-end.ts` / `pattern-detector.ts` / `trajectory.ts` / `verification-stop-checks.ts` consolidated into `sequence-checks/` (or explicitly documented as remaining separate)
- Two non-detector primitives (untrusted-context lockdown, output egress filter) have shipped
- The defer-marker grammar for multi-event findings is specified (§11.2 #7)
- Modality #17 "Trajectory-aware sequence patterns" is added to `harness-system-diagrams.md` §5

Estimated total work to "done": **~3–5 days of focused engineering**, spread across the 11-PR rollout. Each individual PR is ~half a day to a day. The framework decision in §3 is the load-bearing call — once that's pinned, the rest is mechanical.

---

## TL;DR

The full local trajectory implementation is **23 sequence detectors across 4 families** + **4 non-detector primitives** + **1 existing-consumer migration** + **3 prerequisites** (framework, Bash provenance, inspection commands). Eleven-PR rollout. Quality pack ships first (PR2a/b) as low-stakes scaffolding validation; security packs follow. Two non-detector PRs (lockdown, egress filter) ship in parallel. Migration ships post-rollout. ~6500 LoC including tests. Detectors consume raw `SessionTrajectory` (Option A in §10), not the canonical signature. Performance budget is comfortable (~16ms PreToolUse / ~50ms Stop worst case). Three small session-state extensions needed (§8). The framework's value is the dual-use — same mechanism for security + quality.

Build sequence:

1. PR1 (framework + Bash provenance + inspection commands) — biggest, ~800 LoC, prerequisite for everything
2. PR-N2 (output egress filter) — parallel-OK, independent
3. PR2a + PR2b (quality pack) — validate framework under low-stakes warns
4. PR3 (sequence-shape security pre-block / pre-warn) — framework now battle-tested
5. PR4a (cross-session infra + cross-agent) + PR4b (stop + pre_warn rest)
6. PR5a (trifecta block + deterministic exfil) — central injection block
7. PR-N1 (untrusted-context lockdown policy) — parallel-OK after PR5a
8. PR5b (pre-warn injection rest) — completes injection-defense pack
9. PR6 (existing-consumer migration) — cleanup, post-rollout
