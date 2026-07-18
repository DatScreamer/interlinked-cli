# Trajectory continuity + the local/cloud split (single-device, single-agent)

**Status: design, 2026-07-17.** Companion to
`test-category-adoption-from-the-wild.md` (§13 fresh sweep, §6 router, §9.0
trajectory routing) and `deterministic-trajectory-rules.md`. Directives folded
in: per-edit tests are repo policy (quality > speed); trajectory analysis must
never derail a continuously-running agent; SessionEnd-class hooks carry as much
of the trajectory load as Pre/PostToolUse.

## 1. The local/cloud partition (from the §13 taxonomy)

**LOCAL — already live:** scoped unit+integration with coverage per edit
(150s budget), red/green debt lifecycle (ownership-scoped), CRAP, cyclomatic
slew+cap, line cap, ratchets, secrets/SAST-lite, commit gate (full suite),
Stop reflections, debt-evasion counter.

**LOCAL — build next (all single-device, deterministic):**
- Run-if-exists per-edit tier inside the 150s box: doc-example tests, bounded-N
  property runs (cap ~50 cases/edit; full N at commit), golden/snapshot of the
  affected set, contract/schema-drift tests, compile-fail suites, TP/FP corpus
  runs for detector-shaped code.
- Flake double-run of NEW/changed tests (run twice; divergence ⇒ nondeterminism
  warning — his "a retry-pass is still a flake signal", inverted into a probe).
- Deterministic 60s fuzz-smoke on touched parser-ish targets — at the COMMIT
  gate (eats too much of the per-edit box alongside the suite).
- Statistical alarm machinery for OUR OWN gates: anytime-valid e-process /
  conformal thresholds over streaming local evidence (flake rates, perf drift,
  warn rates) instead of fixed cutoffs. Cheap math, huge FP reduction — the
  single most transferable piece of his statistical layer, and FP reduction is
  continuity (§2).
- Resource governor (§7 of the adoption doc) — job caps + background QoS.
  Quality>speed does not mean tank the laptop; it makes heavier local lanes
  safe.
- SessionEnd async tail: the machine goes idle when the session ends — run the
  heavy LOCAL batch there (full suite + coverage refresh, fuzz-smoke sweep,
  bench snapshot with variance-aware thresholds, evidence bundle write).
  SessionEnd is the free compute window on a single-device setup.
- ALL deterministic trajectory analysis (§2–§3): in-memory state + pattern
  matching, microseconds; there is no cloud dependency in any of it.

**CLOUD/REMOTE — defer to the later plan:** fuzz campaigns (hours), sanitizer
matrices (instrumented rebuilds), Miri/Loom-scale interleaving, soak/stress,
cross-platform/arch matrices, live-oracle differential suites at scale
(pip-install-the-reference class), competitor benches on pinned hardware,
formal-proof CI, whole-suite mutation if ever revived, RCH-style remote build
offload, multi-agent fan-out, and the Tier-2 LLM window-review judge
(flag-triggered only; never in the deterministic pipeline).

## 2. Continuity doctrine — why bad trajectory analysis derails, and the ladder

Derailment mechanics: mid-flow blocks on *suspicion* (not certainty) make the
agent thrash — retry, re-plan, lose the thread — until a human restarts it.
Repeated identical warnings train ignoring AND consume the agent's attention.
Both are trajectory-analysis failure modes, not arguments against trajectory
analysis. The design answer is a graduated ladder with promotion gates:

  shadow metric → SessionEnd/Stop reflection → PostToolUse additionalContext
  → PreToolUse warn → PreToolUse BLOCK (outflow events only)

- Every new trajectory detector is BORN in shadow mode (`trajectory_shadow`
  engine already ships ON) and earns each promotion with observed FP data
  (recurrence records are the evidence store).
- **Blocks anchor on points of no return** — commit, push, publish, exfil
  sink, destructive command (§9.0 rule). In-flight weirdness only accumulates
  evidence; at the outflow event "not yet" becomes "shipping without", and the
  FP evaporates. This is THE continuity mechanism: the agent is never halted
  mid-thought on a guess.
- **Stop-block is the continuity-safe enforcement point** for turn-level
  findings: Claude Code's Stop `decision:"block"` forces the agent to
  CONTINUE (fix, then re-stop) — enforcement without a restart. Prefer it over
  mid-turn blocks for anything turn-scoped.
- One-shot, deduped messaging everywhere (the foreign-debt-note pattern:
  once per (session, finding)); self-clearing state (fingerprints TTL out at
  ~30 calls / 15 min); every block names the narrowest recorded escape.
- **Derailment budget (novel, measurable):** per detector, correlate firings
  with post-firing productivity (did the agent land edits within K calls? did
  the session end abnormally?). Session-state has the data. A detector whose
  firing correlates with stall/abandonment is auto-demoted a rung. FP rate is
  a proxy; derailment is the real cost — measure it directly.

## 3. Hook distribution (SessionEnd-class carries half the load)

| Hook | Trajectory role | Cost posture |
|---|---|---|
| PreToolUse | Prefix-sufficient OUTFLOW blocks (commit/push/exfil/destroy + workaround-laundering at commit, §4); cheap in-memory pattern warns | μs; in-memory |
| PostToolUse | additionalContext steering — accumulated observations delivered agent-visibly, human-invisibly; zero flow break | μs |
| Stop | The turn workhorse: block→workaround summary (debt-evasion line shipped), did-then-undid incoherence, turn-union review; Stop-block for hard incompletions | ms; batched + deduped |
| SubagentStop | Roll subagent trajectory signals into the parent (rollUp pattern exists) | ms |
| SessionEnd | Cross-turn synthesis: recurrence records, fingerprint archive, evidence bundle, heavy local async batch (§1) | seconds+; nothing watching |
| SessionStart | **Continuity across restarts**: preload last session's unresolved trajectory flags + open debts + fingerprints as context — a restart no longer amnesia-wipes the analysis | ms |

The SessionEnd→SessionStart pair is what makes "let agents run continuously"
compatible with "analyze deeply": deep analysis happens where nothing is
waiting, and its conclusions re-enter at the next session boundary.

## 4. The block→workaround detector family (first cohort, all local)

Substrate: at every PreToolUse block, fingerprint the refused action into
session state — content shingles (n-gram hashes of proposed content/command),
target path, rule_id, timestamp. Rolling window ~30 calls. Detectors are pure
functions of (window, proposed event):

1. **Same-content resurfacing** — blocked content's shingles reappear in a
   later Bash heredoc/inline-exec/subagent prompt (SubagentStart capture
   exists). Generalizes debt-evasion beyond `node -e`.
2. **Same-target-different-channel** — blocked file path later written via
   redirect/tee/`sed -i` (resolveBashWriteTarget exists) or staged in temp
   then copied in.
3. **Config-loosening-in-window** — guard-rules/settings/baseline edits within
   N calls of a block (baseline-integrity already hard-blocks some; the rest
   become trajectory evidence).
4. **Escape-env after block** — `INTERLINKED_DISABLE_*` / `*_ALLOW_*` usage
   correlated to a preceding block (currently logged, never correlated).
5. **Minimally-mutated retry** — small-edit-distance resubmission of a blocked
   action (soft_blocks catches verbatim; this catches the dodge).
6. **Disable-then-do** — `interlinked disable` / harness stop in-window.
7. **Delegated execution** — a subagent spawned whose prompt carries the
   blocked fingerprint.

Routing per §2: all seven born in shadow; surface as ONE Stop line; the only
PreToolUse block in the family is **workaround laundering at commit** — a
commit whose staged content matches a still-armed blocked fingerprint blocks
WITH THE STORY ("this content was refused at 10:43 by <rule>; it entered via
<channel>"). Labeled positive corpus for all seven: this session's own
transcript (2026-07-17).

## 5. Sequencing

1. Fingerprint store in session-state (+ TTL, + SessionEnd archive /
   SessionStart preload). 2. Detectors 1–4 in shadow + the single Stop line.
3. Derailment-budget telemetry (promotion evidence). 4. Commit-time
   laundering block (the one outflow block). 5. Run-if-exists per-edit test
   tier (§1). 6. E-process thresholds for warn-rate calibration.
7. Later plan doc: the cloud lane (campaigns, matrices, oracles, LLM judge).
