# Cohort git discipline — making the multi-agent guard actually guard

**Status:** Shipped — defect 0 fixed 2026-07-09 (6d29859, `apply_patch` writes lease their section paths); predicate-gated blast-radius rules + local-lease escalation shipped 2026-07-10 (2475022). Planned 2026-07-09; sourced from `docs/external-pulse/bun-in-rust.md` §2.6.

**Stance (operator, 2026-07-09).** *Two or more agents on one working tree is the normal state
of things, not a bug.* File reservations exist so two agents don't hold the same file at the
same moment. Concurrency itself is not the problem. **Destructive commands are.**

This plan takes that as its premise. It is therefore about three narrow defects, not about
concurrency:

0. **`apply_patch` writes take no reservation at all.** Confirmed below. This is the bug.
1. **Leasing is a no-op for local holders.** Even when a reservation *is* taken, a conflict
   blocks only a *remote* holder. Two local agents both get a warning and both writes land.
2. **A handful of git commands act on files the agent never named.** Their blast radius is the
   whole worktree. Solo that is untidy; with a sibling's in-flight edits present, it captures
   or destroys work the agent cannot see.

**Field-tested during authorship — and the root cause found.**

A Codex session was editing this tree while this plan was written. Almost all of it was
harmless: it worked in `src/`, this author worked in `docs/`, nothing collided. Concurrency was
a non-event, exactly as the operator says. Then **both sessions wrote
`docs/external-pulse/bun-in-rust.md`**, and the second write silently replaced the first
author's paragraph. The collision surfaced only because a later `Edit` happened to fail a
modified-since-read check.

`.interlinked/reservation-events.jsonl` shows **four grant/release pairs on that file, all from
one session.** Codex never took a lease — even though `.codex/config.toml` carries
`hooks = true` and the daemon was live. Root cause, in `evaluateAutoReservation`
(`evaluator/pre-tool-decision-phases.ts:148-150`):

```ts
if (!isFileWrite(toolName)) return null;                 // apply_patch IS in this list — passes
const filePath = (toolInput.file_path as string) || (toolInput.path as string) || "";
if (!filePath) return null;                              // ← and dies here, silently
```

`apply_patch` is in `isFileWrite` (`tool-classifiers.ts:74`), so it clears the classifier. But
its tool input carries a patch blob under `command` / `patch` / `_raw_patch` / `content` and
**never a `file_path`** (`apply-patch-content.ts:58-66`). So `filePath` is `""` and the gate
returns `null`: **no lease, no conflict, no warning.**

Two files away, the coverage gate already solves this. `editedFileForEvent`
(`server/pre-tool-coverage-gates.ts:53-63`) falls back to `extractApplyPatchRaw` +
`parseApplyPatchSections` to recover the edited paths. The reservation gate never got that
fallback.

**`apply_patch` is Codex's edit primitive.** So today, leasing does not exist for one of the
four supported clients — and a Claude session and a Codex session in the same tree are
unprotected by construction. This is defect 0, it explains the observed lost update, and it is a
one-function fix: reuse `editedFileForEvent`, reserve **every** section path in the patch, not
just the first.

That also means §4.4's local-conflict escalation is *necessary but not sufficient*: fixing the
local-vs-remote branch protects nothing until `apply_patch` takes a lease at all.

---

## 1. The blast-radius principle

The rules in §4.3 are not "multi-agent rules." They gate commands whose effect is **not
bounded by the paths the agent named**:

| Command | Names its targets? | Effect |
|---|---|---|
| `git commit <path> -m …` | yes | bounded |
| `git commit -a` | **no** | commits every tracked modification, including a sibling's |
| `git add -A` / `.` | **no** | stages everything, including a sibling's |
| `git stash` | **no** | *removes* every uncommitted change from the tree |
| `git rebase` | **no** | rewrites history under everyone |
| `git checkout <branch>` | **no** | moves HEAD under everyone |
| `git reset --hard` | **no** | destroys all uncommitted work — **already blocked** |

Bun's rule — *"never run `git stash` or `git reset` or any git command that doesn't commit a
specific file at once"* — is exactly this principle, stated as a prompt. The harness exists to
state it as a mechanism.

Cohort size is a **scoping condition, not the rationale**: a solo agent's `git add -A` sweeps
up only its own work, so the rule stays dormant and the common case pays nothing. The reason
the command is bad is that its radius is unnamed files; the reason we only enforce it in a
cohort is that only then does the radius cover someone else's.

## 2. The failure, as Bun hit it

> I asked Claude to loop the workflow on all 1,448 `.zig` files, and about 2 minutes in, one
> Claude ran `git stash` before committing. Another ran `git stash pop`. And then
> `git reset HEAD --hard`. They were stepping on each other!

Bun's fix was a prompt rule: *never run `git stash` or `git reset` or any git command that
doesn't commit a specific file at once.* A prompt rule is exactly what this harness exists to
replace with a mechanism — "compiler errors are a better feedback loop than a style guide."

Of Bun's three stomping commands, we block **one**.

| Command | Our rule | Verdict |
|---|---|---|
| `git reset --hard` | `builtin-git-reset-hard` | **block** |
| `git stash drop` / `clear` | `builtin-git-stash-destroy` (+ a duplicate in `builtin-rules-extras.ts`) | block |
| **`git stash`** (plain) / `git stash push` / `save` | — | **allowed** |
| **`git stash pop`** | — | **allowed** |
| **`git rebase`** (non-interactive) | — | **allowed** (`-i` is `ask`) |
| **`git add -A`** / `--all` / `.` | — | **allowed** (only `-i`/`-p` blocked) |
| **`git commit -a`** | — | **allowed** (only `--amend` is `ask`) |
| **`git checkout <branch>`** / `git switch` | — | **allowed** |

Every "allowed" row is harmless solo. In a cohort the top four *destroy or rewrite* a
sibling's work; `add -A` and `commit -a` merely *capture* it into someone else's commit —
annoying, recoverable, still wrong. Only the destructive set is urgent.

## 3. Why the existing machinery doesn't fire

Three separate mechanisms exist. None of them counts agents.

**3.1 Reservations block only *remote* holders.** `evaluateAutoReservation`
(`evaluator/pre-tool-decision-phases.ts:139-171`):

```ts
const conflict = reservations.checkAndReserve(filePath, agentName, cohort);
if (!conflict) return null;
if (conflict.cohort === "remote") { return { decision: "block", ... }; }
warnings.push(`[interlinked] Note: Your agent "${conflict.agent_name}" also has ${filePath} reserved.`);
return null;   // ← the write proceeds
```

`checkAndReserve` sets `cohort: isLocal ? "local" : "remote"` from a single line —
`const isLocal = cohort.hasAgent(entry.agent_name)` (`reservations.ts:118`). "Local" means
*this daemon knows the holder*. And `sameOwner()` has **already** excluded the caller itself
(`reservations-state-machine.ts:43`), so a "local conflict" is by construction **a different
agent of the same human, holding the same file, right now**. That is the case leasing exists
for, and it is the one we downgrade to a note.

The message even misreads it: *"Your agent X also has this reserved"* — as if it were the
same agent. It isn't.

Worse: with no `apiClient` configured there are **no remote reservations at all**, so nothing
ever blocks. Which is the default local install.

**3.2 There is no cohort-size axis.** `cohort.ts` implements `getActiveAgents()`,
`getAllAgents()`, and `getCounts()` — and **none of the three has a single production caller**
(grep: tests only). The cohort exists to answer `hasAgent()` for the reservation split and to
release reservations for lost agents. `ActiveWhen` has seven axes (`skill`, `phase`,
`after_command`, `file_scope`, `overlay`, `agent_source`, `predicate`) and not one of them
reads agent count.

**3.3 `applies_to_roles` is wired but dead.** `GuardRule.applies_to_roles?: AgentRole[]` is
filtered in the rule loop (`evaluator/pre-tool-rules.ts:138`, `:306` via `ruleAppliesToRole`).
**Zero builtin rules set it.** And it would not work if they did: `inferAgentRole`
(`command-decomposition.ts:432`) derives `"subagent"` from `event.parent_agent`,
`event.agent_type`, or `hook_event === "SubagentStart"` — and the normalizers populate those
fields **only on Subagent lifecycle envelopes**, never on an ordinary PreToolUse tool call.
So at gate time, a subagent's role resolves to `"unknown"`.

The cohort *does* know the lineage — `subagentJoined()` records `parent_agent` — but nothing
asks it.

## 4. Design

Four changes, in dependency order. Each is small; the first unlocks the rest.

### 4.1 A `cohort` axis on `ActiveWhen`

```ts
export interface CohortSpec {
  /** Rule dormant unless at least this many agents are active in the cohort. */
  min_agents?: number;
  /** Rule dormant unless the acting agent's role is in this set. */
  roles?: AgentRole[];
}
```

Evaluated by a new `evaluateCohortAxis(spec, cohort, event)`, AND-ed into
`evaluateActiveWhen` (`evaluator/active-when.ts:59-85`) alongside the other six. This requires
threading `CohortManager` into `evaluateActiveWhen`, which today takes
`(rule, session, event)`.

**`cohort.getCounts()` gets its first production caller.** No new counting code — the method
is already written, tested, and dead.

Semantics: a cohort rule is **dormant at one agent**. That is what makes this shippable — the
solo-agent path, which is the overwhelming majority, is untouched and pays nothing.

### 4.2 Teach `inferAgentRole` to ask the cohort

Root cause of the dead `applies_to_roles`: the wire event lacks `parent_agent` on tool calls.
The cohort has it. Change the signature to
`inferAgentRole(event, cohort?)` and add one lookup before the existing fallbacks:

```ts
const known = cohort?.getAgent(event.agent_name ?? "");
if (known?.parent_agent) return "subagent";
```

`getAgent()` already exists and already has production callers
(`lifecycle-events-handlers.ts:48`). This is the whole fix. Thread `cohort` from
`pre-tool-rules.ts:306`, which already receives it.

### 4.3 The rules

New file `src/harness/rules/builtin-rules-cohort.ts`, exporting `COHORT_DISCIPLINE_RULES`.
Every rule carries `active_when: { cohort: { min_agents: 2 } }` and
`tool_match: ["Bash", "Shell", "run_command"]`, `trigger: "PreToolUse"`.

| id | action | pattern (sketch) | reason |
|---|---|---|---|
| `builtin-cohort-git-stash` | block | `\bgit\s+stash\b(?!\s+list)` | stashing moves another agent's uncommitted work |
| `builtin-cohort-git-rebase` | block | `\bgit\s+rebase\b` | rewrites history under a concurrent agent |
| `builtin-cohort-git-add-all` | block | `\bgit\s+add\s+(?:-A\b\|--all\b\|\.(?:\s\|$))` | stages another agent's in-flight edits |
| `builtin-cohort-git-commit-all` | block | `\bgit\s+commit\b[^;&\|]*\s-(?:a\|-all)\b` | commits another agent's in-flight edits |
| `builtin-cohort-git-switch-branch` | block | `\bgit\s+(?:checkout\|switch)\s+(?!--?\w)` | moves HEAD under a concurrent agent |

Shared `suggestion`: *"Another agent is active in this worktree. Commit named paths only:
`git commit <path> … -m '…'`. Coordinate before touching shared git state."* — which is Bun's
rule, verbatim, as a mechanism.

`git stash list` is exempted (read-only). `git stash drop|clear` stay unconditionally blocked
by the existing rules regardless of cohort size.

### 4.4 Escalate the local reservation conflict

In `evaluateAutoReservation`, a local conflict becomes a **block** when the cohort has ≥2
active agents *and* the holder is not in a parent/child relationship with the caller:

```ts
if (conflict.cohort === "remote") return blockRemote(conflict);
if (cohort.getCounts().active >= 2 && !isLineage(cohort, agentName, conflict.agent_name)) {
  return blockLocal(conflict);   // "File held by sibling agent X. Coordinate or wait."
}
warnings.push(...);   // parent↔child, or solo → unchanged
return null;
```

`isLineage(a, b)` = either is the other's `parent_agent`. A main agent and the subagent it
delegated to are permitted to touch the same file — that is a normal delegation, not a race.

**Blocking is safe here because reservations expire.** `AUTO_RELEASE_MS = 30_000` (idle
release), `RESERVATION_TTL_S = 300`, and `detectLostAgents()` releases at 5 minutes of
silence. A crashed sibling cannot deadlock a file for more than 30 seconds of idleness. Say
so in the block message so the agent waits instead of fighting.

## 5. Rejected: "No `cargo`. No slow commands."

Bun banned expensive commands in worker agents because 64 Claudes running `cargo check` on
one EC2 instance saturated the IOPS he had forgotten to provision. The mechanical translation
would be a cohort rule blocking `npm test` / `npm run build` / `tsc -b` / `cargo check` for
`applies_to_roles: ["subagent"]`.

**Reject it.** It contradicts this repo's own measured profile, stated in CLAUDE.md:

> **Verify after substantive edits.** Run the project's test / typecheck / build at ~0.5–1.0
> verifier runs per code edit (the best-model floor; the anti-pattern is ~0).

A gate that blocks a subagent from verifying its own work manufactures the exact anti-pattern
the Stop-event nudge exists to catch. Bun's constraint was **disk IOPS on one shared box at 64
agents**, not correctness. Ours is a laptop at 2–4 agents, and the problem already has a
designed owner: the good-citizen resource governor in
`test-category-adoption-from-the-wild.md` §7 — `taskpolicy -b` on macOS (E-cores),
`nice`+`ionice`+`cpu.weight` on Linux, PSI-sensed backpressure, CPU-second budgets. That is
the right mechanism: **throttle, don't forbid.**

Route the concern there. Do not ship a rule that punishes verification.

## 6. Cold-fallback and the two hook paths

Cohort rules are **daemon-only by construction**: when the daemon is down there is no cohort
state, so there is nothing to count. They fail open. This is correct per
`feedback_safety_continuity` — these are coordination rules, not security rules, and a
false-block on a solo agent whose daemon crashed is worse than a missed warning.

Concretely: **no inline mirror is needed** in `lib/hook-template-chunks/guards-inline.ts` and
no `cold*BlockReason` in `hook-entry-cold-gates.ts`. That is a real saving — the memory note
`project_hook_paths_two_implementations` warns that guards must be mirrored across
`dist/hook-entry.js` and the generated `.mjs`, but that applies to the *destructive* ladder
(which is codegen'd from a shared `DESTRUCTIVE_COMMAND_GUARD_SOURCE`, so it cannot drift) and
the four hand-written mirrors. Cohort rules join neither set.

## 7. Wiring

| File | Edit |
|---|---|
| `src/harness/types/rules.ts` | `CohortSpec`; add `cohort?: CohortSpec` to `ActiveWhen` |
| `src/harness/evaluator/active-when.ts` | `evaluateCohortAxis`; AND it into `evaluateActiveWhen`; thread `CohortManager` |
| `src/harness/evaluator/pre-tool-rules.ts` | pass `cohort` to `evaluateActiveWhen` and to `inferAgentRole` (L306) |
| `src/harness/command-decomposition.ts` | `inferAgentRole(event, cohort?)` — cohort lineage lookup first |
| `src/harness/rules/builtin-rules-cohort.ts` | **new** — `COHORT_DISCIPLINE_RULES` (5 rules) |
| `src/harness/rules/builtin-rules.ts` | spread `...COHORT_DISCIPLINE_RULES` into `BUILTIN_RULES` |
| `src/harness/rules/__tests__/builtin-rules.test.ts` | the sum-invariant assertion (`BUILTIN_RULES.length === Σ category lengths`) needs the new array |
| `src/harness/evaluator/pre-tool-decision-phases.ts` | `evaluateAutoReservation` — the local-conflict block + `isLineage` |
| `src/harness/cohort.ts` | export `isLineage(cohort, a, b)`; no other change (`getCounts`/`getAgent` already exist) |
| `docs/generated/guard-rules.md` | **regenerate** — see below |

### `npm run docs` **is** required here

Unlike inline content checks, guard rules **are** pinned in generated markdown:
`docs-freshness.test.ts:20-26` asserts `guard-rules.md` contains the literal string
`` `${getBuiltinRules().length} built-in rules` ``. Adding 5 rules moves 116 → 121. Run
`npm run docs` in the same change or CI goes red.

(Note: CLAUDE.md and `docs/harness.md` both say **105** built-in rules. That number is stale
prose — nothing pins it, and the live count is 116. Fix it while you're here.)

## 8. Tests

- `command-guard-parity.test.ts` gains cohort cases: with a 1-agent cohort each new rule
  **allows**; with a 2-agent cohort each **blocks**. This is the load-bearing assertion —
  the whole design rests on solo agents paying nothing.
- `active-when.test.ts`: `cohort.min_agents` dormancy; `cohort.roles` filtering.
- `reservations.test.ts` (already `fast-check`-driven): a property that two *sibling* agents
  never both hold a grant on the same file, and that a parent/child pair still can.
- `command-decomposition.test.ts`: `inferAgentRole` returns `"subagent"` for a plain
  PreToolUse event whose agent is a known child in the cohort. This is the regression test for
  the dead-lever bug.

## 9. Ordering, and the open questions

Ship **defect 0** first (the `apply_patch` lease). It is the bug that actually bit, it is a
one-function fix, and until it lands nothing else in this plan protects a Codex/Claude pair.

Then 4.4 (the local-conflict escalation) — the operator's model already assumes this works
("we have file reservation/leasing/locking so that two agents aren't working on the same file at
the exact same time"). Today that sentence is true only against remote agents. Make it true.

Then 4.1 + 4.2 (the axis and the role fix) — pure capability, they gate nothing and make
`getCounts` / `applies_to_roles` live. Then 4.3 (the rules), destructive-first: `stash`,
`rebase`, `checkout` before `add -A` / `commit -a`.

**Defect 0 is now confirmed, not an open question.** *(Fixed 2026-07-09 in
6d29859 — `evaluateAutoReservation` recovers apply_patch section paths and
leases each; regression tests cover the multi-section shape.)* Fix it first:
`evaluateAutoReservation` must recover paths via `editedFileForEvent` (or
`extractApplyPatchRaw` + `parseApplyPatchSections` directly) and lease **every** section path,
not just one. Regression test: a Codex-shaped `apply_patch` event with two file sections takes
two grants. Today it takes zero, and no test catches that — `reservations.test.ts` only ever
constructs `file_path`-bearing events.

**Open question 2 — parent/child same-file writes.** 4.4 exempts a lineage pair (a main agent
and the subagent it spawned) so delegation still works. That exemption relies on
`cohort.subagentJoined()` having recorded `parent_agent`, which happens only on a
`SubagentStart` envelope. If a runner doesn't emit one, the pair looks like two siblings and the
delegation blocks. Fail **open** on unknown lineage (`feedback_safety_continuity`), and count
how often lineage is unknown before tightening.

**Open question 3 — `git switch`/`checkout <branch>`.** Moving HEAD under a sibling is bad, but
the pattern `\bgit\s+(?:checkout|switch)\s+(?!--?\w)` also catches `git checkout -b feature`,
which is how an agent *avoids* stepping on main. Carve out `-b` / `-c`, and re-read
`feedback_commit_to_main_directly` before making branch-creation harder than committing.
