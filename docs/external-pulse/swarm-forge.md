# SwarmForge

- **Source:** https://github.com/unclebob/swarm-forge (Robert C. Martin / Uncle Bob, forked from his son Justin) — 708 stars, last commit 2026-05-25. Sibling tools: [`crap4go`](https://github.com/unclebob/crap4go), [`dry4go`](https://github.com/unclebob/dry4go), [`mutate4go`](https://github.com/unclebob/mutate4go), [`Acceptance-Pipeline-Specification`](https://github.com/unclebob/Acceptance-Pipeline-Specification), Java/Clojure peers (`crap4java`, `crap4clj`, `mutate4java`, `clj-mutate`, `dry4java`, `dry4clj`).
- **Encountered:** 2026-05-25, user prompt — "Uncle Bob's swarm-forge is trying to approximate what I have in mind; instead of having multiple agents do that work, our harness could make agents to do that work and enforce it."
- **Verdict:** mixed. `/enforce` PR (Lane 1, today) + memory note for the multi-agent role pattern (Lane 4) + cloud-roadmap entry for harness-enforced role boundaries (Lane 5). License blocks code-borrow on the quality tools; subprocess-invoke is the wedge for the Go-shop quality lane.

## 1. Core idea (my words)

A `tmux + git-worktree + bash` orchestrator that launches four LLM agents (specifier / coder / refactorer / architect), each pinned to its own worktree, each given a prose "Constitution" as system prompt instructing them to follow TDD, run CRAP analysis, run mutation testing, and pass messages via `tmux send-keys`. Discipline is **promised, not enforced** — the Constitution is text and the agents run with `claude --permission-mode acceptEdits`.

## 2. Anatomy (concrete walkthrough)

Repo is small: 533 LOC of shell + 8 prompt files (≤25 lines each) + 2 docs. Read in full.

```
swarm-forge/
  swarmforge.sh           533 lines — tmux/worktree/window orchestrator (no enforcement code)
  swarm-window-watchdog.sh 148 — reopens closed terminal windows
  swarm-cleanup.sh         30 — tmux kill-session
  swarmlog.sh              16 — tail wrapper
  swarmforge/
    swarmforge.conf            "window <role> <agent> <worktree>" lines
    constitution.prompt        "read project, engineering, workflow prompts in that order"
    constitution/
      project.prompt           project-specific rules (8 lines for Go example)
      engineering.prompt       names crap4go/mutate4go/dry4go and how to invoke them
      workflow.prompt          handoff format, pending-messages/ queue, branch ownership
    architect.prompt           role rules (25 lines)
    coder.prompt               role rules (17 lines)
    refactorer.prompt          role rules (17 lines)
    specifier.prompt           role rules (19 lines)
  examples/clojureHTW/         one example swarm config
  README.md  SwarmForgeInitSpec.md
```

Load-bearing files (read firsthand):

- **`swarmforge.sh`** — pure orchestration: parses `swarmforge.conf`, creates per-role worktrees under `.worktrees/`, opens tmux sessions on a per-project Unix socket, opens one Terminal window per role via `osascript`, writes a per-project `swarmtools/notify-agent.sh`, launches each backend in its worktree. **Zero validation, zero hooks, zero `git` policy beyond `git worktree add`.**
- **`launch_role()` (sh:409–442)** — the load-bearing line is `claude --append-system-prompt-file '$prompt_file' --permission-mode acceptEdits …`. Agents run in auto-accept mode. Every gate is off; the *only* discipline is whatever the prompt convinces the model to self-impose.
- **`swarmtools/notify-agent.sh`** — `tmux send-keys -t <target>:0.0 -l -- "$MESSAGE"` then `C-m`. That's the entire inter-agent protocol: keystroke a message into another pane and hope the agent reads it. No queue ACKs, no schema, no mutex — the receiving agent stores queued messages as `pending-messages/PP-YYYYMMDD-HHMMSS-source.txt` files because it has no real mailbox.
- **`swarmforge/constitution/engineering.prompt`** — names the deterministic toolchain agents are *told* to install on startup: `mutate4go` / `crap4go` / `dry4go` (Go); `clj-mutate` / `crap4clj` / `dry4clj` (Clojure); `mutate4java` / `crap4java` / `dry4java` (Java).
- **`refactorer.prompt`** — most explicit: *"Run the language CRAP tool first and reduce CRAP to 6 or below. Then run the language DRY tool…"* This is the closest the system comes to enforcement, and it is a prose instruction. Nothing checks that the agent ran it.

User invokes: `swarm` (1-line wrapper) or `swarmforge.sh <dir>`. Watches four Terminal windows tile across the screen. Talks to the specifier; specifier prepares Gherkin, hands off to coder, coder writes tests-then-code, refactorer runs CRAP/DRY, architect runs mutation testing.

**Five marketing-vs-reality gaps surfaced by reading source against `SwarmForgeInitSpec.md`:**

1. Spec §4: *"Continuous Validation… Every agent action triggers the full validation pipeline. Any violation halts progress."* — **No such pipeline exists.** `swarmforge.sh` ends with `tmux send-keys "$launch_cmd"`; there is no PreToolUse, no PostToolUse, no `git` hook installed, no commit gate.
2. Spec §4 promises seven roles (Architect, Coder, **TDD Guardian**, E2E Interpreter, **Mutation Hunter**, **Complexity Enforcer**, **Linter Guardian**). The shipped system has four (specifier / coder / refactorer / architect). The three "Guardian / Hunter / Enforcer" roles — the only ones whose names imply enforcement — are not present.
3. Spec §4: *"Pre-Commit / Pre-Merge Hooks. Automatic validation pipeline that blocks any commit violating the Constitution."* — **No hooks installed** by `swarmforge.sh`. `git commit` is unguarded.
4. README: *"agents collaborate without stepping on each other."* — coordination is `tmux send-keys` plus separate worktrees. Two agents writing the *same* file are physically separated by worktree, not by lock; merging is the architect's manual responsibility. Concurrent edits to the same shared resource race exactly as before.
5. `launch_role()` uses `claude --permission-mode acceptEdits`. The orchestrator that markets "unbreakable professional discipline" launches its agents in the permission mode where every confirmation is off.

End-to-end session: `swarm` → tmux sessions and Terminal windows open → user types feature description to specifier → specifier writes Gherkin, asks user to approve → on approval, commits, runs `notify-agent.sh coder "Re-read your role and constitution. specifier handoff name: …"` → coder reads the keystroked message, switches to its worktree, follows TDD, commits, notifies refactorer → refactorer runs `crap4go` and `dry4go`, commits, notifies architect → architect runs `mutate4go`, eventually notifies specifier "job complete." Whether any of those tools actually ran is on the agent's word.

## 3. Deterministic or agentic?

**Deeply hybrid, structurally split:**

- **Orchestration layer (swarm-forge itself):** non-agentic mechanics — tmux, git worktrees, osascript, shell. Discipline layer (which is the entire point of the product) is **fully agentic prose.**
- **Quality-tool sibling repos (crap4go / dry4go / mutate4go / Acceptance-Pipeline-Specification):** fully deterministic single-binary Go CLIs (~600 / 700 / 1500 LOC of stdlib-only Go). These are the real deterministic substrate.

So Uncle Bob has built (a) a deterministic quality toolchain and (b) a prose orchestrator that *asks* agents to invoke it. The deterministic layer exists; it is just not wired to enforcement. The premise of this intake — and the user's framing — is that wiring is exactly what the harness already does for itself.

**License — this is the gate for any borrowing:**

| Repo | LICENSE file | README footer | Borrowable? |
|---|---|---|---|
| `swarm-forge` | **none** | (none) | **No code-borrow.** Read-only reference. Patterns ideas-only. |
| `crap4go` | **none** | "© Robert C. Martin. All rights reserved." | **No code-borrow.** Subprocess-invoke fine. |
| `dry4go` | **none** | "© Robert C. Martin. All rights reserved." | **No code-borrow.** Subprocess-invoke fine. |
| `mutate4go` | **none** | "© Robert C. Martin. All rights reserved." | **No code-borrow.** Subprocess-invoke fine. |
| `Acceptance-Pipeline-Specification` | **none** | (README-only) | Spec is observable behavior; reimplementation likely safe; copying language is not. |

Same trap as `supermodel/sdk` (per `supermodel.md` §3). A public repo with no LICENSE defaults to *all rights reserved* in most jurisdictions — visible ≠ free-to-use. Surface this in any spike that touches the code.

## 4. Substrate vs. surface

- **Surface:** the tmux/worktree orchestrator (swarm-forge), the four named roles, the prose Constitution, the `notify-agent.sh` keystroke-protocol. All are reproducible from the README alone (the patterns are not novel — tmux + worktrees + system-prompt-injected role rules).
- **Substrate:** (a) the deterministic per-language quality tools (crap4go / dry4go / mutate4go), (b) the Constitution-as-layered-prose format with strict precedence (`project > engineering > workflow`), and (c) the four-role separation of concerns (spec → code → refactor → architect/mutate) as a workflow shape independent of how it's enforced.

The substrate is reusable; the surface (tmux + osascript + Mac Terminal automation) is a single-machine MVP that doesn't survive moving off macOS.

## 5. Lane (1–6)

**Multi-lane, by part:**

- **Lane 1 (imperative content) — primary, now.** The four Constitution prompts (`project.prompt`, `engineering.prompt`, `workflow.prompt`, plus the four role prompts) are *already* in the format `/enforce` expects: short, mostly-imperative bullet points. Running `/enforce` against `swarmforge/constitution/engineering.prompt` should distill a sizable rule set. This is the single highest-value, lowest-cost spike.
- **Lane 4 (pattern) — secondary, near-term.** The specifier / coder / refactorer / architect role split is a genuinely useful workflow shape and aligns with the harness's existing `cohort.ts` / `reservations.ts` primitives. Worth a memory entry capturing the role responsibilities (notably: refactorer owns CRAP+DRY, architect owns mutation testing, specifier owns Gherkin — that's a meaningful taste decision worth preserving).
- **Lane 2 (detection technique) — already covered.** crap4go's CRAP formula (`CC² × (1-cov)³ + CC`) is *already implemented* in this repo at `src/harness/checks/crap.ts` (185 LOC), dry4go's Jaccard-over-normalized-AST-nodes at `src/harness/checks/dry.ts` (287 LOC), cyclomatic complexity at `src/harness/checks/cyclomatic.ts` (409 LOC). The harness's versions are language-agnostic; Uncle Bob's are Go-specific with `go test -coverprofile` integration. Worth diff-reading both for parity verification but no new detector to land. Mutation testing is the one genuinely uncovered detection technique — the harness has `mutation-gate.ts` but that's session-state mutation control, not source-code mutation testing.
- **Lane 3 (substrate) — license-blocked.** The CLIs themselves cannot be code-borrowed. Subprocess-invocation is fine and is the *only* path that respects the license. Adds zero deps but raises the question of whether to add a Go-specific quality-tool wrapper at all when the harness's in-house equivalents are language-agnostic.
- **Lane 5 (cloud-only fodder) — strategic.** The user's actual framing — *"have our harness make agents to do that work, and allow our harness to enforce it"* — describes a harness-enforced multi-agent roles system: a coder agent that *cannot* run the refactorer's CRAP commands because the harness denies the tool call, a specifier agent that *cannot* write `.go` files because the reservation system reserves them to coder. This is not a Free CLI feature (no multi-agent orchestration in the local harness); it routes to Guardrails or Agent CI as a role-boundary enforcement product.

## 6. Dependency & displacement

- **Deps:** zero, on every adoption path. Subprocess-invoke (`crap4go @latest`, `mutate4go @latest`) adds no runtime dep — same posture as `quality-checks.ts`'s existing wrappers around `tsc` / `biome` / `cargo` / `mypy`. The Constitution-as-prompt content is text. The role pattern is a memory entry. License-blocked code-borrow forecloses the only path that would have added deps.
- **Displacement:** **direct overlap with existing in-house checks.**
  - `src/harness/checks/crap.ts` (185 LOC, in-house CRAP) ↔ `crap4go` (Go-specific, integrates `go test -coverprofile`).
  - `src/harness/checks/dry.ts` (287 LOC, in-house DRY) ↔ `dry4go` (Go-specific, Jaccard over AST fingerprints — algorithmically close to ours).
  - `src/harness/checks/cyclomatic.ts` (409 LOC) ↔ counted-as-component-of `crap4go`.
  - `src/harness/cohort.ts` / `reservations.ts` (multi-agent coordination via reservations and ownership) ↔ swarm-forge's role split + worktree separation. **Different shape** (we use a daemon + Unix socket + atomic reservation; they use separate worktrees + tmux keystrokes), but adjacent problem.
  - No overlap with **mutation testing of source code** — that's a clean net-new direction if it's worth pursuing for Go specifically (the harness has `mutation-gate.ts` but it's about session-state mutation discipline, unrelated).

## 7. Smallest spike (≤1 day)

Two cheap spikes, both ≤1 day, pick one:

**Spike A — `/enforce` the Constitution.** Run `/enforce reference-repos/swarm-forge/swarmforge/constitution/engineering.prompt` and `/enforce reference-repos/swarm-forge/swarmforge/refactorer.prompt`. Read what distills. This is a single-command test of the central thesis ("the harness can enforce what swarm-forge merely prompts"). Output is committed to `.interlinked/distilled-rules.json` and either lights up immediately or shows the distillation gaps. Smallest possible bet on the highest-value lane (1).

**Spike B — diff CRAP implementations.** Run our `crap.ts` against this repo's `.go` files (it has none — pick a Go project from `reference-repos/`). Then run `crap4go` against the same files. Compare per-function scores. If our CRAP is within 5% of Uncle Bob's on the same code, we don't need to subprocess-invoke; if there's a meaningful gap, we know what to fix in `crap.ts`. Same shape works for `dry4go ↔ dry.ts`.

Both spikes are read-only against the cloned tree and produce permanent evidence.

## 8. Phase relevance

| Surface (phase) | Slice that lands here | Spike | Horizon |
|-----------------|-----------------------|-------|---------|
| Free CLI (P1) | (a) `/enforce` on the four Constitution prompts → distilled rules; (b) memory note for the four-role pattern as a workflow shape; (c) optional Go-specific subprocess wrappers around crap4go/mutate4go in `quality-checks.ts` if the diff in Spike B shows a real gap | §7 Spike A (1 hr); §7 Spike B (3–4 hr) | **now** |
| Guardrails (P2–3) | LLM-classifier enforcement of role-boundary policies ("you are the refactorer, you must not introduce new behavior" — semantic, not regex). Connects to Tier 2 policy gate. | name a candidate policy in `.interlinked/policies/` | next |
| Agent CI (P4–5) | The full marriage: harness-enforced multi-agent roles. Specifier/coder/refactorer/architect as cohort members with deterministic role-scoped permissions (file globs, tool allowlists), reservation-locked file ownership, harness-mediated handoffs replacing `tmux send-keys`. Multi-agent shape `swarm-forge` *promises* with enforcement it *omits*. | RFC | parked-but-strategic |

## 9. Artifact

Three artifacts, one per surface row:

- **PR — `/enforce` distillation of swarm-forge constitution prompts.** Smallest spike; commits whatever `.interlinked/distilled-rules.json` produces; lets us see in one PR exactly which Constitution rules our harness can already enforce vs. which need new detectors. (Spike A.)
- **Memory note — `reference_uncle_bob_quality_portfolio.md`.** Captures: (1) the role-split as a workflow pattern, (2) the crap4go/dry4go/mutate4go portfolio as deterministic Go-specific tools with all-rights-reserved licensing (subprocess only), (3) the marketing-vs-reality gap between the SwarmForgeInitSpec and the shipped code.
- **Cloud-roadmap entry — Agent CI: harness-enforced multi-agent roles.** Two-paragraph entry referencing this intake; positions it as the productized version of swarm-forge's premise, with enforcement provided by the harness's existing reservation / cohort / policy primitives extended to role-boundary scoping. RFC when there's a concrete pilot project.

## Notes

The user's framing — *"instead of having multiple agents do all that work, we could have our harness make agents to do that work, and allow our harness to enforce it"* — is the right read. swarm-forge's deepest weakness is the gap between its quality-tool portfolio (deterministic, runnable, opinionated) and its orchestration layer (prose-only, auto-accept-edits, no commit gate). The harness is on the opposite side of that exact gap — heavy on enforcement, lighter on opinionated workflow shape. There's a real complementarity, but the right artifact is *not* importing swarm-forge; it's borrowing the role-split pattern (Lane 4), the Constitution distills (Lane 1), and — much later — letting the harness host that role topology with enforcement that's *not* prose (Lane 5).

The 23 quality-tool peer repos (crap4java/clj/dry4java/clj/mutate4java + Acceptance-Pipeline-Specification) form a coherent "professional craftsmanship" portfolio. They reinforce the central observation: the *substrate* is real and deterministic; the *enforcement layer* is wishful prose. Uncle Bob has the means; swarm-forge does not have the gates.

One small adoption today regardless of any spike: the **layered Constitution precedence** convention (project > engineering > workflow, earlier-wins-on-conflict) is a clean, copy-the-idea improvement to how the harness organizes its own distilled rule sets — worth noting against the `/enforce` skill.

Related memories to update on next pass: `project_three_tier_policy_enforcement.md` (the Tier-1 distillation use case grows by one concrete corpus), `reference_failproofai_competitor.md` (failproofai and swarm-forge occupy adjacent niches — both gate AI-agent code with rules; failproofai gates determinism-first, swarm-forge gates prose-only; this repo's harness is on the failproofai axis).

## Methodology notes

The `claude --permission-mode acceptEdits` line in `launch_role()` is the load-bearing source citation for this intake — it converts "swarm-forge claims to enforce discipline" into "swarm-forge's launcher line proves it does not." Read the source, not the README (per INTAKE §3). The five marketing-vs-reality gaps in §2 all surface from the same discipline: take each spec promise, search the source for the mechanism, note when nothing matches. Same pattern as `codewiki.md`'s `cluster_modules.py` reveal.

The license check (§3 table) earns its row: a sibling tool with "© All rights reserved" footer and no LICENSE file looks borrowable in a casual read of the README. It is not. Apply the same scan to every `unclebob/*` repo before touching its code.
