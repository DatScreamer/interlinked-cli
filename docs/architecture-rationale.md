# Interlinked — Architecture Rationale & Q&A

> A durable companion to the [README](../README.md) and [`CLAUDE.md`](../CLAUDE.md):
> the load-bearing decisions behind interlinked, **why** each is made, the code
> that implements it, and the honest limits. Use it to onboard a contributor,
> explain the project to someone new, prep a talk, or answer hard questions about
> how it works and where it breaks.
>
> **On the code references.** Citations are `file:line` as of this writing. The
> gate order, the per-file line cap, and exact thresholds move — so verify against
> current source before quoting one. That discipline is the point of this whole
> document: **claim only what the code backs.** Several times while writing it, the
> "obvious" explanation of a subsystem turned out to undersell the real one. Read
> the load-bearing function before you describe it.

---

## 1. The one-breath version

Interlinked is a **local background daemon** — a Unix-socket server, one per
developer (`harness/server.ts`: *"Local Unix socket server … Runs as a background
process per developer"*). It does not live inside an editor; each coding agent's
**own hook system** is wired to call a thin client (`hook-entry.ts`: *"thin client
the installer wires into every runner"*) on every event. On `PreToolUse`, that
client hands the daemon the full **proposed** `tool_input` *before* the tool runs
or anything touches disk. The daemon evaluates it and returns block / allow in
single-digit milliseconds, deterministically.

**The problem it solves:** most teams using terminal coding agents enforce
nothing at runtime. They prompt the agent, it writes a pile of files and runs a
pile of commands, and then they spend a *second* pass — often a second agent — to
review it all. That doubles the time and the tokens. Interlinked moves enforcement
*into the action loop* so bad code is caught before it exists, not after.

---

## 2. The keystone: in-loop enforcement at the tool-call boundary

If you remember one thing, remember this:

> **The one architectural decision everything else hangs off is moving
> enforcement into the agent's action loop — evaluating the proposed tool call at
> the boundary, before disk, with the authority to block.**

This is the keystone, not determinism, not the daemon, not the multi-runner
support. The test of a true keystone is that *the rest of the architecture is
derivable from it* — and it is:

| Because enforcement is **in-loop**… | …it forces |
|---|---|
| it must be **fast** | deterministic eval, no LLM in the hot path, a **daemon** holding warm state |
| it must live **where the agent acts** | cooperative **hooks**, an **adapter** per runner |
| it can **block** | fail-open/closed policy, the **cold gates**, daemon self-heal |
| it sees the **proposed input** | the `tsc`/`biome` **diff-overlay** on not-yet-landed content |

Everything in sections 3–6 is in service of doing that one thing fast and safely.
Determinism (section 5.1) is the most important *supporting* pillar — it's what
makes in-loop enforcement fast and trustworthy enough to ship — but it is
downstream of the boundary decision, not the keystone itself.

---

## 3. The evaluation model — two axes

### 3.1 *What* it evaluates: four primitives

| Primitive | Input it looks at | Question | Default | Lives in |
|---|---|---|---|---|
| **Guard rules** | the action + payload (command, target path, write content for secrets) | *Is this operation allowed?* | **block** | `harness/rules-loader.ts` + `.interlinked/guard-rules.json` |
| **Checks** | one file's content (`fn(content, filePath)`) | *Is this code any good?* | **warn** (only zero-FP ones block) | `harness/check-registry/` + `harness/checks/<family>.ts` |
| **Structural checks** | the dependency graph | *Does this break things across files?* | warn | `harness/structural-checks.ts` |
| **Trajectory detectors** | the session's sequence of calls | *Is the behavior over time dangerous?* | warn/block | `harness/sequence-checks/` |

**Rules vs. checks, in one line:** a **rule** is a configurable denylist of
dangerous *operations* (destructive command, secret in a write, unapproved
install) — team-shareable JSON, individually disable-able, block-first. A
**check** is a per-file *code analyzer* — either **inline** (regex/AST heuristics)
or **tool-backed** (it actually runs `tsc` / `biome` / `gitleaks` / `semgrep`) —
warn-first. Rules guard the *act*; checks judge the *artifact*.

### 3.2 Where "tests" fit — *not* a fifth primitive

There is no "test" primitive beside rules and checks. What looks like one is a
**verification gate subfamily**:

- `evaluator/tdd-new-file-gate.ts` — a new `.ts/.tsx` source file with no
  companion test → block (`PreToolUse`). Note: it checks the companion test
  *exists* (lines 84–95); the message *advises* writing it red-first (line 107),
  but the red step is **not** enforced (see §7).
- `evaluator/coverage-write-decision.ts` — blocks an uncovered **added** line, a
  per-file coverage **drop** vs the high-water baseline, or a configured floor.
- `coverage-runner.ts` — *executes the project's actual tests* to compute coverage.
- `evaluator/commit-gate*.ts` — coarser, full-suite gate at commit time.

So "running tests" is **instrumentation feeding a coverage/TDD/mutation gate** —
not an evaluation layer beside rules and checks.

### 3.3 *When* it evaluates: the phase contract

Each check carries exactly one `phase` (`check-registry/types.ts`, `CheckPhase`):

- **`pre_block`** — runs `PreToolUse`, fires a user-confirmed block. **Reserved
  for fully-deterministic, zero-FP errors** where blocking at edit time trains the
  agent that the rail is real.
- **`pre_warn`** — runs `PreToolUse`, warns before the write lands (behavioral
  priming) without blocking.
- **`post`** — runs `PostToolUse` only. The default for anything heuristic.

The rationale is the most important idea in the whole system:

> Blocking on a heuristic teaches the model to distrust **all** the rails. So only
> zero-FP checks block pre-emptively; everything heuristic warns post. **The trust
> of the rail is itself a managed resource** — see §5.3.

The same idea maps onto the lifecycle: **`PreToolUse` blocks** what shouldn't hit
disk, **`PostToolUse` feeds back** on the next call, and **`Stop`** reviews the
whole last message against rules, checks, structure, and trajectory.

---

## 4. Hard questions, defensible answers

These are the questions a sharp reviewer asks. The strength is **volunteering the
limit before they find it** — a confident-but-hollow answer is worse than an
honest one.

### Q: What stops an agent from just… not calling the hook? Or running the command anyway?

Agents don't call hooks — they emit a tool-use request, and the **runner** fires
`PreToolUse` before executing. The agent gets no vote on whether the hook runs. So
the naive bypass is dead **for the runner's own tools.**

**But be honest about the boundary:** it's cooperative and lives at the *tool-call*
layer, not the syscall layer. It is **defense-in-depth, not a sandbox.** Three real
holes, all visible in the code:

1. It depends on the runner cooperating and the daemon being reachable (§4.2).
2. One approved `bash script.sh` / `python -c …` can write, network, or delete
   things the gate never sees. You *know* this because you patched a known case:
   `evaluator/pre-tool-rules.ts:164` (`bash-code-file-write-bypass`) blocks
   `cat > file.ts` / `tee` redirects into tracked source — and the compound-command
   decomposition just below it (≈ line 211) patches a `\n`-separated bypass. You
   don't write counters to the physically impossible.
3. No seccomp/LSM/container — anything running as the user writes to disk directly.

So the right framing: *the real security guarantee is anchored in a tier the agent
can't reach; the local harness makes the easy path safe and fast.*

### Q: The daemon crashes mid-session. The agent's next call is `rm -rf ./build && git push --force`. Blocked or allowed?

**Blocked — and not because a regex matched the dangerous command.** The cold
fallback (`hook-entry.ts:337`, `encodeColdFallback`) runs a **fail-closed gate
first** (`coldDaemonUnreachableBlockReason`, `hook-entry-daemon-gate.ts:138`): if a
daemon *was* running here (a stale `harness.pid`) **or** the repo is configured for
interlinked (a `config.json` is present), every `PreToolUse` call is refused — even
a benign `cat README.md` — because *a silently-dead guard is a security failure, not
a degraded-mode convenience* (the `THE GUARANTEE` comment, lines 11–22). It then
fires a lock-guarded `attemptDaemonSelfHeal` (line 233) so the **next** call is
guarded again. One block, retry, protected.

The **content regex cold gates** (merge-conflict → graph-shard → destructive →
package-install → large-file, `hook-entry.ts:373–392`) are the *second* path — they
only matter when **no daemon ever ran here** (a fresh checkout), where you can't
fail closed without bricking every clone. Escape hatches: `interlinked disable`
(recorded) and `INTERLINKED_ALLOW_NO_DAEMON=1`.

### Q: Why a long-lived daemon instead of running checks inline per call?

Three reasons, in order:

1. **Performance.** The daemon holds the expensive state warm — the **trigram
   index**, the **project graph**, compiled rules, the `tsgo` runner, content
   caches (all constructed in `server.ts`). `hook-entry.ts` says it outright:
   *"The full evaluator is too heavy to run inline in the hook process in every
   runner."* Cold-building that per Bash call detonates the millisecond budget.
2. **Capability.** Cross-call state a per-call process can't have: trajectory
   detectors, reservations, and a live **settings-watcher** (`watchSettingsFiles` /
   `autoStripAllScopes`) that repairs config tampering *between* calls.
3. **The hybrid line.** The cheap, catastrophic checks are deliberately kept
   **inline** as the fail-closed floor (the §4.2 cold gates). So the daemon's
   mortality isn't a weakness — it's a designed two-tier split: heavy + stateful in
   the daemon, cheap + critical inline.

*(Note: the daemon does not make the hook un-disable-able — both paths run through
the same runner config. What a live daemon buys against tampering is the
settings-watcher, not immunity.)*

### Q: Do you fail open or fail closed?

**Per check-class — that's the whole answer.** Continuity/quality fails *open* so a
harness hiccup never bricks the developer; security/supply-chain fails *closed*
because an unguarded install beats a blocked one. Concretely: the daemon-down gate
fails **closed** (§4.2); the red-bar test gate fails **open** when the runner can't
determine pass/fail (`testsPassed === null` → no block), because you won't brick an
edit over an errored test runner.

---

## 5. Three philosophical pillars

### 5.1 Determinism — no LLM in the baseline decision

**What it is:** the hot-path block/allow decision is 100% deterministic — regex,
AST, real compilers. An LLM policy classifier exists but is gated narrowly:
`server/pre-tool-pipeline.ts:102` only consults it when **`decision === "allow"`
AND the evaluator attached an `_escalation` flag AND the classifier is explicitly
enabled.** The LLM can only escalate a *flagged-allow* — it can never originate or
override a deterministic verdict. It's opt-in and circuit-breaks on consecutive
failures (`ClassifierSessionState`, `server/runtime-context.ts:69`).

**Why:** (a) latency — an LLM round-trip blows the millisecond budget; (b)
**replayability** — a deterministic decision replays from the JSONL log, so you can
prove *why* a call was blocked; (c) **auditability** — "every enforcement decision
is explainable and reproducible" is the trust story. A model's opinion isn't
auditable; a regex match is.

**The honest line:** "no LLM in the hot path" means "no LLM in the *local fast
baseline*." A cloud tier can, for security, block synchronously (on a separate
budget). The precise claim: **the baseline local decision is always deterministic;
LLMs are a narrow, opt-in escalation layer, never the default rail.** You trade
recall for trust, and add the probabilistic layer where a wrong answer degrades
gracefully instead of corrupting the baseline.

### 5.2 Receipts integrity — how "verified" is verified

The numbers on the landing page are audited by `scripts/audit-receipts.mjs` against
the **actual Claude Code session transcripts**, not the rules' self-reports. For
each `guard_block` event it resolves the agent's real `tool_input` from the
transcript and classifies it `real` / `fp_in_text` / `needs_review`, then strips two
inflation classes:

- **Substring false-positives** — old rules firing on a commit message, an `echo`
  arg, a grep pattern. Only transcript-confirmed `real` events count.
- **Over-registration duplicates** — pre-2026-05-18, one block logged 3–4× →
  collapsed within a 5 s window. Grep-accelerator "block-and-answer" events are
  excluded entirely (accelerations, not enforcement).

**Why it's credible:** the tell is that the audit makes the number *smaller*. The
dramatic categories (`rm -rf /`, `DROP TABLE`, `shutdown`) turned out to be
substring FPs and were **removed**; what remains (net-new `tsc` errors, the TDD
gate, repo-confinement) is less flashy but real. Missing transcripts count as
*unverified, not real* — conservative. That's the inverse of marketing.

**The honest limits** (the script states them itself): the window is fixed
(≈2026-04-24 → 2026-06-01) because a `guard_block` event-writer regression stopped
recording blocks after June 1; and CI can't reproduce the audit — it's gitignored
local data, run by hand pre-launch. State it plainly: *"transcript-verified,
conservatively, over a fixed window — and here's the auditor."*

### 5.3 False positives — taste levers, not noise suppression

**The stance:** checks are *taste levers*, not just bug catchers
(`feedback_taste_enforcement`). There is deliberately **no blanket "this looks like
an FP, mute it" layer** — the opinion *is* the product. If an agent reads a file, it
should fix what's there, not be let off by suppression.

**But it isn't zero diff-awareness** — the split is precise:

- **Blocking is diff-scoped:** the content gate blocks only on **net-new** `tsc` /
  `biome` errors; one edit isn't held hostage to a pre-existing error elsewhere.
- **A few noisy checks** get explicit baseline subtraction (`complexity`,
  `missing_return_types`, `no_test_file`, `undefined_env_vars` — the `diff_aware`
  config) — a scalpel, per-check, not a policy.
- **Everything else:** warn on what's in a file you touched.

The real rule: **suppress by *blast-radius* (did your edit's region cause it) for a
chosen few — never by *"probably an FP"* heuristics.** When a check is noisy, the
lever is to **sharpen its detection** (command-start anchors, quote-masking, AST) →
demote to `DEFAULT_ADVISORY_SKIPS` only as a last resort (`CLAUDE.md` §verify:
*"prefer refining the check's detection logic over demoting it"*).

**Why it matters:** false positives are expensive not because they annoy but because
**they erode the agent's trust in the rail** — a noisy check teaches the model to
ignore *all* the checks. Precision protects the enforcement signal. (Same idea as
§3.3: trust of the rail is a managed resource.) This is a *live calibration* — the
tension between "fix what you touch" and "don't drown in pre-existing noise" is
managed through the default-vs-advisory gate.

---

## 6. The metric ratchets

Three monotonic per-edit metrics, each gated so no edit leaves a function past its
hard cap (full spec: `docs/design/monotonic-metric-ratchet.md`):

- **Coverage** — blocks an uncovered *added* line or a per-file drop vs the
  high-water baseline (`coverage-write-decision.ts`). A non-decrease ratchet, not a
  push to 100 %.
- **Red bar** — the per-edit overlay runs the affected suite; a **failing** suite
  (`testsPassed === false`) blocks *before* the coverage decision and names the
  failing tests (`coverage-write-guard.ts:14`, `blockForRedBar`). There's a
  commit-time twin (`commit-gate-decision.ts:125`).
- **Cyclomatic / CRAP** — a uniquely-named function may rise by at most a small
  per-edit tolerance while under the cap; a bigger one-edit jump, or any end-state
  over the cap, blocks. The escape is to decompose, not suppress.

**On the roadmap (not built):** **mutation testing** — the principled answer to
*"is this test meaningful?"* A surviving mutant proves a test is inadequate, which
subsumes red-step TDD enforcement (§7). It's CPU-heavy but embarrassingly parallel,
so the design runs many mutants concurrently (wall-clock ≈ warm-up + one covering
suite run).

---

## 7. Known limits & live tensions (volunteer these)

The honest list. Each is a strength when you raise it first.

- **Cooperative trust boundary.** Enforcement depends on the runner invoking the
  hook; it is not kernel-enforced. The local layer is defense-in-depth; the real
  security guarantee must be anchored where the agent can't reach (§4.1).
- **Tool-call layer, not syscall layer.** One approved shell command can spawn work
  the gate never sees. Mitigated by pattern rules + trajectory detectors, not
  eliminated (§4.1).
- **Receipts window.** The verified counts cover a fixed window; `guard_block`
  logging regressed after 2026-06-01 (open), and the audit can't run in CI (§5.2).
- **Red-step TDD not enforced.** A companion test must *exist* and the suite must be
  *green at rest*, but nothing checks the test was ever *red* — so a tautological
  test can pass the gate. Partially covered today by the `tautological_assertion` /
  `assertion_free_test` checks; the principled fix is mutation (§6).
- **FP calibration is ongoing.** The anti-blanket-suppression stance vs. narrow
  diff-scoping is a live tension managed by the default-vs-advisory gate (§5.3).
- **Multi-agent reservations** exist (optimistic local grant + async server confirm)
  but are on the backburner — a remnant of the project's multi-agent-MCP lineage,
  ahead of the rules/checks that make it useful.

---

## 8. How to explain it

**In 60 seconds:** *"Interlinked is a local daemon your coding agent's hooks call
into. On every tool call, before anything hits disk, it evaluates the proposed
action — guard rules on the command, content checks on the code, structural checks
across files, and trajectory analysis across the session — and returns block or
allow in milliseconds, deterministically. The one decision everything hangs off is
moving enforcement into the agent's action loop instead of into an after-the-fact
review. Everything else — determinism, the daemon, the per-runner adapters, the
fail-closed crash handling — exists to make that one thing fast and safe."*

**In 5 minutes:** §2 (keystone) → §3 (the two axes) → one of §4's hard questions →
the §5 pillar that fits the audience (determinism for the trust/audit angle,
receipts for the credibility angle, FP philosophy for the quality angle) → close on
a §7 limit you'd fix next. Leading with a limit you volunteer is what separates
"I built a thing" from "I understand this system."
